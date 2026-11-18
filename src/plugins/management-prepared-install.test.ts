// Prepared npm-pack installs stage a retained generation, then activate it like an install.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { resolveManagedNpmInstallPlan } from "./install-managed-npm-state.js";
import { resolveDefaultPluginNpmDir, resolvePluginNpmProjectDir } from "./install-paths.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { loadPluginInstallRuntime } from "./install-shared.js";
import { attachPluginInstallTransaction } from "./install-transaction.js";
import { listRecoveredManagedNpmInstallCandidates } from "./installed-plugin-index-record-reader.js";
import {
  loadInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "./managed-npm-retention.js";
import {
  activatePreparedInstall,
  prepareNpmPackInstall,
  resolvePreparedInstallReceiptPath,
} from "./management-prepared-install.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

const mocks = vi.hoisted(() => ({
  resolveNpmPackArchiveMetadata: vi.fn(),
  installPluginFromNpmPackArchive: vi.fn(),
  persistPluginInstall: vi.fn(),
  scanInstalledPackageDependencyTree: vi.fn(async () => undefined),
}));

vi.mock("../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/install-source-utils.js")>()),
  resolveNpmPackArchiveMetadata: mocks.resolveNpmPackArchiveMetadata,
}));
vi.mock("./install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install.js")>()),
  installPluginFromNpmPackArchive: mocks.installPluginFromNpmPackArchive,
}));
vi.mock("./install-persistence.js", () => ({
  persistPluginInstall: mocks.persistPluginInstall,
}));
vi.mock("./install-security-scan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-security-scan.js")>()),
  scanInstalledPackageDependencyTree: mocks.scanInstalledPackageDependencyTree,
}));
// Use the real staged-artifact consent policy; skip only the metadata snapshot that
// maps runtime child ids to package owners, which these single-plugin packages do not need.
vi.mock("./capability-consent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capability-consent.js")>();
  return {
    ...actual,
    prepareManagedPluginArtifactConsentHandler: async (
      params: Parameters<typeof actual.prepareManagedPluginArtifactConsentHandler>[0],
    ) => {
      const records = await import("./installed-plugin-index-records.js");
      return actual.createManagedPluginArtifactConsentHandler({
        ...params,
        previousRecords:
          params.previousRecords ??
          (await records.loadInstalledPluginIndexInstallRecords({ env: params.env })),
      });
    },
  };
});

const PLUGIN_ID = "prepared-demo";
const PACKAGE_NAME = "prepared-demo-plugin";
const ARCHIVE_PATH = "/tmp/prepared-demo-plugin-2.0.0.tgz";

function resolution(version: string, integrity: string): NpmSpecResolution {
  return {
    name: PACKAGE_NAME,
    version,
    resolvedSpec: `${PACKAGE_NAME}@${version}`,
    integrity,
    shasum: `${version}-shasum`,
  };
}

const nextResolution = resolution("2.0.0", "sha512-next");

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Writes a managed npm project holding the plugin package, as npm would leave it. */
function writePluginProject(params: {
  projectDir: string;
  version: string;
  integrity: string;
  tools: string[];
}): string {
  const packageDir = path.join(params.projectDir, "node_modules", PACKAGE_NAME);
  writeJson(path.join(params.projectDir, "package.json"), {
    private: true,
    dependencies: { [PACKAGE_NAME]: params.version },
  });
  writeJson(path.join(params.projectDir, "package-lock.json"), {
    name: "openclaw-managed-plugin",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { [PACKAGE_NAME]: params.version } },
      [`node_modules/${PACKAGE_NAME}`]: {
        version: params.version,
        integrity: params.integrity,
        resolved: `file:./_openclaw-pack-archives/${PACKAGE_NAME}-${params.version}.tgz`,
      },
    },
  });
  writeJson(path.join(packageDir, "package.json"), {
    name: PACKAGE_NAME,
    version: params.version,
    openclaw: { extensions: ["./dist/index.js"] },
  });
  writeJson(path.join(packageDir, "openclaw.plugin.json"), {
    id: PLUGIN_ID,
    contracts: { tools: params.tools },
    configSchema: { type: "object" },
  });
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n", "utf8");
  return packageDir;
}

async function planNextGeneration(mode: "install" | "update") {
  return await resolveManagedNpmInstallPlan({
    runtime: await loadPluginInstallRuntime(),
    npmBaseDir: resolveDefaultPluginNpmDir(),
    packageName: PACKAGE_NAME,
    requestedMode: mode,
    npmResolution: nextResolution,
  });
}

