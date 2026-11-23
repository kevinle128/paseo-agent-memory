import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarnessSetup, type HarnessSetupDeps } from "../server/harness-setup";
import type { Paths } from "../server/harness-paths";
import type { InstallerResult, InstallerRun } from "../server/hooks-installer";
import { createStore, type CredentialFile } from "../server/store";
import type { HarnessId } from "../shared/harness";

const KEY = "fake-device-key-0001";
const PANEL = "https://panel.example.net";
const PROXY = "https://proxy.example.net:8097";
const NOW = Date.UTC(2026, 10, 21, 5, 0, 0);

const credential = (extra: Partial<CredentialFile> = {}): CredentialFile => ({
  version: 1,
  origin: PANEL,
  instanceId: "default",
  installId: "install-0001",
  keyId: "keyid-0001",
  key: KEY,
  expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
  account: { userId: "u1", username: "an" },
  teams: [],
  deviceName: "d",
  savedAt: new Date(NOW).toISOString(),
  ...extra,
});

const CLAUDE_SETTINGS = `${JSON.stringify({ model: "opus", env: { FOO: "1" } }, null, 2)}\n`;
const CODEX_CONFIG = 'model = "gpt-5"\n\n[tui]\nnotifications = true\n';
const OMP_MODELS = 'providers:\n  mine:\n    baseUrl: "https://api.example.com/v1"\n    apiKey: MINE\n';

let home: string;
let dataDir: string;
let paths: Paths;
let installs: Array<{ args: string[]; key?: string }>;
let installFails: (run: InstallerRun) => boolean;
let hold: Promise<void> | null;
let proxyAnswer: unknown;
let modelsAnswer: unknown;

const claudeFile = () => join(home, ".claude", "settings.json");
const codexFile = () => join(home, ".codex", "config.toml");
const ompFile = () => join(home, ".omp", "agent", "models.yml");
const agyMcpFile = () => join(home, ".gemini", "config", "mcp_config.json");
const gatewayFile = () => join(home, ".agent-memory", "antigravity.url");

