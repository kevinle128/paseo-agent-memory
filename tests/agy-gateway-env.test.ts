import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpAttachHook } from "../server/mcp-attach";
import { AGY_GATEWAY_ENV, agyGatewayUrlFor, chainOpenSteps, createAgyGatewayEnvHook } from "../server/agy-gateway-env";
import { keyDigest } from "../server/harness-files";
import { createStore, type CredentialFile, type HarnessFile } from "../server/store";

const NOW = Date.UTC(2026, 10, 21, 5, 0, 0);
const DAY = 86_400_000;
const PANEL = "https://panel.example.net";
const PROXY = "https://proxy.example.net:8097";
const KEY = "fake-device-key-0001";
const KEY2 = "fake-device-key-0002";

const credential = (key = KEY, extra: Partial<CredentialFile> = {}): CredentialFile => ({
  version: 1,
  origin: PANEL,
  instanceId: "default",
  installId: "install-0001",
  keyId: "keyid-0001",
  key,
  expiresAt: new Date(NOW + DAY).toISOString(),
  account: { userId: "u1", username: "an" },
  teams: [],
  deviceName: "d",
  savedAt: new Date(NOW).toISOString(),
  ...extra,
});

const harness = (
  key = KEY,
  agy: Partial<HarnessFile["harnesses"][number]> | null = {},
  extra: Partial<HarnessFile> = {},
): HarnessFile => ({
  version: 1,
  keyId: "keyid-0001",
  keyDigest: keyDigest(key),
  proxyOrigin: PROXY,
  instanceId: "default",
  configuredAt: new Date(NOW).toISOString(),
  paths: { home: "/tmp/none", shell: "/bin/zsh" },
  harnesses: [
    { id: "claude", state: "configured", route: `${PROXY}/claude-code/default` },
    ...(agy
      ? [{ id: "agy" as const, state: "configured" as const, route: `${PROXY}/antigravity/default`, ...agy }]
      : []),
  ],
  ...extra,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pam-agy-gateway-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = {
  provider: "antigravity",
  cwd: "/work",
  env: { KEEP: "1" } as Record<string, string>,
  mcpServers: { saved: { type: "http" as const, url: "https://other.example.test/mcp" } } as Record<string, unknown>,
};

function hookFor(
  store: ReturnType<typeof createStore>,
  over: Partial<Parameters<typeof createAgyGatewayEnvHook>[0]> = {},
) {
  const log = vi.fn();
  const hook = createAgyGatewayEnvHook({
    readCredential: () => store.readCredential(),
    readSettingsOrigin: async () => PANEL,
    readHarness: () => store.readHarness(),
    now: () => NOW,
    log,
    ...over,
  });
  return { hook, log };
}

describe("agyGatewayUrlFor", () => {
  const input = (over: Partial<Parameters<typeof agyGatewayUrlFor>[0]> = {}) => ({
    provider: "antigravity",
    credential: credential(),
    settingsOrigin: PANEL as string | null,
    harness: harness() as ReturnType<typeof harness> | null,
    nowMs: NOW,
    ...over,
  });

  it("builds the content of the URL file from the record route and the current key", () => {
    expect(agyGatewayUrlFor(input())).toBe(`${PROXY}/antigravity/default/${KEY}`);
  });

  it("accepts a partial agy entry after only the MCP step failed", () => {
    const partial = harness(KEY, { state: "partial", error: "write_failed" });
    expect(agyGatewayUrlFor(input({ harness: partial }))).toBe(`${PROXY}/antigravity/default/${KEY}`);
  });

  const refused: Array<[string, Partial<Parameters<typeof agyGatewayUrlFor>[0]>]> = [
    ["other provider", { provider: "claude" }],
    ["no credential", { credential: null }],
    ["expired", { credential: credential(KEY, { expiresAt: new Date(NOW).toISOString() }) }],
    ["bad expiry", { credential: credential(KEY, { expiresAt: "soon" }) }],
    ["origin mismatch", { settingsOrigin: "https://other.example.net" }],
    ["no saved origin", { settingsOrigin: null }],
    ["no record", { harness: null }],
    ["record of an older key", { harness: harness(KEY2) }],
    ["record for another instance", { harness: harness(KEY, {}, { instanceId: "other" }) }],
    ["removal pending", { harness: harness(KEY, {}, { removalPending: true }) }],
    ["setup error", { harness: harness(KEY, {}, { error: "no_proxy" }) }],
    ["no agy entry", { harness: harness(KEY, null) }],
    ["agy failed", { harness: harness(KEY, { state: "failed", error: "installer_failed" }) }],
    ["agy partial, installer not reached", { harness: harness(KEY, { state: "partial" }) }],
  ];
  it.each(refused)("gives nothing: %s", (_name, over) => {
    expect(agyGatewayUrlFor(input(over))).toBeUndefined();
  });
});

describe("agent open hook for the gateway URL", () => {
  it("sets the current key for antigravity, keeps the other env and the rest of the request", async () => {
    const store = createStore(dir);
    await store.writeCredential(credential());
    await store.writeHarness(harness());
    const before = structuredClone(request);
    const result = await hookFor(store).hook({ request });
    expect(result?.env).toEqual({ KEEP: "1", [AGY_GATEWAY_ENV]: `${PROXY}/antigravity/default/${KEY}` });
    expect(result).toEqual({ ...before, env: { KEEP: "1", [AGY_GATEWAY_ENV]: `${PROXY}/antigravity/default/${KEY}` } });
    expect(result?.mcpServers).toEqual(before.mcpServers);
    expect(request).toEqual(before);
  });

  it("keeps a value the user set, also one without memory", async () => {
    const store = createStore(dir);
    await store.writeCredential(credential());
    await store.writeHarness(harness());
    for (const own of [`${PROXY}/antigravity/default/memory-off`, "https://own.example.net/x"]) {
      const asked = { ...request, env: { ...request.env, [AGY_GATEWAY_ENV]: own } };
      expect(await hookFor(store).hook({ request: asked })).toBeUndefined();
    }
  });

  it("replaces an empty value", async () => {
    const store = createStore(dir);
    await store.writeCredential(credential());
    await store.writeHarness(harness());
    const asked = { ...request, env: { ...request.env, [AGY_GATEWAY_ENV]: "" } };
    expect((await hookFor(store).hook({ request: asked }))?.env[AGY_GATEWAY_ENV]).toBe(
      `${PROXY}/antigravity/default/${KEY}`,
    );
  });

  it.each(["claude", "codex", "omp", "opencode", "gemini"])("does not touch %s", async (provider) => {
    const store = createStore(dir);
    await store.writeCredential(credential());
    await store.writeHarness(harness());
    expect(await hookFor(store).hook({ request: { ...request, provider } })).toBeUndefined();
  });

  it("changes the value after a log out and a new login", async () => {
    const store = createStore(dir);
    await store.writeCredential(credential());
    await store.writeHarness(harness());
    const { hook } = hookFor(store);
    expect((await hook({ request }))?.env[AGY_GATEWAY_ENV]).toBe(`${PROXY}/antigravity/default/${KEY}`);
    await store.deleteCredential();
    await store.deleteHarness();
    expect(await hook({ request })).toBeUndefined();
    // A new login before the setup wrote its record: the record of no key gives nothing.
    await store.writeCredential(credential(KEY2));
    expect(await hook({ request })).toBeUndefined();
    await store.writeHarness(harness(KEY2));
    expect((await hook({ request }))?.env[AGY_GATEWAY_ENV]).toBe(`${PROXY}/antigravity/default/${KEY2}`);
  });

  it("gives nothing when the record is of the old key, expired, or the address changed", async () => {
    const store = createStore(dir);
    await store.writeCredential(credential(KEY2));
    await store.writeHarness(harness(KEY));
    expect(await hookFor(store).hook({ request })).toBeUndefined();
    await store.writeHarness(harness(KEY2));
    expect(await hookFor(store, { now: () => NOW + 2 * DAY }).hook({ request })).toBeUndefined();
    const moved = hookFor(store, { readSettingsOrigin: async () => "https://x.example.net" });
    expect(await moved.hook({ request })).toBeUndefined();
  });

  it("returns undefined and logs no value when a read fails", async () => {
    const store = createStore(dir);
    const { hook, log } = hookFor(store, {
      readHarness: async () => {
        throw new SyntaxError(`bad json near ${KEY}`);
      },
      readCredential: async () => credential(),
    });
    expect(await hook({ request })).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("SyntaxError");
    expect(log.mock.calls[0]?.[0]).not.toContain(KEY);
  });

  it("logs nothing that holds the key or the URL, on success or on a corrupt record", async () => {
    const store = createStore(dir);
    await store.writeCredential(credential());
    await store.writeHarness(harness());
    const logs: string[] = [];
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    for (const spy of spies) spy.mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")));
    try {
      const { hook } = hookFor(store, { log: (message) => logs.push(message) });
      expect(await hook({ request })).toBeDefined();
      await store.writeHarness({ ...harness(), keyDigest: "not-a-digest" } as HarnessFile);
      expect(await hook({ request })).toBeUndefined();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain("/antigravity/default");
  });
});

describe("combined open handler", () => {
  const mcpCredential = credential();
  async function combined() {
    const store = createStore(dir);
    await store.writeCredential(mcpCredential);
    await store.writeHarness(harness());
    const attach = createMcpAttachHook({
      readEnabled: async () => true,
      readSettingsOrigin: async () => PANEL,
      readCredential: () => store.readCredential(),
      now: () => NOW,
      log: () => undefined,
    });
    return chainOpenSteps(attach, hookFor(store).hook);
  }

  it("gives claude only the MCP entry", async () => {
    const result = await (await combined())({ request: { ...request, provider: "claude" } });
    expect(Object.keys(result?.mcpServers ?? {}).sort()).toEqual(["agent-memory", "saved"]);
    expect(result?.env).toEqual({ KEEP: "1" });
  });

  it("gives antigravity only the env", async () => {
    const result = await (await combined())({ request });
    expect(result?.env[AGY_GATEWAY_ENV]).toBe(`${PROXY}/antigravity/default/${KEY}`);
    expect(result?.mcpServers).toEqual(request.mcpServers);
  });

  it("changes nothing for a provider that neither step serves", async () => {
    expect(await (await combined())({ request: { ...request, provider: "opencode" } })).toBeUndefined();
  });

  it("keeps the result of the first step when the second changes nothing", async () => {
    const mark = (tag: string): Parameters<typeof chainOpenSteps>[0] => async ({ request: r }) => ({
      ...r,
      env: { ...r.env, TAG: `${r.env.TAG ?? ""}${tag}` },
    });
    const none: Parameters<typeof chainOpenSteps>[0] = async () => undefined;
    expect((await chainOpenSteps(mark("a"), none)({ request }))?.env.TAG).toBe("a");
    expect((await chainOpenSteps(none, mark("b"))({ request }))?.env.TAG).toBe("b");
    expect((await chainOpenSteps(mark("a"), mark("b"))({ request }))?.env.TAG).toBe("ab");
  });
});
