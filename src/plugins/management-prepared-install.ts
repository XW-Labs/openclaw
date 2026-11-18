// Prepares an npm-pack plugin generation while the Gateway runs and activates it later.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  resolveNpmPackArchiveMetadata,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import { readManagedNpmRootInstalledDependency } from "../infra/npm-managed-root.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import {
  prepareManagedPluginArtifactConsentHandler,
  type PluginCapabilityConsentAcknowledgment,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import {
  loadConfigForInstall,
  PluginInstallConfigError,
  resolvePluginInstallRequestContext,
} from "./install-config.js";
import {
  listManagedNpmRootPackageNames,
  resolveManagedNpmInstallPlan,
  resolveManagedNpmRootPackageDir,
} from "./install-managed-npm-state.js";
import { verifyInstalledNpmResolution } from "./install-npm-resolution.js";
import {
  isPluginNpmProjectDir,
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
} from "./install-paths.js";
import { persistPluginInstall } from "./install-persistence.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { scanInstalledPackageDependencyTree } from "./install-security-scan.js";
import { loadPluginInstallRuntime, runInstallSourceScan } from "./install-shared.js";
import {
  requestDeferredPluginInstall,
  takePluginInstallTransaction,
} from "./install-transaction.js";
import type { PluginInstallLogger } from "./install-types.js";
import { installPluginFromNpmPackArchive } from "./install.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { PluginInstallPersistedError } from "./lifecycle.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  clearRetainedManagedNpmInstallMarker,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallPackageInfo,
} from "./managed-npm-retention.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import { buildNpmPackInstallRecord } from "./management-install.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

const PREPARED_INSTALL_RECEIPT_VERSION = 1;
const PREPARED_PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Durable facts that bind an unrecorded, retained npm generation to its later activation. */
export type PreparedNpmPackInstallReceipt = {
  version: typeof PREPARED_INSTALL_RECEIPT_VERSION;
  pluginId: string;
  packageName: string;
  preparedAt: string;
  archivePath: string;
  mode: "install" | "update";
  enable?: false;
  install: PluginInstallRecord;
  npmResolution: NpmSpecResolution;
  projectDir: string;
  projectDirIdentity: { dev: string; ino: string };
  packageLockSha256: string;
  declaredSurfaceToken: string;
};

type PreparedInstallConsentParams = {
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
};

export type PrepareNpmPackInstallParams = PreparedInstallConsentParams & {
  archivePath: string;
  mode: "install" | "update";
  enable?: boolean;
  env?: NodeJS.ProcessEnv;
  logger?: PluginInstallLogger;
  safetyOverrides?: Pick<InstallSafetyOverrides, "onInstallPolicyWarning">;
};

export type PrepareNpmPackInstallResult = {
  pluginId: string;
  packageName: string;
  version?: string;
  installPath: string;
  receiptPath: string;
  superseded?: string;
};

export type ActivatePreparedInstallParams = PreparedInstallConsentParams & {
  pluginId: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginInstallLogger;
};

export type ActivatePreparedInstallResult = {
  pluginId: string;
  version?: string;
  installPath: string;
  previousInstallPath?: string;
  warnings?: string[];
};

function preparedInstallError(message: string, cause?: unknown): ManagedPluginLifecycleError {
  return new ManagedPluginLifecycleError(message, cause !== undefined ? { cause } : undefined);
}

export function resolvePreparedInstallReceiptDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "plugins", "prepared");
}