function fakeFetch(): typeof fetch {
  return (async (url: string) => {
    if (url.endsWith("/api/v1/meta/instances")) {
      return new Response(JSON.stringify(proxyAnswer), { status: 200 });
    }
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify(modelsAnswer), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

// Stands in for the Agent-Memory installer: it records the call and leaves the marker files the real one leaves.
async function fakeInstaller(run: InstallerRun): Promise<InstallerResult> {
  if (hold) await hold;
  installs.push({ args: run.args, key: run.key });
  if (installFails(run)) return { ok: false, reason: "exit", exitCode: 1 };
  const client = run.args[run.args.indexOf("--client") + 1];
  const marker = join(home, ".agent-memory", `hook-${client}`);
  if (run.args.includes("--uninstall")) {
    await rm(marker, { force: true });
    if (client === "antigravity") await rm(gatewayFile(), { force: true });
    return { ok: true, exitCode: 0 };
  }
  await mkdir(join(home, ".agent-memory"), { recursive: true });
  await writeFile(marker, "hook");
  if (client === "antigravity") {
    await writeFile(gatewayFile(), `${run.args[run.args.indexOf("--base-url") + 1]}/${run.key}\n`);
  }
  return { ok: true, exitCode: 0 };
}

function build(detected: HarnessId[] = ["claude", "codex", "omp", "agy"], extra: Partial<HarnessSetupDeps> = {}) {
  const store = createStore(dataDir);
  const setup = createHarnessSetup({
    store,
    paths,
    detect: async () => detected,
    runInstaller: fakeInstaller,
    now: () => NOW,
    signal: new AbortController().signal,
    fetch: fakeFetch(),
    ...extra,
  });
  return { store, setup };
}

const settled = (setup: ReturnType<typeof build>["setup"]) =>
  vi.waitFor(
    () => {
      const view = setup.view().setup;
      expect(view).toBeDefined();
      expect(view?.running).toBeFalsy();
    },
    { timeout: 5000 },
  );

async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.name.includes(".agent-memory-backup-")) {
        out[relative(home, full)] = await readFile(full, "utf8");
      }
    }
  };
  await walk(home);
  return out;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pam-setup-home-"));
  dataDir = await mkdtemp(join(tmpdir(), "pam-setup-data-"));
  paths = { home, shell: "/bin/zsh" };
  installs = [];
  installFails = () => false;
  hold = null;
  proxyAnswer = { instances: [{ instance_id: "default", proxy_endpoint: PROXY }] };
  modelsAnswer = {
    data: [
      { id: "claude-x", source: "pool", format: "anthropic-messages" },
      { id: "gpt-x", source: "pool", format: "openai-responses" },
      { id: "deepseek-y", source: "pool", format: "openai-chat" },
      { id: "no-source", source: "", format: "openai-chat" },
      { id: "no-fields" },
    ],
  };
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".omp", "agent"), { recursive: true });
  await writeFile(claudeFile(), CLAUDE_SETTINGS);
  await writeFile(codexFile(), CODEX_CONFIG);
  await writeFile(ompFile(), OMP_MODELS);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe("configure", () => {
  it("sets up every detected client and records it, without the key", async () => {
    const { setup, store } = build();
    setup.configure(credential());
    await settled(setup);

    const claude = JSON.parse(await readFile(claudeFile(), "utf8"));
    expect(claude.env).toMatchObject({
      FOO: "1",
      ANTHROPIC_BASE_URL: `${PROXY}/claude-code/default`,
      ANTHROPIC_AUTH_TOKEN: KEY,
    });
    expect(await readFile(codexFile(), "utf8")).toContain(`base_url = "${PROXY}/codex/default"`);
    const omp = await readFile(ompFile(), "utf8");
    expect(omp).toContain(`baseUrl: "${PROXY}/omp/default"`);
    expect(omp).toContain(`baseUrl: "${PROXY}/omp/default/v1"`);
    expect(omp).toContain("memory-anthropic:");
    expect(omp).toContain("memory-responses:");
    expect(omp).toContain("memory-chat:");
    expect(omp).not.toContain("no-source");
    expect(omp).not.toContain("no-fields");

    expect(setup.view().setup?.harnesses).toEqual([
      { id: "claude", state: "configured" },
      { id: "codex", state: "configured" },
      { id: "omp", state: "configured" },
      { id: "agy", state: "configured" },
    ]);
    expect(installs.map((call) => call.args)).toEqual([
      ["--client", "claude-code", "--base-url", `${PROXY}/claude-code/default`],
      ["--client", "codex", "--base-url", `${PROXY}/codex/default`],
      ["--client", "omp", "--base-url", `${PROXY}/omp/default`],
      ["--client", "antigravity", "--base-url", `${PROXY}/antigravity/default`],
    ]);
    // The key reaches only the antigravity installer, and only through its environment.
    expect(installs.filter((call) => call.key).map((call) => call.args[1])).toEqual(["antigravity"]);
    expect(installs.every((call) => !call.args.some((arg) => arg.includes(KEY)))).toBe(true);

    const record = await readFile(join(dataDir, "harness.json"), "utf8");
    expect(record).not.toContain(KEY);
    expect(await store.readHarness()).toMatchObject({ keyId: "keyid-0001", proxyOrigin: PROXY });
  });

  it("adds the agent-memory MCP server to the agy config with both headers and removes only it at log out", async () => {
    const mcpBefore = JSON.stringify({ mcpServers: { fs: { disabled: false, serverUrl: "https://fs.example.net/mcp" } } });
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(agyMcpFile(), mcpBefore);
    const { setup } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);

    const added = JSON.parse(await readFile(agyMcpFile(), "utf8")).mcpServers;
    expect(added.fs.serverUrl).toBe("https://fs.example.net/mcp");
    expect(added["agent-memory"].headers).toEqual({ "x-tdai-service-id": "default", "x-tdai-user-key": KEY });
    expect(added["agent-memory"].serverUrl).toMatch(/\/api\/v1\/mcp$/);
    expect(setup.view().setup?.harnesses).toEqual([{ id: "agy", state: "configured" }]);
    expect(await readFile(join(dataDir, "harness.json"), "utf8")).not.toContain(KEY);

    await (await setup.beginRemoval()).done;
    expect(JSON.parse(await readFile(agyMcpFile(), "utf8"))).toEqual(JSON.parse(mcpBefore));
  });

  it("reports agy partial when its MCP file cannot be edited, and still installs the hook", async () => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(agyMcpFile(), "{broken");
    const { setup } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses).toEqual([
      {
        id: "agy",
        state: "partial",
        error: "settings_invalid",
        failures: [{ step: "mcp", error: "settings_invalid" }],
      },
    ]);
    expect(await readFile(agyMcpFile(), "utf8")).toBe("{broken");
    expect(installs.map((call) => call.args[1])).toEqual(["antigravity"]);
  });

  it("keeps a pre-existing empty agy MCP file at log out, and deletes a file the plugin created", async () => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(agyMcpFile(), "{}");
    const first = build(["agy"]);
    first.setup.configure(credential());
    await settled(first.setup);
    await (await first.setup.beginRemoval()).done;
    expect(JSON.parse(await readFile(agyMcpFile(), "utf8")).mcpServers ?? {}).toEqual({});

    await rm(agyMcpFile());
    const second = build(["agy"]);
    second.setup.configure(credential());
    await settled(second.setup);
    await (await second.setup.beginRemoval()).done;
    await expect(stat(agyMcpFile())).rejects.toThrow();
  });

  it("still deletes the agy MCP file it created when a new key is set up over the old one", async () => {
    const { setup, store } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);
    setup.configure(credential({ keyId: "keyid-0002", key: "fake-device-key-0002" }));
    // The second setup is queued, so the view still shows the first one until it starts: wait for the new key.
    await vi.waitFor(
      async () => {
        expect((await store.readHarness())?.keyId).toBe("keyid-0002");
        expect(setup.view().setup?.running).toBeFalsy();
        expect(await readFile(agyMcpFile(), "utf8")).toContain("fake-device-key-0002");
      },
      { timeout: 5000 },
    );
    await (await setup.beginRemoval()).done;
    await expect(stat(agyMcpFile())).rejects.toThrow();
  });

  it("leaves an agent-memory entry of the user alone at setup and at log out, with no false 'kept' report", async () => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    const own = JSON.stringify({ mcpServers: { "agent-memory": { serverUrl: "https://own.example.net/other" } } });
    await writeFile(agyMcpFile(), own);
    const { setup } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses).toEqual([
      {
        id: "agy",
        state: "partial",
        error: "own_provider",
        failures: [{ step: "mcp", error: "own_provider" }],
      },
    ]);
    await (await setup.beginRemoval()).done;
    expect(await readFile(agyMcpFile(), "utf8")).toBe(own);
    expect(setup.view().removal).toBeUndefined();
    expect(await snapshot()).not.toHaveProperty([join(".agent-memory", "antigravity.url")]);
  });

  it("records agy before the installer runs, also when the MCP step fails", async () => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(agyMcpFile(), "{broken");
    let recorded: unknown;
    const { setup, store } = build(["agy"], {
      runInstaller: async (run) => {
        if (!run.args.includes("--uninstall")) recorded = await store.readHarness();
        return fakeInstaller(run);
      },
    });
    setup.configure(credential());
    await settled(setup);
    expect(recorded).toMatchObject({ harnesses: [{ id: "agy", state: "partial" }] });
  });

  it("still removes the URL file and the hook when the MCP file turned invalid, and reports the failure", async () => {
    const { setup, store } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);
    await writeFile(agyMcpFile(), "{broken");
    installs.length = 0;

    await (await setup.beginRemoval()).done;

    await expect(stat(gatewayFile())).rejects.toThrow();
    expect(installs.map((call) => call.args)).toEqual([["--uninstall", "--client", "antigravity"]]);
    expect(setup.view().removal).toEqual([{ id: "agy", result: "failed" }]);
    expect(await readFile(agyMcpFile(), "utf8")).toBe("{broken");
    expect(await store.readHarness()).toBeNull();
  });

  it("writes nothing when the Panel gives no proxy address", async () => {
    proxyAnswer = { instances: [{ instance_id: "default" }] };
    const { setup } = build();
    const before = await snapshot();
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup).toMatchObject({ error: "no_proxy", harnesses: [] });
    expect(installs).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  it("writes nothing for a key that would break a file", async () => {
    const { setup } = build();
    const before = await snapshot();
    setup.configure(credential({ key: 'bad"key\nwith-quote' }));
    await settled(setup);
    expect(setup.view().setup).toMatchObject({ error: "bad_key" });
    expect(await snapshot()).toEqual(before);
  });

  it("reports an empty list when no supported client is installed", async () => {
    const { setup } = build([]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses).toEqual([]);
    expect(installs).toHaveLength(0);
  });

  it("marks a client failed, and runs no installer for it, when its file cannot be edited", async () => {
    await writeFile(claudeFile(), "{broken");
    await writeFile(codexFile(), 'profile = "work"\n');
    modelsAnswer = { data: [] };
    const { setup } = build();
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses).toEqual([
      { id: "claude", state: "failed", error: "settings_invalid", failures: [{ step: "config", error: "settings_invalid" }] },
      { id: "codex", state: "failed", error: "codex_profile", failures: [{ step: "config", error: "codex_profile" }] },
      { id: "omp", state: "failed", error: "no_models", failures: [{ step: "config", error: "no_models" }] },
      { id: "agy", state: "configured" },
    ]);
    expect(await readFile(claudeFile(), "utf8")).toBe("{broken");
    expect(installs.map((call) => call.args[1])).toEqual(["antigravity"]);
  });

  it("keeps the provider and reports a partial setup when only the hook fails", async () => {
    installFails = (run) => run.args.includes("codex");
    const { setup } = build(["codex"]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses).toEqual([
      {
        id: "codex",
        state: "partial",
        error: "installer_failed",
        failures: [{ step: "hook", error: "installer_failed", reason: "exit", exitCode: 1, output: [] }],
      },
    ]);
    expect(await readFile(codexFile(), "utf8")).toContain("team-proxy");
  });

  it("marks antigravity failed when its installer fails, because the installer is its only step", async () => {
    installFails = () => true;
    const { setup } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses).toEqual([
      {
        id: "agy",
        state: "failed",
        error: "installer_failed",
        failures: [{ step: "hook", error: "installer_failed", reason: "exit", exitCode: 1, output: [] }],
      },
    ]);
  });

  it("makes no file for a client that was not detected", async () => {
    await rm(join(home, ".omp"), { recursive: true });
    const { setup } = build(["claude"]);
    setup.configure(credential());
    await settled(setup);
    await expect(stat(join(home, ".omp"))).rejects.toThrow();
  });
});

