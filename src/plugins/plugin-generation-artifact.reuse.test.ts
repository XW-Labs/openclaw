import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireSqliteStagingToken } from "../infra/sqlite-staging-token.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import {
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { prunePluginNativeCaptureDirectories } from "./plugin-source-capture-directory.js";
import { sweepPluginSourceCapturesForTest } from "./plugin-source-capture-directory.test-support.js";
import { resetPluginCaptureReuseVariantsForTest } from "./plugin-source-capture-reuse.js";
import * as sourceFile from "./plugin-source-file.js";

vi.mock("./plugin-source-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-source-file.js")>()),
}));

type Artifact = ReturnType<typeof capturePluginGenerationArtifact>;

const temp = useAutoCleanupTempDirTracker(afterEach);
const live = new Set<Artifact>();
let stateDir: string;

beforeEach(() => {
  const runtimeTemp = temp.make("plugin-capture-reuse-runtime-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, runtimeTemp);
  }
  stateDir = fs.realpathSync(temp.make("plugin-capture-reuse-state-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_REUSE", "1");
  resetPluginCaptureReuseVariantsForTest();
});

afterEach(() => {
  for (const artifact of live) {
    artifact.dispose();
  }
  live.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPluginCaptureReuseVariantsForTest();
});

const reuseRoot = () => path.join(stateDir, "tmp", "plugin-captures", "reuse");

function createSource(): string {
  const source = fs.realpathSync(temp.make("plugin-capture-reuse-source-"));
  fs.mkdirSync(path.join(source, "lib"));
  fs.writeFileSync(
    path.join(source, "package.json"),
    // Declared dependencies are linked by the initial walk; import-map packages on demand.
    JSON.stringify({
      name: "fixture",
      dependencies: { dep: "1.0.0" },
      imports: { "#lazy": "lazy" },
    }),
  );
  fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = require('./lib/util.cjs');");
  fs.writeFileSync(path.join(source, "lib", "util.cjs"), "module.exports = 'captured';");
  for (const name of ["dep", "lazy"]) {
    const dependency = path.join(source, "node_modules", name);
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, "package.json"), `{"name":"${name}","main":"index.js"}`);
    fs.writeFileSync(path.join(dependency, "index.js"), `module.exports = '${name}';`);
  }
  return source;
}

function capture(source: string): Artifact {
  const artifact = capturePluginGenerationArtifact(
    source,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { reuse: true },
  );
  live.add(artifact);
  return artifact;
}

function dispose(artifact: Artifact): void {
  live.delete(artifact);
  artifact.dispose();
}

/** A later process: earlier leases are released and this process has used no variant. */
function restart(...artifacts: Artifact[]): void {
  artifacts.forEach(dispose);
  resetPluginCaptureReuseVariantsForTest();
}

/** Capture timestamps well after the fixture writes, so no entry is racily clean. */
function later(): void {
  const now = Date.now() + 10_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
}

function countWork() {
  return {
    copies: vi.spyOn(sourceFile, "copyPluginSourceFile"),
    hashes: vi.spyOn(sourceFile, "hashPluginSourceFile"),
  };
}

function countPinnedHashes() {
  const open = vi.spyOn(fs, "openSync");
  return () =>
    open.mock.calls.filter(
      ([, flags]) => typeof flags === "number" && (flags & fs.constants.O_NOFOLLOW) !== 0,
    ).length;
}

function walk(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((relative) => path.join(root, relative));
}

const manifestOf = (artifact: Artifact) =>
  path.join(path.dirname(artifact.boundaryRoot), "manifest.json");

