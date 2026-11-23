import { hostname } from "node:os";
import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import { parseBaseUrl } from "./shared/base-url";
import { PLACEHOLDER_ORIGIN } from "./shared/constants";
import { installHookRpc, logoutRpc, loginRpc, pollRpc, statusRpc } from "./shared/rpc";
import { connection, mcp } from "./shared/settings";
import { mcpEnabled } from "./shared/view";
import { ensureDataDir, resolveDataDir } from "./server/data-dir";
import { createDeviceApi } from "./server/device-api";
import { createLoginMachine, type MachineSettings } from "./server/login-machine";
import { createHarnessSetup } from "./server/harness-setup";
import { detectHarnesses, resolvePaths } from "./server/harness-paths";
import { createInstallerRunner } from "./server/hooks-installer";
import { chainOpenSteps, createAgyGatewayEnvHook } from "./server/agy-gateway-env";
import { createMcpAttachHook } from "./server/mcp-attach";
import { createStore } from "./server/store";

type SettingsRead = PluginSettingsState<typeof connection.schema>;

function toMachineSettings(state: SettingsRead): MachineSettings {
  if (state.status !== "ready") {
    return {
      origin: null,
      originError: "invalid_base_url",
      deviceName: "",
      instanceId: "default",
    };
  }
  const { baseUrl, deviceName, instanceId } = state.values;
  const parsed = parseBaseUrl(baseUrl);
  if (!parsed.ok) return { origin: null, originError: "invalid_base_url", deviceName, instanceId };
  if (parsed.origin === PLACEHOLDER_ORIGIN) {
    return { origin: null, originError: "not_configured", deviceName, instanceId };
  }
  return { origin: parsed.origin, deviceName, instanceId };
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(connection);
  const mcpSettings = server.registerSettings(mcp);
  const lifetime = new AbortController();
  const dir = resolveDataDir();
  console.log(`data dir: ${dir}`);

  const store = createStore(dir);
  const paths = resolvePaths();
  const harness = createHarnessSetup({
    store,
    paths,
    detect: (resolved) => detectHarnesses(resolved),
    runInstaller: createInstallerRunner(),
    now: Date.now,
    signal: lifetime.signal,
  });
  const machine = createLoginMachine({
    store,
    harness,
    api: createDeviceApi({ signal: lifetime.signal }),
    readSettings: async () => toMachineSettings(await settings.read()),
    now: Date.now,
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    hostName: hostname,
    abort: () => lifetime.abort(),
  });

  // Keep the outcome instead of a rejected promise: an unhandled rejection would exit the subprocess.
  const initError = ensureDataDir(dir)
    .then(() => harness.init())
    .then(() => machine.init())
    .then(
      () => null,
      (error: unknown) => {
        console.error(`init failed (${error instanceof Error ? error.name : "unknown"})`);
        return error;
      },
    );
  const ready = async () => {
    if (await initError) throw new Error("Agent-Memory plugin could not start; see plugin logs");
  };

  // The hooks read local files only. The MCP switch is read on every open, so a change applies to the next agent.
  const attachMcp = createMcpAttachHook({
    readEnabled: async () => mcpEnabled(await mcpSettings.read()),
    readSettingsOrigin: async () => toMachineSettings(await settings.read()).origin,
    readCredential: () => store.readCredential(),
    now: Date.now,
    log: (message) => console.error(message),
  });
  // Not behind the MCP switch: it is part of the Antigravity setup, which is not.
  const injectAgyGateway = createAgyGatewayEnvHook({
    readCredential: () => store.readCredential(),
    readSettingsOrigin: async () => toMachineSettings(await settings.read()).origin,
    readHarness: () => store.readHarness(),
    now: Date.now,
    log: (message) => console.error(message),
  });
  // One handler, so the second step sees the result of the first.
  server.addHook("agent.open.before", chainOpenSteps(attachMcp, injectAgyGateway));

  server.handle(statusRpc, async () => {
    await ready();
    return machine.status();
  });
  server.handle(pollRpc, async () => {
    await ready();
    return machine.poll();
  });
  server.handle(loginRpc, async () => {
    await ready();
    return machine.login();
  });
  server.handle(logoutRpc, async ({ force }) => {
    await ready();
    return machine.logout(force ?? false);
  });
  server.handle(installHookRpc, async ({ id }) => {
    await ready();
    return machine.installHook(id);
  });

  return () => {
    machine.stop();
  };
}
