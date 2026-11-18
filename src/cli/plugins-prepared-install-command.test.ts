// CLI coverage for plugins install --prepare-only and plugins activate-prepared.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../runtime.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";
import { runPluginsActivatePreparedCommand } from "./plugins-prepared-install-command.js";

const mocks = vi.hoisted(() => ({
  prepareNpmPackInstall: vi.fn(),
  activatePreparedInstall: vi.fn(),
  resolvePluginLifecycleGateway: vi.fn(),
  installPluginWithHookFallback: vi.fn(),
}));

vi.mock("../plugins/management-prepared-install.js", () => ({
  prepareNpmPackInstall: mocks.prepareNpmPackInstall,
  activatePreparedInstall: mocks.activatePreparedInstall,
}));
vi.mock("./plugins-lifecycle-client.js", () => ({
  resolvePluginLifecycleGateway: mocks.resolvePluginLifecycleGateway,
}));
vi.mock("./plugins-install-hook-fallback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugins-install-hook-fallback.js")>()),
  installPluginWithHookFallback: mocks.installPluginWithHookFallback,
}));

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime: OutputRuntimeEnv = {
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
  return { runtime, logs, errors };
}

describe("plugins install --prepare-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareNpmPackInstall.mockResolvedValue({
      pluginId: "demo",
      packageName: "demo-plugin",
      version: "2.0.0",
      installPath: "/tmp/openclaw-npm/projects/demo/node_modules/demo-plugin",
      receiptPath: "/tmp/openclaw-state/plugins/prepared/demo.json",
    });
  });

  it("prepares locally and never hands off to a running Gateway", async () => {
    const gatewayCall = vi.fn();
    mocks.resolvePluginLifecycleGateway.mockResolvedValue(gatewayCall);
    const { runtime, logs, errors } = createRuntime();

    await runPluginInstallCommand({
      raw: "npm-pack:/tmp/demo-plugin-2.0.0.tgz",
      opts: { force: true, prepareOnly: true, acceptCapabilities: true },
      allowInstallPolicyWarningPrompt: false,
      runtime,
    });

    expect(errors).toEqual([]);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(mocks.resolvePluginLifecycleGateway).not.toHaveBeenCalled();
    expect(gatewayCall).not.toHaveBeenCalled();
    expect(mocks.installPluginWithHookFallback).not.toHaveBeenCalled();
    expect(mocks.prepareNpmPackInstall).toHaveBeenCalledOnce();
    const params = mocks.prepareNpmPackInstall.mock.calls[0]?.[0] as {
      archivePath: string;
      mode: string;
      onCapabilityConsent?: (review: { reviewToken: string }) => Promise<unknown>;
    };
    expect(params).toMatchObject({ archivePath: "/tmp/demo-plugin-2.0.0.tgz", mode: "update" });
    await expect(params.onCapabilityConsent?.({ reviewToken: "token-1" })).resolves.toEqual({
      reviewToken: "token-1",
    });
    expect(logs.join("\n")).toContain("Prepared plugin: demo 2.0.0");
    expect(logs.join("\n")).toContain("openclaw plugins activate-prepared demo");
  });

  it.each(["demo-plugin", "git:https://example.com/demo.git"])(
    "rejects %s as a prepare-only source",
    async (raw) => {
      const { runtime, errors } = createRuntime();

      await runPluginInstallCommand({
        raw,
        opts: { force: true, prepareOnly: true },
        allowInstallPolicyWarningPrompt: false,
        runtime,
      });

      expect(errors.join("\n")).toContain("--prepare-only requires an npm-pack:");
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.prepareNpmPackInstall).not.toHaveBeenCalled();
      expect(mocks.resolvePluginLifecycleGateway).not.toHaveBeenCalled();
      expect(mocks.installPluginWithHookFallback).not.toHaveBeenCalled();
    },
  );

  it("exits 1 with the reason when preparation fails", async () => {
    mocks.prepareNpmPackInstall.mockRejectedValue(new Error("generation already exists"));
    const { runtime, errors } = createRuntime();

    await runPluginInstallCommand({
      raw: "npm-pack:/tmp/demo-plugin-2.0.0.tgz",
      opts: { force: true, prepareOnly: true },
      allowInstallPolicyWarningPrompt: false,
      runtime,
    });

    expect(errors.join("\n")).toContain("generation already exists");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("plugins activate-prepared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePluginLifecycleGateway.mockResolvedValue(null);
    mocks.activatePreparedInstall.mockResolvedValue({
      pluginId: "demo",
      version: "2.0.0",
      installPath: "/tmp/openclaw-npm/projects/demo-next/node_modules/demo-plugin",
      previousInstallPath: "/tmp/openclaw-npm/projects/demo/node_modules/demo-plugin",
    });
  });

  it("refuses to run while a Gateway is reachable", async () => {
    mocks.resolvePluginLifecycleGateway.mockResolvedValue(vi.fn());
    const { runtime, errors } = createRuntime();

    await runPluginsActivatePreparedCommand("demo", { acceptCapabilities: true }, runtime);

    expect(errors.join("\n")).toContain("The Gateway is running");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.activatePreparedInstall).not.toHaveBeenCalled();
  });

  it("activates and prints JSON", async () => {
    const { runtime } = createRuntime();

    await runPluginsActivatePreparedCommand(
      "demo",
      { acceptCapabilities: true, json: true },
      runtime,
    );

    expect(runtime.exit).not.toHaveBeenCalled();
    const params = mocks.activatePreparedInstall.mock.calls[0]?.[0] as {
      pluginId: string;
      onCapabilityConsent?: (review: { reviewToken: string }) => Promise<unknown>;
    };
    expect(params.pluginId).toBe("demo");
    await expect(params.onCapabilityConsent?.({ reviewToken: "token-2" })).resolves.toEqual({
      reviewToken: "token-2",
    });
    expect(runtime.writeJson).toHaveBeenCalledWith({
      ok: true,
      pluginId: "demo",
      version: "2.0.0",
      installPath: "/tmp/openclaw-npm/projects/demo-next/node_modules/demo-plugin",
      previousInstallPath: "/tmp/openclaw-npm/projects/demo/node_modules/demo-plugin",
    });
  });

  it("exits 1 with the reason when activation is refused", async () => {
    mocks.activatePreparedInstall.mockRejectedValue(
      new Error('Plugin "demo" requires capability consent.'),
    );
    const { runtime, errors } = createRuntime();

    await runPluginsActivatePreparedCommand("demo", {}, runtime);

    expect(errors.join("\n")).toContain("requires capability consent");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });
});