it.skipIf(process.platform === "win32")(
  "adopts an unchanged capture at the same path without copying or hashing",
  () => {
    const source = createSource();
    later();
    const first = capture(source);
    expect(first.boundaryRoot.startsWith(reuseRoot() + path.sep)).toBe(true);
    expect(path.basename(first.boundaryRoot)).toBe("openclaw-plugin-build-content");
    expect(fs.existsSync(manifestOf(first))).toBe(true);
    restart(first);
    const work = countWork();
    const second = capture(source);
    expect(second.boundaryRoot).toBe(first.boundaryRoot);
    expect(second.sourceDigest).toBe(first.sourceDigest);
    expect(work.copies).not.toHaveBeenCalled();
    expect(work.hashes).not.toHaveBeenCalled();
    const util = second.resolve(path.join(source, "lib", "util.cjs"));
    expect(fs.readFileSync(util, "utf8")).toBe("module.exports = 'captured';");
    expect(second.assertSourceCurrent).not.toThrow();
    // Later verification hashes sources as a fresh capture would.
    expect(work.hashes).toHaveBeenCalled();
    fs.appendFileSync(path.join(source, "lib", "util.cjs"), "\n");
    expect(second.assertSourceCurrent).toThrow();
  },
);

it.skipIf(process.platform === "win32").each(["content", "ctime only"])(
  "recaptures after a source edit: %s",
  (change) => {
    const source = createSource();
    later();
    const first = capture(source);
    const content = fs.statSync(first.boundaryRoot).ino;
    restart(first);
    const util = path.join(source, "lib", "util.cjs");
    const before = fs.statSync(util);
    fs.writeFileSync(
      util,
      change === "content" ? "module.exports = 'edited!!';" : "module.exports = 'captured';",
    );
    // Restoring mtime leaves only the kernel-owned ctime as evidence of the write.
    fs.utimesSync(util, before.atime, before.mtime);
    const work = countWork();
    const second = capture(source);
    expect(second.boundaryRoot).toBe(first.boundaryRoot);
    expect(fs.statSync(second.boundaryRoot).ino).not.toBe(content);
    expect(work.copies).toHaveBeenCalled();
    expect(fs.readFileSync(second.resolve(util), "utf8")).toBe(fs.readFileSync(util, "utf8"));
    expect(second.sourceDigest === first.sourceDigest).toBe(change !== "content");
  },
);

it.skipIf(process.platform === "win32").each(["modified file", "hardlink", "symlink retarget"])(
  "recaptures when the stable capture changed: %s",
  (change) => {
    const source = createSource();
    later();
    const first = capture(source);
    const util = first.resolve(path.join(source, "lib", "util.cjs"));
    const link = walk(first.boundaryRoot).find((entry) => fs.lstatSync(entry).isSymbolicLink());
    restart(first);
    if (change === "modified file") {
      fs.appendFileSync(util, "\n// injected");
    } else if (change === "hardlink") {
      fs.linkSync(util, path.join(stateDir, "alias.cjs"));
    } else {
      expect(link).toBeDefined();
      fs.unlinkSync(link!);
      fs.symlinkSync(path.join(source, "lib"), link!);
    }
    const work = countWork();
    const second = capture(source);
    expect(second.boundaryRoot).toBe(first.boundaryRoot);
    expect(work.copies).toHaveBeenCalled();
    const recaptured = second.resolve(path.join(source, "lib", "util.cjs"));
    expect(fs.readFileSync(recaptured, "utf8")).toBe("module.exports = 'captured';");
    expect(fs.statSync(recaptured).nlink).toBe(1);
    expect(second.sourceDigest).toBe(first.sourceDigest);
  },
);

it.skipIf(process.platform === "win32")("recaptures when the source gains a file", () => {
  const source = createSource();
  later();
  const first = capture(source);
  restart(first);
  fs.writeFileSync(path.join(source, "lib", "extra.cjs"), "module.exports = 'extra';");
  const work = countWork();
  const second = capture(source);
  expect(work.copies).toHaveBeenCalled();
  expect(fs.existsSync(second.resolve(path.join(source, "lib", "extra.cjs")))).toBe(true);
  expect(second.sourceDigest).not.toBe(first.sourceDigest);
});

