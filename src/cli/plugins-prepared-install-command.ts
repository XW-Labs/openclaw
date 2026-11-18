// CLI for preparing an npm-pack plugin install while the Gateway runs and activating it later.
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, type OutputRuntimeEnv, type RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { createPluginInstallLogger } from "./plugins-command-helpers.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";

export type PluginsActivatePreparedOptions = {
  acceptCapabilities?: boolean;
  json?: boolean;
};

/** Prepare an npm-pack install locally; never hands off to a running Gateway. */
export async function runPreparedPluginInstallCommand(params: {
  archivePath: string;
  mode: "install" | "update";
  opts: {
    acceptCapabilities?: boolean;
    acknowledgeInstallPolicyWarning?: boolean;
    enable?: boolean;
  };
  allowInstallPolicyWarningPrompt: boolean;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const runtime = params.runtime ?? defaultRuntime;
  const { prepareNpmPackInstall } = await import("../plugins/management-prepared-install.js");
  let prepared: Awaited<ReturnType<typeof prepareNpmPackInstall>>;
  try {
    prepared = await prepareNpmPackInstall({
      archivePath: params.archivePath,
      mode: params.mode,
      ...(params.opts.enable === false ? { enable: false } : {}),
      logger: createPluginInstallLogger(runtime),
      ...resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: params.opts.acceptCapabilities,
        action: "install",
        runtime,
      }),
      safetyOverrides: resolveInstallPolicyWarningAcknowledgementCliOptions({
        acknowledgeInstallPolicyWarning: params.opts.acknowledgeInstallPolicyWarning,
        allowPrompt: params.allowInstallPolicyWarningPrompt,
      }),
    });
  } catch (error) {
    runtime.error(formatErrorMessage(error));
    return runtime.exit(1);
  }
  if (prepared.superseded) {
    runtime.log(
      theme.muted(`Replaced earlier prepared install: ${shortenHomePath(prepared.superseded)}`),
    );
  }
  runtime.log(
    `Prepared plugin: ${prepared.pluginId}${prepared.version ? ` ${prepared.version}` : ""} at ${shortenHomePath(prepared.installPath)}`,
  );
  runtime.log(
    `Not active yet. Stop the Gateway, then run ${formatCliCommand(`openclaw plugins activate-prepared ${prepared.pluginId}`)}.`,
  );
}

/** Record a prepared install as the plugin's install while the Gateway is stopped. */
export async function runPluginsActivatePreparedCommand(
  pluginId: string,
  opts: PluginsActivatePreparedOptions = {},
  runtime: OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  let gateway: Awaited<ReturnType<typeof resolvePluginLifecycleGateway>>;
  try {
    gateway = await resolvePluginLifecycleGateway();
  } catch (error) {
    runtime.error(formatErrorMessage(error));
    return runtime.exit(1);
  }
  if (gateway) {
    runtime.error(
      `The Gateway is running. Stop it before activating the prepared install of "${pluginId}"; a running Gateway keeps the previous plugin generation loaded.`,
    );
    return runtime.exit(1);
  }
  const { activatePreparedInstall } = await import("../plugins/management-prepared-install.js");
  let activated: Awaited<ReturnType<typeof activatePreparedInstall>>;
  try {
    activated = await activatePreparedInstall({
      pluginId,
      logger: createPluginInstallLogger(runtime),
      ...resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: opts.acceptCapabilities,
        action: "install",
        allowPrompt: !opts.json,
        runtime,
      }),
    });
  } catch (error) {
    runtime.error(formatErrorMessage(error));
    return runtime.exit(1);
  }
  if (opts.json) {
    return runtime.writeJson({ ok: true, ...activated });
  }
  for (const warning of activated.warnings ?? []) {
    runtime.log(theme.warn(warning));
  }
  runtime.log(
    `Activated plugin: ${activated.pluginId}${activated.version ? ` ${activated.version}` : ""} at ${shortenHomePath(activated.installPath)}`,
  );
  runtime.log("Saved for the next Gateway start.");
}
