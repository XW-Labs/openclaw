import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
  type SqliteStagingToken,
} from "../infra/sqlite-staging-token.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { VERSION } from "../version.js";
import { resolvePluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  PLUGIN_CAPTURE_REUSE_DIRECTORY,
  PLUGIN_SOURCE_CAPTURE_PREFIX,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";
import { pluginSourceStatIdentity } from "./plugin-source-file.js";
import type { PluginSourceInput } from "./plugin-source-verification.js";

const FORMAT = 1;
const VARIANTS = 4;
// Like Git's racily clean index entries: a timestamp this close to the recorded
// snapshot cannot prove that a later same-tick write did not change the bytes.
const RACY_NS = 2_000_000_000n;
const UNUSED_MS = 7 * 24 * 60 * 60 * 1_000;
// Native source loaders and the process census recognize captures by this prefix.
const CONTENT = `${PLUGIN_SOURCE_CAPTURE_PREFIX}content`;
const MANIFEST = "manifest.json";

type CapturedEntry =
  | { kind: "file"; identity: string; contentHash: string }
  | { kind: "directory" }
  | { kind: "link"; target: string };

type PluginCaptureManifest = {
  format: typeof FORMAT;
  slot: string;
  sourceRoot: string;
  contentIdentity: string;
  recordedAtNs: string;
  capturedAtNs: string;
  receipt: { signature: string; sourceDigest: string };
  sources: Record<string, PluginSourceInput>;
  captured: Record<string, CapturedEntry>;
};

// Native ESM module records cannot be revoked, so one path backs at most one artifact per process.
const usedVariants = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginCaptureReuseVariants"),
  () => new Set<string>(),
);

export function resetPluginCaptureReuseVariantsForTest(): void {
  usedVariants.clear();
}

class PluginCaptureReuseMiss extends Error {
  constructor(detail: string) {
    super(`Plugin capture reuse missed: ${detail}`);
  }
}

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const changedNs = (stat: fs.BigIntStats) =>
  stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
const ownedByUs = (stat: fs.BigIntStats | fs.Stats) =>
  !process.getuid || Number(stat.uid) === process.getuid();

function assertPrivateDirectory(directory: string): fs.BigIntStats {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    !ownedByUs(stat) ||
    (stat.mode & 0o077n) !== 0n ||
    fs.realpathSync(directory) !== directory
  ) {
    throw new Error(`Plugin capture reuse directory is not private: ${directory}`);
  }
  return stat;
}

function ensurePrivateDirectory(directory: string): fs.BigIntStats {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  }
  return assertPrivateDirectory(directory);
}