/** Installer double: publishes the planned generation exactly where the real installer would. */
function mockInstaller(tools: string[]) {
  const commit = vi.fn(async () => undefined);
  mocks.installPluginFromNpmPackArchive.mockImplementation(
    async (params: {
      mode: "install" | "update";
      onBeforePluginArtifactCommit?: (request: {
        pluginId: string;
        stagedArtifactDir: string;
        mode: "install" | "update";
      }) => Promise<void>;
    }) => {
      const plan = await planNextGeneration(params.mode);
      writePluginProject({
        projectDir: plan.npmRoot,
        version: "2.0.0",
        integrity: "sha512-next",
        tools,
      });
      try {
        await params.onBeforePluginArtifactCommit?.({
          pluginId: PLUGIN_ID,
          stagedArtifactDir: plan.installRoot,
          mode: plan.policyMode,
        });
      } catch (error) {
        fs.rmSync(plan.npmRoot, { recursive: true, force: true });
        throw error;
      }
      return attachPluginInstallTransaction(
        {
          ok: true,
          pluginId: PLUGIN_ID,
          targetDir: plan.installRoot,
          manifestName: PACKAGE_NAME,
          version: "2.0.0",
          extensions: ["./dist/index.js"],
          npmResolution: nextResolution,
          npmTarballName: `${PACKAGE_NAME}-2.0.0.tgz`,
        },
        {
          commit,
          rollback: async () => fs.rmSync(plan.npmRoot, { recursive: true, force: true }),
        },
      );
    },
  );
  return { commit };
}

/** Persistence double that commits records through the real retention-aware writer. */
function mockPersistence() {
  mocks.persistPluginInstall.mockImplementation(
    async (params: {
      pluginId: string;
      install: PluginInstallRecord;
      snapshot: { config: object };
    }) => {
      const previousInstallRecords = await loadInstalledPluginIndexInstallRecords();
      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords,
        nextInstallRecords: { ...previousInstallRecords, [params.pluginId]: params.install },
        nextConfig: params.snapshot.config,
      });
      return params.snapshot.config;
    },
  );
}

/** Seeds the currently active 1.0.0 install with an accepted capability surface. */
async function seedActiveInstall(state: OpenClawTestState) {
  const config = { plugins: { entries: { [PLUGIN_ID]: { enabled: true } } } };
  const projectDir = resolvePluginNpmProjectDir({
    npmDir: resolveDefaultPluginNpmDir(),
    packageName: PACKAGE_NAME,
  });
  const installPath = writePluginProject({
    projectDir,
    version: "1.0.0",
    integrity: "sha512-active",
    tools: ["read"],
  });
  const acceptedSurface = resolvePluginArtifactDeclaredSurface(installPath);
  const record: PluginInstallRecord = {
    source: "npm",
    spec: `${PACKAGE_NAME}@1.0.0`,
    installPath,
    version: "1.0.0",
    integrity: "sha512-active",
    acceptedSurface,
    acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
    acceptedSurfaceIntegrity: "sha512-active",
  };
  await seedInstalledPluginIndex({ [PLUGIN_ID]: record }, { config, env: state.env });
  return { config, installPath, record };
}

async function withPreparedState<T>(
  label: string,
  run: (state: OpenClawTestState) => Promise<T>,
): Promise<T> {
  return await withOpenClawTestState({ label }, async (state) => {
    await state.writeConfig({ plugins: { entries: { [PLUGIN_ID]: { enabled: true } } } });
    return await run(state);
  });
}