describe("removeAll", () => {
  it("leaves every file as it was before the setup", async () => {
    const before = await snapshot();
    const { setup, store } = build();
    setup.configure(credential());
    await settled(setup);
    expect(await snapshot()).not.toEqual(before);
    installs.length = 0;

    await (await setup.beginRemoval()).done;

    expect(await snapshot()).toEqual(before);
    expect(await store.readHarness()).toBeNull();
    expect(setup.view()).toEqual({});
    expect(installs.map((call) => call.args)).toEqual([
      ["--uninstall", "--client", "claude-code"],
      ["--uninstall", "--client", "codex"],
      ["--uninstall", "--client", "omp"],
      ["--uninstall", "--client", "antigravity"],
    ]);
    expect(installs.every((call) => call.key === undefined)).toBe(true);
  });

  it("works after a restart, from the record on disk", async () => {
    const before = await snapshot();
    const first = build();
    first.setup.configure(credential());
    await settled(first.setup);

    const second = build();
    await second.store.writeCredential(credential());
    await second.setup.init();
    expect(second.setup.view().setup?.harnesses).toHaveLength(4);
    await (await second.setup.beginRemoval()).done;
    expect(await snapshot()).toEqual(before);
  });

  it("keeps an entry the user changed, reports it, and still clears the record", async () => {
    const { setup, store } = build();
    setup.configure(credential());
    await settled(setup);

    await writeFile(claudeFile(), (await readFile(claudeFile(), "utf8")).replace(KEY, "user-own-token"));
    await writeFile(gatewayFile(), "https://elsewhere.example.net/gw\n");
    installs.length = 0;

    await (await setup.beginRemoval()).done;

    expect(JSON.parse(await readFile(claudeFile(), "utf8")).env).toEqual({
      FOO: "1",
      ANTHROPIC_AUTH_TOKEN: "user-own-token",
    });
    expect(await readFile(gatewayFile(), "utf8")).toBe("https://elsewhere.example.net/gw\n");
    expect(setup.view().removal).toEqual([
      { id: "claude", result: "kept" },
      { id: "agy", result: "kept" },
    ]);
    expect(await readFile(codexFile(), "utf8")).toBe(CODEX_CONFIG);
    expect(await store.readHarness()).toBeNull();
    // The antigravity uninstall would delete the edited URL file, so it was not run.
    expect(installs.some((call) => call.args.includes("antigravity"))).toBe(false);
  });

  it("reports a hook that cannot be removed and still removes the rest and clears the record", async () => {
    const { setup, store } = build(["claude", "codex"]);
    setup.configure(credential());
    await settled(setup);
    installFails = (run) => run.args.includes("--uninstall") && run.args.includes("codex");

    await (await setup.beginRemoval()).done;

    expect(setup.view().removal).toEqual([{ id: "codex", result: "failed" }]);
    expect(await readFile(codexFile(), "utf8")).toBe(CODEX_CONFIG);
    expect(await store.readHarness()).toBeNull();
  });

  it("does nothing when nothing was set up", async () => {
    const { setup } = build();
    await (await setup.beginRemoval()).done;
    expect(installs).toHaveLength(0);
    expect(setup.view()).toEqual({});
  });

  it("waits for a setup that is still running", async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = await snapshot();
    const { setup } = build(["claude"]);
    setup.configure(credential());
    await vi.waitFor(() => expect(setup.view().setup?.running).toBe(true), { timeout: 5000 });
    let removed = false;
    const removal = setup.beginRemoval().then(({ done }) => done).then(() => {
      removed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(removed).toBe(false);
    release();
    await removal;
    expect(await snapshot()).toEqual(before);
  });

  it("sets up again after a log out and a new login", async () => {
    const { setup } = build(["claude", "codex"]);
    setup.configure(credential());
    await settled(setup);
    await (await setup.beginRemoval()).done;
    expect(setup.view()).toEqual({});

    setup.configure(credential({ key: "fake-device-key-0002", keyId: "keyid-0002" }));
    await settled(setup);
    const claude = JSON.parse(await readFile(claudeFile(), "utf8"));
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe("fake-device-key-0002");
    expect(setup.view().setup?.harnesses.map((item) => item.state)).toEqual(["configured", "configured"]);
  });
});

describe("a tool that already has its own provider", () => {
  it("is skipped and reported as own_provider, and its files and hooks stay untouched", async () => {
    const ownClaude = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://llm.example.org" } })}\n`;
    const ownCodex = 'model_provider = "openai"\n';
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(claudeFile(), ownClaude);
    await writeFile(codexFile(), ownCodex);
    const { setup } = build(["claude", "codex"]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses).toEqual([
      { id: "claude", state: "failed", error: "own_provider", failures: [{ step: "config", error: "own_provider" }] },
      { id: "codex", state: "failed", error: "own_provider", failures: [{ step: "config", error: "own_provider" }] },
    ]);
    expect(await readFile(claudeFile(), "utf8")).toBe(ownClaude);
    expect(await readFile(codexFile(), "utf8")).toBe(ownCodex);
    expect(installs).toHaveLength(0);
  });

  it("replaces an Agent-Memory setup that an earlier key left", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      claudeFile(),
      `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${PROXY}/claude-code/default`, ANTHROPIC_AUTH_TOKEN: "old-token" } })}\n`,
    );
    const { setup } = build(["claude"]);
    setup.configure(credential());
    await settled(setup);
    expect(JSON.parse(await readFile(claudeFile(), "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  });
});

describe("removal in the background", () => {
  it("reports removing while it runs, ends at the deadline", async () => {
    const { setup, store } = build(["claude", "codex"], {
      removalDeadlineMs: 150,
      runInstaller: async (run) => {
        if (!run.args.includes("--uninstall")) return fakeInstaller(run);
        // A stuck installer ends only when the deadline aborts it.
        await new Promise<void>((resolve) => run.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false, reason: "timeout" };
      },
    });
    setup.configure(credential());
    await settled(setup);

    const { done } = await setup.beginRemoval();
    expect(setup.view().removing).toBe(true);
    await done;

    expect(setup.view().removing).toBeUndefined();
    expect(setup.view().removal).toEqual([
      { id: "claude", result: "failed" },
      { id: "codex", result: "failed" },
    ]);
    expect(await store.readHarness()).toBeNull();
    const names = await readdir(join(home, ".claude"));
    // Only the setup's backup of the user's own file stays; the removal's backups held the key.
    expect(names.filter((name) => name.includes("agent-memory-backup"))).toHaveLength(1);
  });
});

describe("a removal that is interrupted", () => {
  const stuckUninstall = (started: () => void): HarnessSetupDeps["runInstaller"] =>
    async (run) => {
      if (!run.args.includes("--uninstall")) return fakeInstaller(run);
      started();
      await new Promise<void>((resolve) => run.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, reason: "timeout" };
    };

  it("saves a marker without the key before the call returns, and the record never holds the key", async () => {
    const stopper = new AbortController();
    let started: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { setup } = build(["claude"], { signal: stopper.signal, runInstaller: stuckUninstall(started) });
    setup.configure(credential());
    await settled(setup);
    const { done } = await setup.beginRemoval();
    await begun;
    const saved = await readFile(join(dataDir, "harness.json"), "utf8");
    expect(JSON.parse(saved).removalPending).toBe(true);
    expect(saved).not.toContain(KEY);
    stopper.abort();
    await done;
  });

  it("resumes after a restart, and the old key is not needed", async () => {
    const before = await snapshot();
    const first = build(["claude", "codex", "omp", "agy"]);
    first.setup.configure(credential());
    await settled(first.setup);
    // The daemon dies after the marker is saved and before any file is cleaned.
    await first.store.writeHarness({ ...(await first.store.readHarness())!, removalPending: true });

    const second = build();
    await second.setup.init();
    expect(second.setup.view().removing).toBe(true);
    await vi.waitFor(() => expect(second.setup.view().removing).toBeUndefined(), { timeout: 5000 });
    expect(await snapshot()).toEqual(before);
    expect(await second.store.readHarness()).toBeNull();
  });

  it("does not resume a record without the marker", async () => {
    const first = build(["claude"]);
    first.setup.configure(credential());
    await settled(first.setup);
    const second = build();
    await second.store.writeCredential(credential());
    await second.setup.init();
    expect(second.setup.view().removing).toBeUndefined();
    expect(second.setup.view().setup?.harnesses).toHaveLength(1);
  });

  it("resumes a record whose credential is gone, as the log out already went through", async () => {
    const before = await snapshot();
    const first = build(["claude", "codex"]);
    first.setup.configure(credential());
    await settled(first.setup);

    const second = build();
    await second.setup.init();
    expect(second.setup.resumedRemovalKeyId()).toBe("keyid-0001");
    await vi.waitFor(() => expect(second.setup.view().removing).toBeUndefined(), { timeout: 5000 });
    expect(await snapshot()).toEqual(before);
    expect(await second.store.readHarness()).toBeNull();
  });

  it("names the key of a resumed removal while its credential is still stored", async () => {
    const first = build(["claude"]);
    first.setup.configure(credential());
    await settled(first.setup);
    await first.store.writeHarness({ ...(await first.store.readHarness())!, removalPending: true });
    const second = build();
    await second.store.writeCredential(credential());
    await second.setup.init();
    expect(second.setup.resumedRemovalKeyId()).toBe("keyid-0001");
    await vi.waitFor(() => expect(second.setup.view().removing).toBeUndefined(), { timeout: 5000 });
  });

  it("does not start the removal when the marker cannot be saved and the caller needs it", async () => {
    const before = await snapshot();
    const first = build(["claude"]);
    first.setup.configure(credential());
    await settled(first.setup);
    const afterSetup = await snapshot();
    const writeHarness = vi.spyOn(first.store, "writeHarness").mockRejectedValue(new Error("disk full"));
    const begun = await first.setup.beginRemoval({ requireMarker: true });
    await begun.done;
    expect(begun.marked).toBe(false);
    expect(await snapshot()).toEqual(afterSetup);
    expect(await snapshot()).not.toEqual(before);
    expect(first.setup.view().removing).toBeUndefined();

    writeHarness.mockRestore();
    const retry = await first.setup.beginRemoval({ requireMarker: true });
    await retry.done;
    expect(retry.marked).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it("saves the marker behind a setup in progress, so a commit cannot overwrite it", async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { setup, store } = build(["claude"]);
    setup.configure(credential());
    await vi.waitFor(() => expect(setup.view().setup?.running).toBe(true), { timeout: 5000 });
    const removing = setup.beginRemoval({ requireMarker: true });
    // The setup commits its record while the installer is held; the marker is written after the setup, never in between.
    release();
    hold = null;
    const begun = await removing;
    expect(begun.marked).toBe(true);
    await begun.done;
    expect(await store.readHarness()).toBeNull();
  });

  describe("a log out during a long setup", () => {
    // The install step waits for `hold` and ignores the signal, like an installer that takes minutes.
    const slowInstall = (uninstall: HarnessSetupDeps["runInstaller"]): HarnessSetupDeps["runInstaller"] =>
      async (run) => (run.args.includes("--uninstall") ? uninstall(run) : fakeInstaller(run));
    const openGate = () => {
      let release: () => void = () => undefined;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        hold = null;
      };
    };

    it("returns at once with the marker on disk, without waiting for the setup", async () => {
      const release = openGate();
      const { setup, store } = build(["claude", "codex"]);
      setup.configure(credential());
      await vi.waitFor(() => expect(setup.view().setup?.running).toBe(true), { timeout: 5000 });
      const begun = await setup.beginRemoval({ requireMarker: true });
      expect(begun.marked).toBe(true);
      expect(setup.view().setup?.running).toBe(true);
      expect(await store.readHarness()).toMatchObject({ removalPending: true });
      release();
      await begun.done;
    });

    it("removes what the stopped setup already wrote and skips the clients it never reached", async () => {
      const before = await snapshot();
      const release = openGate();
      const { setup, store } = build(["claude", "codex", "omp"]);
      setup.configure(credential());
      await vi.waitFor(() => expect(setup.view().setup?.running).toBe(true), { timeout: 5000 });
      // The claude provider is written; its installer is the step that is still running.
      expect(await readFile(claudeFile(), "utf8")).toContain(KEY);
      const begun = await setup.beginRemoval({ requireMarker: true });
      release();
      await begun.done;
      expect(installs.some((run) => run.args.includes("codex"))).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(await store.readHarness()).toBeNull();
      expect(setup.view()).toEqual({});
    });

    it("keeps the marker through every commit the stopped setup still makes", async () => {
      const release = openGate();
      const stopper = new AbortController();
      let started: () => void = () => undefined;
      const uninstalling = new Promise<void>((resolve) => {
        started = resolve;
      });
      const { setup, store } = build(["claude", "codex"], {
        signal: stopper.signal,
        runInstaller: slowInstall(async (run) => {
          started();
          await new Promise<void>((resolve) => run.signal.addEventListener("abort", () => resolve(), { once: true }));
          return { ok: false, reason: "timeout" };
        }),
      });
      setup.configure(credential());
      await vi.waitFor(() => expect(setup.view().setup?.running).toBe(true), { timeout: 5000 });
      const begun = await setup.beginRemoval({ requireMarker: true });
      release();
      // The setup commits claude after its installer ends; the removal has started only once the setup is over.
      await uninstalling;
      expect(setup.view().setup?.running).toBeFalsy();
      const saved = await store.readHarness();
      expect(saved).toMatchObject({ removalPending: true });
      expect(saved?.harnesses.map((item) => item.id)).toEqual(["claude"]);
      stopper.abort();
      await begun.done;
      expect(await store.readHarness()).toMatchObject({ removalPending: true });
    });
  });

  it("keeps the record and the marker when the plugin stops, and the next start finishes it", async () => {
    const before = await snapshot();
    const stopper = new AbortController();
    let started: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = build(["claude", "codex"], { signal: stopper.signal, runInstaller: stuckUninstall(started) });
    first.setup.configure(credential());
    await settled(first.setup);

    const { done } = await first.setup.beginRemoval();
    await begun;
    stopper.abort();
    await done;

    const kept = await first.store.readHarness();
    expect(kept).toMatchObject({ removalPending: true });
    expect(kept?.harnesses.map((item) => item.state)).toEqual(["configured", "configured"]);
    expect(first.setup.view().removal).toBeUndefined();

    const second = build();
    await second.setup.init();
    await vi.waitFor(() => expect(second.setup.view().removing).toBeUndefined(), { timeout: 5000 });
    expect(await snapshot()).toEqual(before);
    expect(await second.store.readHarness()).toBeNull();
  });

  it("leaves no copy of the key in any backup after a removal", async () => {
    const { setup } = build();
    setup.configure(credential());
    await settled(setup);
    await (await setup.beginRemoval()).done;
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (entry.name.includes("agent-memory-backup")) out.push(full);
      }
      return out;
    };
    for (const file of await walk(home)) expect(await readFile(file, "utf8")).not.toContain(KEY);
  });

  it("stays removing until the last of two overlapping removals ends, and a new login waits behind them", async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = await snapshot();
    const { setup } = build(["claude"]);
    setup.configure(credential());
    await vi.waitFor(() => expect(setup.view().setup?.running).toBe(true), { timeout: 5000 });
    // The marker waits behind the running setup, so the removals are started without waiting for them.
    const firstBegun = setup.beginRemoval();
    const secondBegun = setup.beginRemoval();
    setup.configure(credential({ key: "fake-device-key-0002", keyId: "keyid-0002" }));
    release();
    hold = null;
    const first = (await firstBegun).done;
    const second = (await secondBegun).done;
    await first;
    // The second removal is still queued behind the first, so the flag stays.
    expect(setup.view().removing).toBe(true);
    await second;
    expect(setup.view().removing).toBeUndefined();
    await settled(setup);
    // The login that came last was set up after both removals.
    expect(setup.view().setup?.harnesses).toEqual([{ id: "claude", state: "configured" }]);
    expect(JSON.parse(await readFile(claudeFile(), "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe("fake-device-key-0002");
    expect(before).not.toEqual(await snapshot());
  });
});

const idle = (setup: ReturnType<typeof build>["setup"]) =>
  vi.waitFor(() => expect(setup.view().setup?.installing).toBeFalsy(), { timeout: 5000 });

describe("hook failure details", () => {
  it("reports a spawn failure without keeping the installer's text", async () => {
    const { setup } = build(["codex"], {
      runInstaller: async () => ({ ok: false, reason: "spawn", exitCode: null }),
    });
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses).toEqual([
      {
        id: "codex",
        state: "partial",
        error: "installer_failed",
        failures: [{ step: "hook", error: "installer_failed", reason: "spawn", exitCode: null, output: [] }],
      },
    ]);
  });

  it("tells an installer that wrote nothing in this session apart from lines lost at a restart", async () => {
    const { setup } = build(["codex"], {
      runInstaller: async () => ({ ok: false, reason: "timeout", exitCode: null }),
    });
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses[0].failures?.[0]).toMatchObject({ step: "hook", output: [] });
  });

  it("keeps both the MCP failure and the hook failure for agy", async () => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(agyMcpFile(), "{broken");
    const { setup } = build(["agy"], {
      runInstaller: async () => ({ ok: false, reason: "download" }),
    });
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses[0]).toMatchObject({
      id: "agy",
      state: "failed",
      error: "settings_invalid",
      failures: [
        { step: "mcp", error: "settings_invalid" },
        { step: "hook", error: "installer_failed", reason: "download" },
      ],
    });
  });

  it("stores the failure codes and keeps the installer text only in memory", async () => {
    const sentinel = "HOOK_STDERR_SENTINEL";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { setup, store } = build(["codex"], {
      runInstaller: async () => ({
        ok: false,
        reason: "exit",
        exitCode: 1,
        output: [`${sentinel} ${KEY}`],
      }),
    });
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses[0].failures?.[0]).toMatchObject({
      step: "hook",
      output: [`${sentinel} ${KEY}`],
    });
    const disk = await readFile(join(dataDir, "harness.json"), "utf8");
    expect(disk).toContain('"failures"');
    expect(disk).not.toContain("output");
    expect(disk).not.toContain(sentinel);
    expect(disk).not.toContain(KEY);
    const logged = JSON.stringify([...errors.mock.calls, ...logs.mock.calls]);
    expect(logged).not.toContain(sentinel);
    expect(logged).not.toContain(KEY);

    await store.writeCredential(credential());
    const restarted = createHarnessSetup({
      store: createStore(dataDir),
      paths,
      detect: async () => ["codex"],
      runInstaller: fakeInstaller,
      now: () => NOW,
      signal: new AbortController().signal,
      fetch: fakeFetch(),
    });
    await restarted.init();
    const failure = restarted.view().setup?.harnesses[0].failures?.[0];
    expect(failure).toMatchObject({ step: "hook", error: "installer_failed", reason: "exit", exitCode: 1 });
    expect(failure).not.toHaveProperty("output");
  });
});

describe("install one client", () => {
  it("installs the hook for one client and keeps the other entries", async () => {
    installFails = (run) => run.args.includes("codex");
    const { setup } = build(["claude", "codex"]);
    setup.configure(credential());
    await settled(setup);
    installFails = () => false;
    const before = installs.length;
    expect(setup.install(credential(), "codex")).toBe(true);
    await vi.waitFor(() => {
      expect(setup.view().setup?.harnesses.find((item) => item.id === "codex")?.state).toBe("configured");
    });
    expect(setup.view().setup?.harnesses.find((item) => item.id === "claude")).toMatchObject({
      state: "configured",
    });
    expect(installs.slice(before).map((call) => call.args)).toEqual([
      ["--client", "codex", "--base-url", `${PROXY}/codex/default`],
    ]);
  });

  it("runs only the hook when the provider is already in place", async () => {
    installFails = (run) => run.args.includes("omp");
    let modelCalls = 0;
    const { setup } = build(["omp"], {
      fetch: (async (url: string) => {
        if (String(url).endsWith("/v1/models")) modelCalls += 1;
        return fakeFetch()(url);
      }) as typeof fetch,
    });
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses[0].state).toBe("partial");
    const callsAfterSetup = modelCalls;
    modelsAnswer = { data: [] };
    installFails = () => false;
    expect(setup.install(credential(), "omp")).toBe(true);
    await vi.waitFor(() => expect(setup.view().setup?.harnesses[0].state).toBe("configured"));
    expect(modelCalls).toBe(callsAfterSetup);
    await (await setup.beginRemoval()).done;
    expect(await readFile(ompFile(), "utf8")).not.toContain("memory-anthropic");
    expect(await readFile(ompFile(), "utf8")).not.toContain(PROXY);
  });

  it("sets up a client whose file could not be edited before", async () => {
    await writeFile(claudeFile(), "{broken");
    const { setup } = build(["claude"]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses[0].state).toBe("failed");
    await writeFile(claudeFile(), CLAUDE_SETTINGS);
    expect(setup.install(credential(), "claude")).toBe(true);
    await vi.waitFor(() => expect(setup.view().setup?.harnesses[0].state).toBe("configured"));
    expect(JSON.parse(await readFile(claudeFile(), "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  });

  it("keeps the agy MCP file the plugin created as its own on a second install", async () => {
    installFails = () => true;
    const { setup } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses[0]).toMatchObject({ state: "failed", error: "installer_failed" });
    installFails = () => false;
    expect(setup.install(credential(), "agy")).toBe(true);
    await vi.waitFor(() => expect(setup.view().setup?.harnesses[0].state).toBe("configured"));
    await (await setup.beginRemoval()).done;
    await expect(stat(agyMcpFile())).rejects.toThrow();
  });

  it("retries only the agy MCP step when the hook is already in place", async () => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(agyMcpFile(), "{broken");
    const { setup, store } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);
    expect(setup.view().setup?.harnesses[0]).toMatchObject({ state: "partial", error: "settings_invalid" });
    const before = installs.length;
    // The installer is down now: a retry that ran it again would turn agy failed.
    installFails = () => true;
    await writeFile(agyMcpFile(), "{}");
    expect(setup.install(credential(), "agy")).toBe(true);
    await vi.waitFor(() => expect(setup.view().setup?.harnesses[0].state).toBe("configured"));
    expect(installs.length).toBe(before);
    expect(JSON.parse(await readFile(agyMcpFile(), "utf8")).mcpServers["agent-memory"]).toBeDefined();
    expect((await store.readHarness())?.harnesses[0]).toMatchObject({ id: "agy", mcpWritten: true });
  });

  it("keeps agy partial with its hook in place when the MCP retry fails again", async () => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(agyMcpFile(), "{broken");
    const { setup } = build(["agy"]);
    setup.configure(credential());
    await settled(setup);
    const before = installs.length;
    expect(setup.install(credential(), "agy")).toBe(true);
    await vi.waitFor(() => expect(setup.view().setup?.installing).toBeUndefined());
    expect(installs.length).toBe(before);
    expect(setup.view().setup?.harnesses).toEqual([
      { id: "agy", state: "partial", error: "settings_invalid", failures: [{ step: "mcp", error: "settings_invalid" }] },
    ]);
  });

  it("stops an install on log out and removes what it wrote", async () => {
    const before = await snapshot();
    installFails = () => true;
    const { setup } = build(["claude"]);
    setup.configure(credential());
    await settled(setup);
    installFails = () => false;
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(setup.install(credential(), "claude")).toBe(true);
    await vi.waitFor(() => expect(setup.view().setup?.installing).toEqual(["claude"]));
    const removal = setup.beginRemoval().then(({ done }) => done);
    release();
    hold = null;
    await removal;
    expect(await snapshot()).toEqual(before);
  });

  it("refuses an install for another key, during a removal, for the same client twice, or for a client that is not detected", async () => {
    const { setup } = build(["claude"]);
    setup.configure(credential());
    await settled(setup);
    const calls = installs.length;

    expect(setup.install(credential({ key: "fake-device-key-9999", keyId: "keyid-9999" }), "claude")).toBe(true);
    await idle(setup);
    expect(setup.install(credential(), "codex")).toBe(true);
    await idle(setup);
    expect(installs).toHaveLength(calls);

    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(installs).toHaveLength(calls);
    expect(setup.install(credential(), "claude")).toBe(true);
    expect(setup.install(credential(), "claude")).toBe(false);
    expect(installs).toHaveLength(calls);
    const removal = setup.beginRemoval().then(({ done }) => done);
    expect(setup.install(credential(), "claude")).toBe(false);
    release();
    hold = null;
    await removal;
  });

  it("reports the clients that wait for an install, in order", async () => {
    installFails = () => true;
    const { setup } = build(["claude", "codex"]);
    setup.configure(credential());
    await settled(setup);
    installFails = () => false;
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(setup.install(credential(), "claude")).toBe(true);
    expect(setup.install(credential(), "codex")).toBe(true);
    expect(setup.view().setup?.installing).toEqual(["claude", "codex"]);
    release();
    hold = null;
    await idle(setup);
    expect(setup.view().setup?.harnesses.map((item) => item.state)).toEqual(["configured", "configured"]);
  });
});