/** Hash one file through a descriptor bound to the identity the caller already trusts. */
function hashPinnedFile(filename: string, identity: string): string {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || pluginSourceStatIdentity(stat) !== identity) {
      throw new PluginCaptureReuseMiss(`changed ${filename}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (length === 0) {
        break;
      }
      hash.update(buffer.subarray(0, length));
      position += length;
    }
    if (BigInt(position) !== stat.size) {
      throw new PluginCaptureReuseMiss(`changed ${filename}`);
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

/** Visit a private tree without following links; `visit` returns false to skip a subtree. */
function walkTree(
  root: string,
  visit: (relative: string, absolute: string, stat: fs.BigIntStats) => boolean,
  relative = "",
): void {
  for (const name of fs.readdirSync(path.join(root, relative)).toSorted()) {
    const child = relative ? path.join(relative, name) : name;
    const absolute = path.join(root, child);
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (visit(child, absolute, stat) && stat.isDirectory()) {
      walkTree(root, visit, child);
    }
  }
}

const capturedEntry = (manifest: PluginCaptureManifest, relative: string) =>
  Object.hasOwn(manifest.captured, relative) ? manifest.captured[relative] : undefined;
const sourceInput = (manifest: PluginCaptureManifest, source: string) =>
  Object.hasOwn(manifest.sources, source) ? manifest.sources[source] : undefined;

function readManifest(filename: string, slot: string, sourceRoot: string) {
  const stat = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile() || stat.nlink !== 1n || !ownedByUs(stat) || (stat.mode & 0o077n) !== 0n) {
    return undefined;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8")) as PluginCaptureManifest;
    return manifest.format === FORMAT &&
      manifest.slot === slot &&
      manifest.sourceRoot === sourceRoot &&
      typeof manifest.receipt?.signature === "string" &&
      typeof manifest.receipt.sourceDigest === "string"
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
}

function writeManifest(filename: string, manifest: PluginCaptureManifest): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Read-only validation of a previous capture: every recorded entry must keep its exact
 * lstat identity, racy entries are rehashed, and unrecorded lazy captures are removed.
 * Returns whether racy entries were rehashed, so the caller can refresh their timestamps.
 */
function inspectCapture(content: string, manifest: PluginCaptureManifest): boolean {
  const directory = assertPrivateDirectory(content);
  if (`${directory.dev}:${directory.ino}` !== manifest.contentIdentity) {
    throw new PluginCaptureReuseMiss("content directory was replaced");
  }
  const capturedAt = BigInt(manifest.capturedAtNs) - RACY_NS;
  const recordedAt = BigInt(manifest.recordedAtNs) - RACY_NS;
  let racy = false;
  const seen = new Set<string>();
  walkTree(content, (relative, absolute, stat) => {
    const entry = capturedEntry(manifest, relative);
    if (!entry) {
      // Lazy captures and the host link are recreated on demand by this generation.
      fs.rmSync(absolute, { recursive: true, force: true });
      return false;
    }
    seen.add(relative);
    if (entry.kind === "directory") {
      if (!stat.isDirectory()) {
        throw new PluginCaptureReuseMiss(`changed ${relative}`);
      }
    } else if (entry.kind === "link") {
      if (!stat.isSymbolicLink() || fs.readlinkSync(absolute) !== entry.target) {
        throw new PluginCaptureReuseMiss(`changed ${relative}`);
      }
    } else if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      pluginSourceStatIdentity(stat) !== entry.identity
    ) {
      throw new PluginCaptureReuseMiss(`changed ${relative}`);
    } else if (changedNs(stat) >= capturedAt) {
      if (hashPinnedFile(absolute, entry.identity) !== entry.contentHash) {
        throw new PluginCaptureReuseMiss(`changed ${relative}`);
      }
      racy = true;
    }
    return true;
  });
  if (seen.size !== Object.keys(manifest.captured).length) {
    throw new PluginCaptureReuseMiss("captured entries are missing");
  }
  for (const [source, input] of Object.entries(manifest.sources)) {
    if (input.directory || input.native) {
      continue;
    }
    const stat = fs.lstatSync(source, { bigint: true, throwIfNoEntry: false });
    if (!stat?.isFile() || pluginSourceStatIdentity(stat) !== input.identity) {
      throw new PluginCaptureReuseMiss(`changed ${source}`);
    }
    if (changedNs(stat) >= recordedAt) {
      if (hashPinnedFile(source, input.identity) !== input.contentHash) {
        throw new PluginCaptureReuseMiss(`changed ${source}`);
      }
      racy = true;
    }
  }
  return racy;
}

/** A leased stable capture directory and, when its manifest still holds, its adoption. */
export type PluginCaptureReuse = NonNullable<ReturnType<typeof acquirePluginCaptureReuse>>;
export type PluginCaptureAdoption = NonNullable<PluginCaptureReuse["adoption"]>;

/** Off by default; Windows lacks the private-mode and lstat identity checks reuse relies on. */
export function isPluginCaptureReuseEnabled(): boolean {
  return process.env.OPENCLAW_PLUGIN_CAPTURE_REUSE === "1" && process.platform !== "win32";
}

/**
 * Lease a stable capture directory for one external plugin, or return undefined to keep
 * the per-instance random capture. Callers check the remaining eligibility facts.
 */
export function acquirePluginCaptureReuse(params: { rootDir: string; executes: boolean }) {
  if (!isPluginCaptureReuseEnabled()) {
    return undefined;
  }
  const storage = resolvePluginSourceCaptureStorage();
  if (storage.placement !== "state") {
    return undefined;
  }
  let sourceRoot: string;
  let outputRoot: string;
  let slot: string;
  let slotKey: string;
  try {
    sourceRoot = fs.realpathSync(params.rootDir);
    slotKey = createHash("sha256")
      .update(
        JSON.stringify([
          FORMAT,
          VERSION,
          process.platform,
          process.arch,
          sourceRoot,
          "",
          params.executes,
        ]),
      )
      .digest("hex");
    const parent = resolvePluginSourceCapturesDirectory(storage.stateDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    outputRoot = fs.realpathSync(parent);
    const reuseRoot = path.join(outputRoot, PLUGIN_CAPTURE_REUSE_DIRECTORY);
    ensurePrivateDirectory(reuseRoot);
    slot = path.join(reuseRoot, slotKey.slice(0, 32));
    ensurePrivateDirectory(slot);
  } catch {
    return undefined;
  }
  let variant: string | undefined;
  let token: SqliteStagingToken | undefined;
  for (let index = 0; index < VARIANTS && !token; index += 1) {
    variant = path.join(slot, String(index));
    if (usedVariants.has(variant)) {
      continue;
    }
    try {
      ensurePrivateDirectory(variant);
      // A live owner in another process holds this write lock until it releases the lease.
      token = acquireSqliteStagingToken(variant, "create");
    } catch {
      token = undefined;
    }
  }
  if (!token || !variant) {
    return undefined;
  }
  const variantDirectory = variant;
  const lease = token;
  usedVariants.add(variantDirectory);
  const content = path.join(variantDirectory, CONTENT);
  const manifestPath = path.join(variantDirectory, MANIFEST);
  const startedAtNs = nowNs();
  const previous = readManifest(manifestPath, slotKey, sourceRoot);
  let racy = false;
  const inspect = (candidate: PluginCaptureManifest) => {
    try {
      racy = inspectCapture(content, candidate);
      return candidate;
    } catch {
      return undefined;
    }
  };
  const manifest = previous && inspect(previous);
  let released = false;
  const adopted = new Set<string>();
  const adoption = manifest && {
    manifest,
    /** Cleared after the initial walk; later demand captures copy as usual. */
    active: true,
    /** Sources whose recorded content hash this adoption accepted by identity. */
    adopted,
    miss(detail: string): never {
      throw new PluginCaptureReuseMiss(detail);
    },
    file(real: string, identity: string, target: string) {
      const input = sourceInput(manifest, real);
      const entry = capturedEntry(manifest, path.relative(content, target));
      if (
        !input ||
        input.directory ||
        input.identity !== identity ||
        entry?.kind !== "file" ||
        entry.contentHash !== input.contentHash
      ) {
        throw new PluginCaptureReuseMiss(`changed ${real}`);
      }
      adopted.add(real);
      return { contentHash: input.contentHash, sizeBytes: input.sizeBytes };
    },
    directory(real: string, identity: string, contentHash: string, target: string) {
      const input = sourceInput(manifest, real);
      if (
        !input?.directory ||
        input.identity !== identity ||
        input.contentHash !== contentHash ||
        capturedEntry(manifest, path.relative(content, target))?.kind !== "directory"
      ) {
        throw new PluginCaptureReuseMiss(`changed ${real}`);
      }
    },
    link(link: string, target: string) {
      const stat = fs.lstatSync(link, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() ? fs.readlinkSync(link) !== target : !stat) {
        throw new PluginCaptureReuseMiss(`changed ${link}`);
      }
    },
  };
  return {
    directory: content,
    outputRoot,
    adoption,
    /** Discard previous bytes before an exact recapture; adoption checks never write. */
    recycle() {
      fs.rmSync(manifestPath, { force: true });
      if (fs.lstatSync(content, { throwIfNoEntry: false })) {
        const trash = path.join(slot, `trash-${randomUUID()}`);
        fs.renameSync(content, trash);
        void fsPromises.rm(trash, { recursive: true, force: true }).catch((error: unknown) => {
          process.emitWarning(`Plugin capture reuse cleanup: ${String(error)}`);
        });
      }
      ensurePrivateDirectory(content);
    },
    /** Record a fresh capture before host links or lazy captures extend it. */
    commit(params: {
      recordedAtNs: bigint;
      capturedAtNs: bigint;
      receipt: { signature: string; sourceDigest: string };
      sources: ReadonlyMap<string, PluginSourceInput>;
      contentHashes: ReadonlyMap<string, string>;
    }) {
      const captured: Record<string, CapturedEntry> = {};
      let complete = true;
      walkTree(content, (relative, absolute, stat) => {
        if (stat.isDirectory()) {
          captured[relative] = { kind: "directory" };
        } else if (stat.isSymbolicLink()) {
          captured[relative] = { kind: "link", target: fs.readlinkSync(absolute) };
        } else {
          const contentHash = params.contentHashes.get(absolute);
          complete &&= stat.isFile() && stat.nlink === 1n && contentHash !== undefined;
          captured[relative] = {
            kind: "file",
            identity: pluginSourceStatIdentity(stat),
            contentHash: contentHash ?? "",
          };
        }
        return true;
      });
      if (!complete || [...params.sources.values()].some((input) => input.native)) {
        return;
      }
      const stat = fs.lstatSync(content, { bigint: true });
      writeManifest(manifestPath, {
        format: FORMAT,
        slot: slotKey,
        sourceRoot,
        contentIdentity: `${stat.dev}:${stat.ino}`,
        recordedAtNs: String(params.recordedAtNs),
        capturedAtNs: String(params.capturedAtNs),
        receipt: params.receipt,
        sources: Object.fromEntries(params.sources),
        captured,
      });
    },
    /** Mark a successful adoption: refresh racy timestamps or the unused-variant clock. */
    adopted() {
      if (!manifest) {
        return;
      }
      try {
        if (racy) {
          writeManifest(manifestPath, {
            ...manifest,
            recordedAtNs: String(startedAtNs),
            capturedAtNs: String(startedAtNs),
          });
        } else {
          const now = new Date();
          fs.utimesSync(manifestPath, now, now);
        }
      } catch (error) {
        // The adopted bytes are already verified; a stale clock only costs a later rehash.
        process.emitWarning(`Plugin capture reuse manifest refresh skipped: ${String(error)}`);
      }
    },
    release() {
      if (!released) {
        released = true;
        lease();
      }
    },
  };
}

/** Startup maintenance: drop recycled trees and variants for removed or long-unused plugins. */
export async function prunePluginCaptureReuse(
  capturesRoot: string,
  recordFailure: (error: unknown) => void,
): Promise<void> {
  let root: string;
  try {
    root = path.join(await fsPromises.realpath(capturesRoot), PLUGIN_CAPTURE_REUSE_DIRECTORY);
    assertPrivateDirectory(root);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      recordFailure(error);
    }
    return;
  }
  for (const slotName of await fsPromises.readdir(root)) {
    const slot = path.join(root, slotName);
    try {
      assertPrivateDirectory(slot);
      for (const name of await fsPromises.readdir(slot)) {
        const entry = path.join(slot, name);
        try {
          if (name.startsWith("trash-")) {
            await fsPromises.rm(entry, { recursive: true, force: true });
          } else if (/^\d+$/u.test(name) && !usedVariants.has(entry)) {
            await reclaimVariant(entry);
          }
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT") && !isSqliteLockError(error)) {
            recordFailure(error);
          }
        }
      }
      await fsPromises.rmdir(slot).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOTEMPTY") && !hasErrnoCode(error, "EEXIST")) {
          throw error;
        }
      });
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        recordFailure(error);
      }
    }
  }
}

async function reclaimVariant(variant: string): Promise<void> {
  const stat = assertPrivateDirectory(variant);
  const manifestPath = path.join(variant, MANIFEST);
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  let sourceRoot: unknown;
  try {
    sourceRoot = manifestStat?.isFile()
      ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { sourceRoot?: unknown }).sourceRoot
      : undefined;
  } catch {
    sourceRoot = undefined;
  }
  const lastUsed = manifestStat?.isFile() ? manifestStat.mtimeMs : Number(stat.mtimeMs);
  const orphaned = typeof sourceRoot === "string" && !fs.existsSync(sourceRoot);
  if (!orphaned && Date.now() - lastUsed < UNUSED_MS) {
    return;
  }
  if (!fs.lstatSync(path.join(variant, SQLITE_STAGING_TOKEN_FILES[0]), { throwIfNoEntry: false })) {
    // Leases are taken right after creation; an aged tokenless variant was never adopted.
    await fsPromises.rm(variant, { recursive: true, force: true });
    return;
  }
  // A live owner holds the token's write lock, so an exclusive reclaim fails while it is busy.
  const release = acquireSqliteStagingToken(variant, "reclaim");
  let released = false;
  try {
    await fsPromises.rm(manifestPath, { force: true });
    await fsPromises.rm(path.join(variant, CONTENT), { recursive: true, force: true });
    // Retirement makes late lease attempts fail before the directory disappears.
    release(true);
    released = true;
    await fsPromises.rm(variant, { recursive: true, force: true });
  } finally {
    if (!released) {
      release();
    }
  }
}