describe("prepared npm-pack installs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveNpmPackArchiveMetadata.mockResolvedValue({
      ok: true,
      archivePath: ARCHIVE_PATH,
      tarballName: `${PACKAGE_NAME}-2.0.0.tgz`,
      metadata: nextResolution,
    });
    mocks.scanInstalledPackageDependencyTree.mockResolvedValue(undefined);
    mockPersistence();
  });

  it("stages a retained generation without touching the index or config", async () => {
    await withPreparedState("prepared-install-stage", async (state) => {
      const active = await seedActiveInstall(state);
      const { commit } = mockInstaller(["read"]);
      const configBefore = fs.readFileSync(state.configPath, "utf8");
      const recordsBefore = await readPersistedInstalledPluginIndexInstallRecords();

      const prepared = await prepareNpmPackInstall({ archivePath: ARCHIVE_PATH, mode: "update" });

      expect(prepared).toMatchObject({ pluginId: PLUGIN_ID, version: "2.0.0" });
      expect(prepared.installPath).not.toBe(active.installPath);
      expect(commit).toHaveBeenCalledOnce();
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);
      expect(await readPersistedInstalledPluginIndexInstallRecords()).toEqual(recordsBefore);

      const marker = JSON.parse(
        fs.readFileSync(resolveRetainedManagedNpmInstallMarkerPath(prepared.installPath), "utf8"),
      ) as { reason?: string; pluginId?: string };
      expect(marker).toMatchObject({
        pluginId: PLUGIN_ID,
        reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
      });
      const receiptPath = resolvePreparedInstallReceiptPath(PLUGIN_ID);
      expect(prepared.receiptPath).toBe(receiptPath);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        pluginId: PLUGIN_ID,
        packageName: PACKAGE_NAME,
        mode: "update",
        install: {
          source: "npm",
          installPath: prepared.installPath,
          sourcePath: ARCHIVE_PATH,
          artifactKind: "npm-pack",
          npmIntegrity: "sha512-next",
        },
      });
      if (process.platform !== "win32") {
        expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
      }

      // Index recovery never adopts the prepared generation, and cleanup keeps it.
      expect(
        listRecoveredManagedNpmInstallCandidates({ stateDir: state.stateDir }).map(
          (candidate) => candidate.installRecord.installPath,
        ),
      ).not.toContain(prepared.installPath);
      expect((await loadInstalledPluginIndexInstallRecords())[PLUGIN_ID]?.installPath).toBe(
        active.installPath,
      );
      await cleanupRetainedManagedNpmInstallGenerations({
        activeInstallPaths: [active.installPath],
      });
      expect(fs.existsSync(prepared.installPath)).toBe(true);
    });
  });

  it("refuses a target generation that already exists", async () => {
    await withPreparedState("prepared-install-exists", async (state) => {
      await seedActiveInstall(state);
      mockInstaller(["read"]);
      const plan = await planNextGeneration("update");
      fs.mkdirSync(plan.npmRoot, { recursive: true });

      await expect(
        prepareNpmPackInstall({ archivePath: ARCHIVE_PATH, mode: "update" }),
      ).rejects.toThrow("already exists");
      expect(mocks.installPluginFromNpmPackArchive).not.toHaveBeenCalled();
      expect(fs.existsSync(resolvePreparedInstallReceiptPath(PLUGIN_ID))).toBe(false);
    });
  });

  it("refuses a target generation that is the active install", async () => {
    await withPreparedState("prepared-install-active", async (state) => {
      const active = await seedActiveInstall(state);
      mockInstaller(["read"]);
      // A plain install targets the unversioned project the active install already owns.
      expect((await planNextGeneration("install")).installRoot).toBe(active.installPath);

      await expect(
        prepareNpmPackInstall({ archivePath: ARCHIVE_PATH, mode: "install" }),
      ).rejects.toThrow("is the active install");
      expect(mocks.installPluginFromNpmPackArchive).not.toHaveBeenCalled();
      expect(hasRetainedManagedNpmInstallMarker(active.installPath)).toBe(false);
    });
  });

  it.each(["lockfile", "directory"] as const)(
    "refuses to activate after its %s changed",
    async (tampered) => {
      await withPreparedState(`prepared-install-tampered-${tampered}`, async (state) => {
        const active = await seedActiveInstall(state);
        mockInstaller(["read"]);
        const prepared = await prepareNpmPackInstall({
          archivePath: ARCHIVE_PATH,
          mode: "update",
        });
        const projectDir = path.dirname(path.dirname(prepared.installPath));
        if (tampered === "lockfile") {
          fs.appendFileSync(path.join(projectDir, "package-lock.json"), "\n");
        } else {
          const moved = `${projectDir}.moved`;
          fs.renameSync(projectDir, moved);
          fs.cpSync(moved, projectDir, { recursive: true });
          fs.rmSync(moved, { recursive: true, force: true });
        }

        await expect(activatePreparedInstall({ pluginId: PLUGIN_ID })).rejects.toThrow(
          tampered === "lockfile" ? "package-lock.json changed" : "was replaced",
        );
        expect(mocks.persistPluginInstall).not.toHaveBeenCalled();
        expect(hasRetainedManagedNpmInstallMarker(prepared.installPath)).toBe(true);
        expect(fs.existsSync(prepared.receiptPath)).toBe(true);
        expect((await readPersistedInstalledPluginIndexInstallRecords())?.[PLUGIN_ID]).toEqual(
          expect.objectContaining({ installPath: active.installPath }),
        );
      });
    },
  );

  it("refuses a widened capability surface until it is accepted", async () => {
    await withPreparedState("prepared-install-widened", async (state) => {
      const active = await seedActiveInstall(state);
      mockInstaller(["read", "write"]);
      const accept = async (review: { reviewToken: string }) => ({
        reviewToken: review.reviewToken,
      });
      await expect(
        prepareNpmPackInstall({ archivePath: ARCHIVE_PATH, mode: "update" }),
      ).rejects.toThrow("requires capability consent");
      const prepared = await prepareNpmPackInstall({
        archivePath: ARCHIVE_PATH,
        mode: "update",
        onCapabilityConsent: accept,
      });

      await expect(activatePreparedInstall({ pluginId: PLUGIN_ID })).rejects.toThrow(
        "requires capability consent",
      );
      expect(mocks.persistPluginInstall).not.toHaveBeenCalled();
      expect(hasRetainedManagedNpmInstallMarker(prepared.installPath)).toBe(true);
      expect(fs.existsSync(prepared.receiptPath)).toBe(true);
      expect((await readPersistedInstalledPluginIndexInstallRecords())?.[PLUGIN_ID]).toEqual(
        expect.objectContaining({ installPath: active.installPath }),
      );

      await expect(
        activatePreparedInstall({ pluginId: PLUGIN_ID, onCapabilityConsent: accept }),
      ).resolves.toMatchObject({ pluginId: PLUGIN_ID, installPath: prepared.installPath });
      const persisted = mocks.persistPluginInstall.mock.calls[0]?.[0] as {
        install: PluginInstallRecord;
      };
      expect(persisted.install.acceptedSurface?.tools.toSorted()).toEqual(["read", "write"]);
    });
  });

  it("persists the prepared record, retires the old generation and clears the marker", async () => {
    await withPreparedState("prepared-install-activate", async (state) => {
      const active = await seedActiveInstall(state);
      mockInstaller(["read"]);
      const prepared = await prepareNpmPackInstall({ archivePath: ARCHIVE_PATH, mode: "update" });
      const projectDir = path.dirname(path.dirname(prepared.installPath));

      const activated = await activatePreparedInstall({ pluginId: PLUGIN_ID });

      expect(activated).toEqual({
        pluginId: PLUGIN_ID,
        version: "2.0.0",
        installPath: prepared.installPath,
        previousInstallPath: active.installPath,
      });
      expect(mocks.scanInstalledPackageDependencyTree).toHaveBeenCalledWith(
        expect.objectContaining({
          packageDir: prepared.installPath,
          dependencyScanRootDir: projectDir,
          pluginId: PLUGIN_ID,
        }),
      );
      expect(mocks.persistPluginInstall).toHaveBeenCalledOnce();
      expect(mocks.persistPluginInstall.mock.calls[0]?.[0]).toMatchObject({
        pluginId: PLUGIN_ID,
        install: {
          source: "npm",
          installPath: prepared.installPath,
          acceptedSurfaceIntegrity: "sha512-next",
        },
      });
      expect((await readPersistedInstalledPluginIndexInstallRecords())?.[PLUGIN_ID]).toEqual(
        expect.objectContaining({ installPath: prepared.installPath, version: "2.0.0" }),
      );
      expect(hasRetainedManagedNpmInstallMarker(prepared.installPath)).toBe(false);
      expect(hasRetainedManagedNpmInstallMarker(active.installPath)).toBe(true);
      expect(fs.existsSync(prepared.receiptPath)).toBe(false);
      await expect(activatePreparedInstall({ pluginId: PLUGIN_ID })).rejects.toThrow(
        "No prepared install",
      );
    });
  });

  it("supersedes an earlier unactivated generation of the same package", async () => {
    await withPreparedState("prepared-install-supersede", async (state) => {
      await seedActiveInstall(state);
      mockInstaller(["read"]);
      const first = await prepareNpmPackInstall({ archivePath: ARCHIVE_PATH, mode: "update" });
      const second = await prepareNpmPackInstall({ archivePath: ARCHIVE_PATH, mode: "update" });

      expect(second.installPath).toBe(first.installPath);
      expect(second.superseded).toBe(path.dirname(path.dirname(first.installPath)));
      expect(hasRetainedManagedNpmInstallMarker(second.installPath)).toBe(true);
      expect(fs.existsSync(second.receiptPath)).toBe(true);
    });
  });
});