export function resolvePreparedInstallReceiptPath(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!PREPARED_PLUGIN_ID_PATTERN.test(pluginId)) {
    throw preparedInstallError(`Plugin id "${pluginId}" cannot name a prepared install receipt.`);
  }
  return path.join(resolvePreparedInstallReceiptDir(env), `${pluginId}.json`);
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function readDirIdentity(dir: string): Promise<{ dev: string; ino: string }> {
  const stat = await fs.stat(dir, { bigint: true });
  if (!stat.isDirectory()) {
    throw preparedInstallError(`Prepared plugin project ${dir} is not a directory.`);
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseReceipt(raw: unknown, receiptPath: string): PreparedNpmPackInstallReceipt {
  const identity = isRecord(raw) ? raw.projectDirIdentity : undefined;
  if (
    !isRecord(raw) ||
    raw.version !== PREPARED_INSTALL_RECEIPT_VERSION ||
    typeof raw.pluginId !== "string" ||
    typeof raw.packageName !== "string" ||
    typeof raw.archivePath !== "string" ||
    (raw.mode !== "install" && raw.mode !== "update") ||
    !isRecord(raw.install) ||
    raw.install.source !== "npm" ||
    typeof raw.install.installPath !== "string" ||
    !isRecord(raw.npmResolution) ||
    typeof raw.projectDir !== "string" ||
    !isRecord(identity) ||
    typeof identity.dev !== "string" ||
    typeof identity.ino !== "string" ||
    typeof raw.packageLockSha256 !== "string" ||
    typeof raw.declaredSurfaceToken !== "string"
  ) {
    throw preparedInstallError(`Prepared install receipt ${receiptPath} is malformed.`);
  }
  // SAFETY: every field the activation reads was shape-checked above.
  return raw as unknown as PreparedNpmPackInstallReceipt;
}

async function readPreparedInstallReceipt(
  receiptPath: string,
): Promise<PreparedNpmPackInstallReceipt | null> {
  let text: string;
  try {
    text = await fs.readFile(receiptPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw preparedInstallError(`Prepared install receipt ${receiptPath} is not JSON.`, error);
  }
  return parseReceipt(parsed, receiptPath);
}

async function writePreparedInstallReceipt(
  receiptPath: string,
  receipt: PreparedNpmPackInstallReceipt,
  assertOwned: () => void,
): Promise<void> {
  await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  const tempPath = `${receiptPath}.${process.pid}.${Date.now()}.tmp`;
  assertOwned();
  await fs.writeFile(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    assertOwned();
    await fs.rename(tempPath, receiptPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

function collectActiveInstallPaths(records: Record<string, PluginInstallRecord>): string[] {
  return Object.values(records).flatMap((record) => {
    const installPath = record.installPath?.trim();
    return installPath ? [path.resolve(resolveUserPath(installPath))] : [];
  });
}

function isProjectActive(projectDir: string, activeInstallPaths: readonly string[]): boolean {
  const resolved = path.resolve(projectDir);
  return activeInstallPaths.some(
    (installPath) => installPath === resolved || isPathInside(resolved, installPath),
  );
}

/** Drop earlier unactivated generations of the same package so one prepared install remains. */
async function discardSupersededPreparedInstalls(params: {
  env: NodeJS.ProcessEnv;
  npmDir: string;
  packageName: string;
  activeInstallPaths: readonly string[];
  assertOwned: () => void;
  logger?: PluginInstallLogger;
}): Promise<string | undefined> {
  const receiptDir = resolvePreparedInstallReceiptDir(params.env);
  let names: string[];
  try {
    names = await fs.readdir(receiptDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let superseded: string | undefined;
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const receiptPath = path.join(receiptDir, name);
    let receipt: PreparedNpmPackInstallReceipt | null;
    try {
      receipt = await readPreparedInstallReceipt(receiptPath);
    } catch {
      continue;
    }
    if (!receipt || receipt.packageName !== params.packageName) {
      continue;
    }
    params.assertOwned();
    if (
      isPluginNpmProjectDir({
        npmDir: params.npmDir,
        packageName: receipt.packageName,
        projectDir: receipt.projectDir,
      }) &&
      !isProjectActive(receipt.projectDir, params.activeInstallPaths) &&
      hasRetainedManagedNpmInstallMarker(receipt.install.installPath!)
    ) {
      await fs.rm(receipt.projectDir, { recursive: true, force: true });
      params.logger?.info?.(`Discarded earlier prepared install at ${receipt.projectDir}`);
    }
    params.assertOwned();
    await fs.rm(receiptPath, { force: true });
    superseded = receipt.projectDir;
  }
  return superseded;
}

function resolvePackageName(name: string | undefined): string {
  const parsed = name ? parseRegistryNpmSpec(name) : null;
  if (!parsed || parsed.selectorKind !== "none") {
    throw preparedInstallError(`unsupported npm pack package name: ${name ?? "<missing>"}`);
  }
  return parsed.name;
}

async function loadPluginInstallSnapshot(rawSpec: string) {
  const planned = resolvePluginInstallRequestContext({
    rawSpec,
    source: "npm-pack",
    installKind: "plugin",
  });
  if (!planned.ok) {
    throw preparedInstallError(planned.error);
  }
  try {
    return await loadConfigForInstall(planned.request);
  } catch (error) {
    if (error instanceof PluginInstallConfigError) {
      throw preparedInstallError(error.message, error);
    }
    throw error;
  }
}

/**
 * Install an npm-pack archive into a new managed npm generation without recording it.
 * The generation carries a keep-files retention marker, so index recovery never adopts
 * it and cleanup keeps it until activatePreparedInstall records it.
 */
export async function prepareNpmPackInstall(
  params: PrepareNpmPackInstallParams,
): Promise<PrepareNpmPackInstallResult> {
  const env = params.env ?? process.env;
  assertConfigWriteAllowedInCurrentMode({ env });
  return await withPluginLifecycleLease({ env }, async (lease) => {
    const assertOwned = () => lease.assertOwned();
    const archivePath = resolveUserPath(params.archivePath);
    const snapshot = await loadPluginInstallSnapshot(`npm-pack:${archivePath}`);
    const metadata = await resolveNpmPackArchiveMetadata({ archivePath });
    if (!metadata.ok) {
      throw preparedInstallError(metadata.error);
    }
    const packageName = resolvePackageName(metadata.metadata.name);
    const npmDir = resolveDefaultPluginNpmDir(env);
    const records = await loadInstalledPluginIndexInstallRecords({ env });
    const activeInstallPaths = collectActiveInstallPaths(records);
    const superseded = await discardSupersededPreparedInstalls({
      env,
      npmDir,
      packageName,
      activeInstallPaths,
      assertOwned,
      logger: params.logger,
    });
    const runtime = await loadPluginInstallRuntime();
    const plan = await resolveManagedNpmInstallPlan({
      runtime,
      npmBaseDir: npmDir,
      packageName,
      requestedMode: params.mode,
      npmResolution: metadata.metadata,
    });
    if (isProjectActive(plan.npmRoot, activeInstallPaths)) {
      throw preparedInstallError(
        `The npm generation for ${packageName} at ${plan.npmRoot} is the active install. Nothing to prepare; run the install without --prepare-only to reinstall it.`,
      );
    }
    if (await pathExists(plan.npmRoot)) {
      throw preparedInstallError(
        `The npm generation for ${packageName} at ${plan.npmRoot} already exists. Remove it or install a different archive.`,
      );
    }

    const consent = await prepareManagedPluginArtifactConsentHandler({
      config: snapshot.config,
      env,
      source: "npm",
      acknowledgeCapabilities: params.acknowledgeCapabilities,
      onCapabilityConsent: params.onCapabilityConsent,
    });
    const result = await installPluginFromNpmPackArchive(
      requestDeferredPluginInstall(
        {
          ...params.safetyOverrides,
          config: snapshot.config,
          extensionsDir: resolveDefaultPluginExtensionsDir(env),
          npmDir,
          logger: params.logger,
          archivePath,
          mode: params.mode,
          beforePersistentApply: assertOwned,
          onBeforePluginArtifactCommit: consent.onBeforePluginArtifactCommit,
        },
        undefined,
        assertOwned,
      ),
    );
    if (!result.ok) {
      throw new ManagedPluginLifecycleError(result.error, {
        ...(result.code ? { code: result.code } : {}),
        installRejected: true,
      });
    }
    const transaction = takePluginInstallTransaction(result);
    let receiptPath: string | undefined;
    try {
      // A retained generation key makes the installer pick a fresh random generation, so
      // check the published directory itself rather than the plan computed above.
      const projectDir = resolveRetainedManagedNpmInstallPackageInfo(result.targetDir)?.projectRoot;
      if (
        !projectDir ||
        !isPluginNpmProjectDir({ npmDir, packageName, projectDir }) ||
        isProjectActive(projectDir, activeInstallPaths)
      ) {
        throw preparedInstallError(
          `Prepared install landed at ${result.targetDir}, outside a new npm generation for ${packageName}.`,
        );
      }
      const preparedReceiptPath = resolvePreparedInstallReceiptPath(result.pluginId, env);
      const install = buildNpmPackInstallRecord(result, archivePath);
      const declared = resolvePluginArtifactDeclaredSurface(result.targetDir, env, {
        config: snapshot.config,
      });
      const marked = await markRetainedManagedNpmInstall({
        packageDir: result.targetDir,
        pluginId: result.pluginId,
        reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
        assertCurrent: assertOwned,
      });
      if (!marked) {
        throw preparedInstallError(`Could not mark prepared install ${result.targetDir}.`);
      }
      const receipt: PreparedNpmPackInstallReceipt = {
        version: PREPARED_INSTALL_RECEIPT_VERSION,
        pluginId: result.pluginId,
        packageName,
        preparedAt: new Date().toISOString(),
        archivePath,
        mode: plan.policyMode,
        ...(params.enable === false ? { enable: false as const } : {}),
        install,
        npmResolution: result.npmResolution ?? metadata.metadata,
        projectDir,
        projectDirIdentity: await readDirIdentity(projectDir),
        packageLockSha256: await sha256File(path.join(projectDir, "package-lock.json")),
        declaredSurfaceToken: computeDeclaredSurfaceHash(declared),
      };
      receiptPath = preparedReceiptPath;
      await writePreparedInstallReceipt(preparedReceiptPath, receipt, assertOwned);
      await transaction?.commit();
      return {
        pluginId: result.pluginId,
        packageName,
        ...(result.version ? { version: result.version } : {}),
        installPath: result.targetDir,
        receiptPath: preparedReceiptPath,
        ...(superseded ? { superseded } : {}),
      };
    } catch (error) {
      try {
        if (receiptPath) {
          await fs.rm(receiptPath, { force: true });
        }
        await transaction?.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${String(error)}; prepared install rollback failed`,
          { cause: error },
        );
      }
      throw error;
    }
  });
}

async function verifyPreparedInstall(params: {
  receipt: PreparedNpmPackInstallReceipt;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  logger?: PluginInstallLogger;
}): Promise<void> {
  const { receipt } = params;
  const npmDir = resolveDefaultPluginNpmDir(params.env);
  const installPath = receipt.install.installPath!;
  const refuse = (reason: string): never => {
    throw preparedInstallError(
      `Prepared install for "${receipt.pluginId}" ${reason}. Prepare it again before activating.`,
    );
  };
  if (
    !isPluginNpmProjectDir({
      npmDir,
      packageName: receipt.packageName,
      projectDir: receipt.projectDir,
    }) ||
    path.resolve(installPath) !==
      path.resolve(resolveManagedNpmRootPackageDir(receipt.projectDir, receipt.packageName))
  ) {
    refuse(`points outside the managed npm root (${receipt.projectDir})`);
  }
  let identity: { dev: string; ino: string };
  try {
    identity = await readDirIdentity(receipt.projectDir);
  } catch {
    return refuse(`is missing its project directory ${receipt.projectDir}`);
  }
  if (
    identity.dev !== receipt.projectDirIdentity.dev ||
    identity.ino !== receipt.projectDirIdentity.ino
  ) {
    refuse(`project directory ${receipt.projectDir} was replaced`);
  }
  if (!hasRetainedManagedNpmInstallMarker(installPath)) {
    refuse("is no longer retained");
  }
  let lockHash: string;
  try {
    lockHash = await sha256File(path.join(receipt.projectDir, "package-lock.json"));
  } catch {
    return refuse("is missing its package-lock.json");
  }
  if (lockHash !== receipt.packageLockSha256) {
    refuse("package-lock.json changed since it was prepared");
  }
  const installed = await readManagedNpmRootInstalledDependency({
    npmRoot: receipt.projectDir,
    packageName: receipt.packageName,
  });
  const resolution = verifyInstalledNpmResolution({
    packageName: receipt.packageName,
    expected: receipt.npmResolution,
    installed,
  });
  if (resolution.kind !== "ok") {
    refuse(`no longer matches its archive: ${resolution.error}`);
  }
  const declared = resolvePluginArtifactDeclaredSurface(installPath, params.env, {
    config: params.config,
  });
  if (computeDeclaredSurfaceHash(declared) !== receipt.declaredSurfaceToken) {
    refuse("declares different capabilities than when it was prepared");
  }
  const additionalPackageDirs = [...(await listManagedNpmRootPackageNames(receipt.projectDir))]
    .map((packageName) => resolveManagedNpmRootPackageDir(receipt.projectDir, packageName))
    .toSorted((left, right) => left.localeCompare(right));
  const blocked = await runInstallSourceScan({
    subject: `Plugin "${receipt.pluginId}"`,
    pluginId: receipt.pluginId,
    mode: receipt.mode,
    sourceFamily: "archive",
    scan: async () =>
      await scanInstalledPackageDependencyTree({
        additionalPackageDirs,
        allowManagedNpmRootPackagePeerSymlinks: true,
        config: params.config,
        dependencyScanRootDir: receipt.projectDir,
        logger: params.logger ?? {},
        mode: receipt.mode,
        packageDir: installPath,
        pluginId: receipt.pluginId,
        requestKind: "plugin-npm",
        requestedSpecifier: `npm-pack:${receipt.archivePath}`,
        source: { kind: "archive", authority: "user", mutable: true, network: false },
      }),
  });
  if (blocked) {
    throw new ManagedPluginLifecycleError(blocked.error, {
      ...(blocked.code ? { code: blocked.code } : {}),
      installRejected: true,
    });
  }
}

/**
 * Record a prepared npm generation as the plugin's install, for a stopped Gateway.
 * Reverifies the generation, reruns capability consent against the previous install,
 * then persists it exactly as a normal install would.
 */
export async function activatePreparedInstall(
  params: ActivatePreparedInstallParams,
): Promise<ActivatePreparedInstallResult> {
  const env = params.env ?? process.env;
  assertConfigWriteAllowedInCurrentMode({ env });
  return await withPluginLifecycleLease({ env }, async (lease) => {
    const assertOwned = () => lease.assertOwned();
    const receiptPath = resolvePreparedInstallReceiptPath(params.pluginId, env);
    const receipt = await readPreparedInstallReceipt(receiptPath);
    if (!receipt) {
      throw preparedInstallError(
        `No prepared install for "${params.pluginId}". Run openclaw plugins install npm-pack:<archive> --prepare-only first.`,
      );
    }
    if (receipt.pluginId !== params.pluginId) {
      throw preparedInstallError(`Prepared install receipt ${receiptPath} names another plugin.`);
    }
    const installPath = receipt.install.installPath!;
    const snapshot = await loadPluginInstallSnapshot(`npm-pack:${receipt.archivePath}`);
    await verifyPreparedInstall({
      receipt,
      env,
      config: snapshot.config,
      logger: params.logger,
    });
    const records = await loadInstalledPluginIndexInstallRecords({ env });
    const previousInstallPath = records[receipt.pluginId]?.installPath;
    const consent = await prepareManagedPluginArtifactConsentHandler({
      config: snapshot.config,
      env,
      source: "npm",
      previousRecords: records,
      acknowledgeCapabilities: params.acknowledgeCapabilities,
      onCapabilityConsent: params.onCapabilityConsent,
    });
    await consent.onBeforePluginArtifactCommit({
      pluginId: receipt.pluginId,
      stagedArtifactDir: installPath,
      ...(previousInstallPath ? { currentArtifactDir: previousInstallPath } : {}),
      mode: receipt.mode,
    });
    const install = consent.applyAcceptedSurface(receipt.pluginId, receipt.install);
    const warnings: string[] = [];
    try {
      await persistPluginInstall({
        snapshot,
        env,
        pluginId: receipt.pluginId,
        install,
        ...(receipt.enable === false ? { enable: false } : {}),
        invalidateRuntimeCache: false,
        runtime: { log: () => {} },
        persistenceLogger: { warn: (message) => warnings.push(message) },
        beforePersistentApply: assertOwned,
      });
    } catch (error) {
      if (error instanceof PluginInstallPersistedError) {
        // The record and config are committed; the receipt has done its job.
        await fs.rm(receiptPath, { force: true });
      }
      throw error;
    }
    // The record commit clears the marker of every newly active npm install; keep that
    // invariant even if a future writer stops doing so.
    if (hasRetainedManagedNpmInstallMarker(installPath)) {
      await clearRetainedManagedNpmInstallMarker(installPath, assertOwned);
    }
    await fs.rm(receiptPath, { force: true });
    return {
      pluginId: receipt.pluginId,
      ...(receipt.install.version ? { version: receipt.install.version } : {}),
      installPath,
      ...(previousInstallPath && previousInstallPath !== installPath
        ? { previousInstallPath }
        : {}),
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  });
}
