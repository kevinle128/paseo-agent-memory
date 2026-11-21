import { describe, expect, it, vi } from "vitest";
import { createMcpAttachHook, mcpServersFor, type McpAttachInput } from "../server/mcp-attach";
import { MCP_PROVIDERS, MCP_SERVER_NAME } from "../shared/constants";
import { mcpEnabled } from "../shared/view";

const NOW = Date.UTC(2026, 10, 24, 3, 0, 0);
const credential: NonNullable<McpAttachInput["credential"]> = {
  origin: "https://panel.example.test:8126",
  instanceId: "default",
  key: "fake-user-key-aaaa",
  expiresAt: new Date(NOW + 60_000).toISOString(),
};

const input = (extra: Partial<McpAttachInput> = {}): McpAttachInput => ({
  provider: "claude",
  credential,
  settingsOrigin: credential.origin,
  enabled: true,
  nowMs: NOW,
  ...extra,
});

describe("mcpServersFor", () => {
  it.each(MCP_PROVIDERS)("gives %s exactly the agent-memory entry", (provider) => {
    expect(mcpServersFor(input({ provider }))).toEqual({
      [MCP_SERVER_NAME]: {
        type: "http",
        url: "https://panel.example.test:8126/api/v1/mcp",
        headers: { "x-tdai-service-id": "default", "x-tdai-user-key": "fake-user-key-aaaa" },
      },
    });
  });

  it.each(["opencode", "copilot", "pi", "agy", "gemini", "unknown-provider", ""])(
    "gives %s nothing",
    (provider) => {
      expect(mcpServersFor(input({ provider }))).toBeUndefined();
    },
  );

  it("gives nothing when the switch is off", () => {
    expect(mcpServersFor(input({ enabled: false }))).toBeUndefined();
  });

  it("gives nothing without a credential", () => {
    expect(mcpServersFor(input({ credential: null }))).toBeUndefined();
  });

  it("gives nothing for an expired credential, at the expiry instant too", () => {
    expect(mcpServersFor(input({ nowMs: NOW + 60_000 }))).toBeUndefined();
    expect(mcpServersFor(input({ nowMs: NOW + 120_000 }))).toBeUndefined();
  });

  it("gives nothing when the expiry is not a date", () => {
    expect(mcpServersFor(input({ credential: { ...credential, expiresAt: "soon" } }))).toBeUndefined();
  });

  it("gives nothing when the saved address is not the address of the login", () => {
    expect(
      mcpServersFor(input({ settingsOrigin: "https://other.example.test:8126" })),
    ).toBeUndefined();
    expect(mcpServersFor(input({ settingsOrigin: null }))).toBeUndefined();
  });

  it("does not ask the client to load all tools at once", () => {
    const entry = mcpServersFor(input())?.[MCP_SERVER_NAME];
    expect(entry).not.toHaveProperty("alwaysLoad");
  });
});