it.skipIf(process.platform === "win32")(
  "removes unrecorded capture entries before adopting",
  () => {
    const source = createSource();
    later();
    const first = capture(source);
    restart(first);
    const extras = [
      path.join(first.boundaryRoot, "node_modules", "openclaw"),
      path.join(path.dirname(first.resolve(path.join(source, "index.cjs"))), "planted.cjs"),
    ];
    fs.mkdirSync(path.dirname(extras[0]!), { recursive: true });
    fs.symlinkSync(stateDir, extras[0]!);
    fs.writeFileSync(extras[1]!, "module.exports = 'planted';");
    const work = countWork();
    const second = capture(source);
    expect(second.boundaryRoot).toBe(first.boundaryRoot);
    expect(work.copies).not.toHaveBeenCalled();
    for (const extra of extras) {
      expect(fs.existsSync(extra)).toBe(false);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "rehashes racily clean entries once and records the later snapshot time",
  () => {
    const source = createSource();
    const first = capture(source);
    const recorded = JSON.parse(fs.readFileSync(manifestOf(first), "utf8")).recordedAtNs;
    restart(first);
    later();
    let pinned = countPinnedHashes();
    const work = countWork();
    const second = capture(source);
    expect(second.boundaryRoot).toBe(first.boundaryRoot);
    expect(work.copies).not.toHaveBeenCalled();
    expect(pinned()).toBeGreaterThan(0);
    const rewritten = JSON.parse(fs.readFileSync(manifestOf(second), "utf8")).recordedAtNs;
    expect(BigInt(rewritten)).toBeGreaterThan(BigInt(recorded));
    restart(second);
    vi.mocked(fs.openSync).mockRestore();
    pinned = countPinnedHashes();
    const third = capture(source);
    expect(third.boundaryRoot).toBe(first.boundaryRoot);
    expect(pinned()).toBe(0);
    expect(JSON.parse(fs.readFileSync(manifestOf(third), "utf8")).recordedAtNs).toBe(rewritten);
  },
);

it.skipIf(process.platform === "win32")(
  "gives live artifacts in one process distinct directories",
  () => {
    const source = createSource();
    const first = capture(source);
    const second = capture(source);
    expect(second.boundaryRoot).not.toBe(first.boundaryRoot);
    dispose(first);
    // ESM module records outlive disposal, so this process never reuses either path.
    const third = capture(source);
    expect([first.boundaryRoot, second.boundaryRoot]).not.toContain(third.boundaryRoot);
  },
);

it.skipIf(process.platform === "win32")(
  "uses the next variant while another process holds the lease",
  () => {
    const source = createSource();
    const first = capture(source);
    const variant = path.dirname(first.boundaryRoot);
    restart(first);
    const lease = acquireSqliteStagingToken(variant, "create");
    try {
      const second = capture(source);
      expect(path.dirname(path.dirname(second.boundaryRoot))).toBe(path.dirname(variant));
      expect(second.boundaryRoot).not.toBe(first.boundaryRoot);
    } finally {
      lease();
    }
  },
);

const recordsNative = (artifact: Artifact) =>
  Object.keys(JSON.parse(fs.readFileSync(manifestOf(artifact), "utf8")).captured).some((entry) =>
    entry.endsWith("addon.node"),
  );

it.skipIf(process.platform === "win32")(
  "adopts the ordinary files around native artifacts and admits the native bytes again",
  async () => {
    const source = createSource();
    // Like Feishu's fs-safe binaries: the addon lives in a dependency package, so native
    // admission takes that package and the plugin's own files stay in the reused tree.
    const addon = path.join(source, "node_modules", "dep", "addon.node");
    fs.writeFileSync(addon, "native fixture");
    const caches = [createPluginCache(), createPluginCache()];
    try {
      later();
      const first = withPluginCache(caches[0]!, () => capture(source));
      expect(first.boundaryRoot.startsWith(reuseRoot() + path.sep)).toBe(true);
      expect(fs.readFileSync(first.resolve(addon), "utf8")).toBe("native fixture");
      expect(recordsNative(first)).toBe(false);
      const index = fs.statSync(path.join(first.boundaryRoot, "index.cjs")).ino;
      const digest = first.sourceDigest;
      restart(first);
      const work = countWork();
      // A later process has its own native admission state and admits the addon again.
      const second = withPluginCache(caches[1]!, () => capture(source));
      expect(second.boundaryRoot).toBe(first.boundaryRoot);
      expect(second.sourceDigest).toBe(digest);
      expect(fs.statSync(path.join(second.boundaryRoot, "index.cjs")).ino).toBe(index);
      const contentCopies = work.copies.mock.calls.filter(([, , target]) =>
        String(target).startsWith(second.boundaryRoot + path.sep),
      );
      expect(contentCopies).toEqual([]);
      expect(fs.readFileSync(second.resolve(addon), "utf8")).toBe("native fixture");
      expect(recordsNative(second)).toBe(false);
      restart(second);
    } finally {
      for (const cache of caches) {
        await retirePluginCache(cache);
      }
    }
  },
);

it.skipIf(process.platform === "win32")(
  "recaptures when a native artifact changed between starts",
  async () => {
    const source = createSource();
    fs.writeFileSync(path.join(source, "addon.node"), "native fixture");
    const caches = [createPluginCache(), createPluginCache()];
    try {
      later();
      const first = withPluginCache(caches[0]!, () => capture(source));
      const content = fs.statSync(first.boundaryRoot).ino;
      const digest = first.sourceDigest;
      restart(first);
      fs.writeFileSync(path.join(source, "addon.node"), "native fixture, rebuilt");
      later();
      const second = withPluginCache(caches[1]!, () => capture(source));
      expect(second.boundaryRoot).toBe(first.boundaryRoot);
      // The adoption's receipt did not hit, so the content directory was recycled.
      expect(fs.statSync(second.boundaryRoot).ino).not.toBe(content);
      expect(second.sourceDigest).not.toBe(digest);
      expect(fs.readFileSync(second.resolve(path.join(source, "addon.node")), "utf8")).toBe(
        "native fixture, rebuilt",
      );
      expect(fs.existsSync(manifestOf(second))).toBe(true);
      restart(second);
    } finally {
      for (const cache of caches) {
        await retirePluginCache(cache);
      }
    }
  },
);

it.skipIf(process.platform === "win32")(
  "adopts a managed native plugin whose admission the installed index carries to the next start",
  async () => {
    await withOpenClawTestState({ label: "native-capture-reuse" }, async (state) => {
      vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_REUSE", "1");
      const fixture = createFixture(state.path("installed"), true);
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      later();
      const first = createPluginCache();
      let boundaryRoot: string;
      let digest: string;
      try {
        preparePluginNativeAdmissions(fixture.index, first);
        const artifact = withPluginCache(first, () => capture(fixture.root));
        boundaryRoot = artifact.boundaryRoot;
        digest = artifact.sourceDigest;
        expect(boundaryRoot.split(path.sep)).toContain("reuse");
        expect(fs.existsSync(manifestOf(artifact))).toBe(true);
        await settlePluginNativeAdmissions(first);
        restart(artifact);
      } finally {
        await retirePluginCache(first);
      }
      await using reader = createPluginCache();
      const persisted = await withPluginCache(reader, () =>
        readPersistedInstalledPluginIndex({ stateDir: state.stateDir }),
      );
      expect(Object.keys(persisted!.plugins[0]!.sourceAdmissions ?? {})).toHaveLength(1);
      const second = createPluginCache();
      try {
        // The next start seeds the published native receipt, as the Gateway does from its index.
        preparePluginNativeAdmissions(persisted!, second);
        const work = countWork();
        const artifact = withPluginCache(second, () => capture(fixture.root));
        expect(artifact.boundaryRoot).toBe(boundaryRoot);
        expect(artifact.sourceDigest).toBe(digest);
        expect(
          work.copies.mock.calls.filter(([, , target]) =>
            String(target).startsWith(boundaryRoot + path.sep),
          ),
        ).toEqual([]);
        expect(fs.readFileSync(artifact.resolve(fixture.filename)).equals(fixture.bytes)).toBe(
          true,
        );
        restart(artifact);
      } finally {
        await retirePluginCache(second);
      }
    });
  },
);

it.skipIf(process.platform === "win32")(
  "captures on demand after adoption and drops those captures on the next start",
  () => {
    const source = createSource();
    const lazy = fs.realpathSync(path.join(source, "node_modules", "lazy"));
    const demand = (artifact: Artifact) => {
      artifact.prepareNativeScopes();
      const target = path.join(artifact.sourceAliases[lazy]!, "package.json");
      expect(JSON.parse(fs.readFileSync(target, "utf8")).name).toBe("lazy");
      return target;
    };
    later();
    const first = capture(source);
    expect(first.sourceAliases[lazy]).toBeUndefined();
    const target = demand(first);
    restart(first);
    const work = countWork();
    const second = capture(source);
    expect(second.boundaryRoot).toBe(first.boundaryRoot);
    expect(work.copies).not.toHaveBeenCalled();
    expect(fs.existsSync(target)).toBe(false);
    demand(second);
    expect(work.copies).toHaveBeenCalled();
    restart(second);
    const third = capture(source);
    expect(third.boundaryRoot).toBe(first.boundaryRoot);
    expect(fs.existsSync(target)).toBe(false);
  },
);

it("keeps per-instance captures without the reuse gate", () => {
  const source = createSource();
  const reused = capture(source);
  vi.stubEnv("OPENCLAW_PLUGIN_CAPTURE_REUSE", "");
  const work = countWork();
  const fresh = capture(source);
  expect(fresh.boundaryRoot.startsWith(reuseRoot())).toBe(false);
  expect(path.basename(fresh.boundaryRoot).startsWith("openclaw-plugin-build-")).toBe(true);
  expect(work.copies).toHaveBeenCalled();
  expect(fresh.sourceDigest).toBe(reused.sourceDigest);
  const plain = capturePluginGenerationArtifact(source);
  live.add(plain);
  expect(plain.boundaryRoot.startsWith(reuseRoot())).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "survives the hourly sweep; startup maintenance reclaims trash and orphaned variants",
  async () => {
    const kept = createSource();
    const orphan = createSource();
    const leased = createSource();
    const artifacts = [kept, orphan, leased].map(capture);
    const variants = artifacts.map((artifact) => path.dirname(artifact.boundaryRoot));
    restart(...artifacts);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    for (const entry of [reuseRoot(), ...walk(reuseRoot())]) {
      fs.lutimesSync(entry, old, old);
    }
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(variants.every((variant) => fs.existsSync(variant))).toBe(true);

    const trash = path.join(path.dirname(variants[0]!), "trash-fixture");
    fs.mkdirSync(path.join(trash, "nested"), { recursive: true });
    fs.rmSync(orphan, { recursive: true, force: true });
    fs.rmSync(leased, { recursive: true, force: true });
    const lease = acquireSqliteStagingToken(variants[2]!, "create");
    try {
      const result = await prunePluginNativeCaptureDirectories(stateDir, new Set(), () => {}, {
        startup: true,
      });
      expect(result.warnings).toEqual([]);
    } finally {
      lease();
    }
    expect(fs.existsSync(trash)).toBe(false);
    expect(fs.existsSync(variants[0]!)).toBe(true);
    expect(fs.existsSync(variants[1]!)).toBe(false);
    expect(fs.existsSync(variants[2]!)).toBe(true);
    await prunePluginNativeCaptureDirectories(stateDir, new Set(), () => {}, { startup: true });
    expect(fs.existsSync(variants[2]!)).toBe(false);
    expect(fs.existsSync(path.dirname(variants[2]!))).toBe(false);
  },
);