describe("agent open hook", () => {
  const baseRequest = {
    provider: "claude",
    cwd: "/work",
    mcpServers: { saved: { type: "http" as const, url: "https://other.example.test/mcp" } },
  };

  const hookWith = (over: Partial<Parameters<typeof createMcpAttachHook>[0]> = {}) => {
    const log = vi.fn();
    const hook = createMcpAttachHook({
      readEnabled: async () => true,
      readSettingsOrigin: async () => credential.origin,
      readCredential: async () => credential,
      now: () => NOW,
      log,
      ...over,
    });
    return { hook, log };
  };

  it("keeps the entries that are already in the request", async () => {
    const { hook } = hookWith();
    const result = await hook({ request: baseRequest });
    expect(Object.keys(result?.mcpServers ?? {}).sort()).toEqual(["agent-memory", "saved"]);
    expect(result?.mcpServers.saved).toEqual(baseRequest.mcpServers.saved);
    expect(result?.cwd).toBe("/work");
  });

  it("does not change the request it was given", async () => {
    const { hook } = hookWith();
    await hook({ request: baseRequest });
    expect(Object.keys(baseRequest.mcpServers)).toEqual(["saved"]);
  });

  it("returns undefined for a provider outside the list", async () => {
    const { hook } = hookWith();
    expect(await hook({ request: { ...baseRequest, provider: "opencode" } })).toBeUndefined();
  });

  it("returns undefined when the switch is off", async () => {
    const { hook } = hookWith({ readEnabled: async () => false });
    expect(await hook({ request: baseRequest })).toBeUndefined();
  });

  it("returns undefined when the saved address changed since the login", async () => {
    const { hook } = hookWith({ readSettingsOrigin: async () => "https://other.example.test:8126" });
    expect(await hook({ request: baseRequest })).toBeUndefined();
    const unset = hookWith({ readSettingsOrigin: async () => null });
    expect(await unset.hook({ request: baseRequest })).toBeUndefined();
  });

  it("returns undefined for a missing or expired credential", async () => {
    expect(await hookWith({ readCredential: async () => null }).hook({ request: baseRequest })).toBeUndefined();
    expect(await hookWith({ now: () => NOW + 3_600_000 }).hook({ request: baseRequest })).toBeUndefined();
  });

  it("returns undefined, and does not throw, when the credential file cannot be read", async () => {
    const { hook, log } = hookWith({
      readCredential: async () => {
        throw new SyntaxError(`bad json near ${credential.key}`);
      },
    });
    expect(await hook({ request: baseRequest })).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("SyntaxError");
    expect(log.mock.calls[0]?.[0]).not.toContain(credential.key);
  });

  it("returns undefined, and does not throw, when the settings cannot be read", async () => {
    const { hook, log } = hookWith({
      readEnabled: async () => {
        throw new Error("settings unavailable");
      },
    });
    expect(await hook({ request: baseRequest })).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("never logs the key or headers on success", async () => {
    const { hook, log } = hookWith();
    await hook({ request: baseRequest });
    expect(JSON.stringify(log.mock.calls)).not.toContain(credential.key);
  });
});

describe("agent open hook with the credential store", () => {
  it("returns undefined when the credential file is corrupt", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createStore } = await import("../server/store");
    const dir = await mkdtemp(join(tmpdir(), "pam-mcp-"));
    try {
      await writeFile(join(dir, "credential.json"), "{ not json");
      const store = createStore(dir);
      const hook = createMcpAttachHook({
        readEnabled: async () => true,
        readSettingsOrigin: async () => credential.origin,
        readCredential: () => store.readCredential(),
        now: () => NOW,
        log: () => {},
      });
      const request = { provider: "claude", mcpServers: {} };
      expect(await hook({ request })).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mcpEnabled", () => {
  it("is on for a ready document that says on", () => {
    expect(mcpEnabled({ status: "ready", values: { enabled: true } })).toBe(true);
  });

  it("is off for a ready document that says off", () => {
    expect(mcpEnabled({ status: "ready", values: { enabled: false } })).toBe(false);
  });

  it("is off for an invalid or loading document and for no state", () => {
    expect(mcpEnabled({ status: "invalid" })).toBe(false);
    expect(mcpEnabled({ status: "loading" })).toBe(false);
    expect(mcpEnabled(undefined)).toBe(false);
  });
});

describe("key canary", () => {
  it("reaches the agent but the hook writes no file in the plugin data directory", async () => {
    const { mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
    const { randomBytes } = await import("node:crypto");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createStore } = await import("../server/store");
    const { ensureDataDir } = await import("../server/data-dir");
    const canary = randomBytes(16).toString("hex");
    const root = await mkdtemp(join(tmpdir(), "pam-canary-"));
    const dir = join(root, "data");
    try {
      await ensureDataDir(dir);
      const store = createStore(dir);
      await store.writeCredential({
        version: 1,
        origin: credential.origin,
        instanceId: credential.instanceId,
        installId: "install-0001",
        keyId: "keyid-0001",
        key: canary,
        expiresAt: credential.expiresAt,
        account: { userId: "u1", username: "an" },
        teams: [],
        deviceName: "test",
        savedAt: new Date(NOW).toISOString(),
      });
      const holders = async () => {
        const found: string[] = [];
        for (const name of (await readdir(dir)).sort()) {
          const text = await readFile(join(dir, name), "utf8").catch(() => "");
          if (text.includes(canary)) found.push(name);
        }
        return found;
      };
      const before = { files: (await readdir(dir)).sort(), holders: await holders() };
      const hook = createMcpAttachHook({
        readEnabled: async () => true,
        readSettingsOrigin: async () => credential.origin,
        readCredential: () => store.readCredential(),
        now: () => NOW,
        log: () => {},
      });
      const result = await hook({ request: { provider: "codex", mcpServers: {} } });
      expect(JSON.stringify(result)).toContain(canary);
      expect(before.holders).toEqual(["credential.json"]);
      expect({ files: (await readdir(dir)).sort(), holders: await holders() }).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
