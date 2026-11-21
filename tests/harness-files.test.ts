import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupFailure,
  agyMcpApply,
  agyMcpRemove,
  applyAgyMcp,
  removeAgyMcp,
  applyClaude,
  applyCodex,
  applyOmp,
  claudeApply,
  claudeRemove,
  codexApply,
  codexRemove,
  ompApply,
  ompRemove,
  removeClaude,
  removeCodex,
  removeOmp,
  keyDigest,
  type OmpProvider,
} from "../server/harness-files";

const ROUTE = "https://proxy.example.net:8097/claude-code/default";
const CODEX_ROUTE = "https://proxy.example.net:8097/codex/default";
const KEY = "fake-device-key-0001";
const DIGEST = keyDigest(KEY);
const NOW = Date.UTC(2026, 10, 21, 5, 0, 0);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pam-files-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const backups = async (name: string) =>
  (await readdir(dir)).filter((entry) => entry.startsWith(`${name}.agent-memory-backup-`));

describe("claude settings", () => {
  const original = `${JSON.stringify(
    { model: "opus", env: { FOO: "1" }, permissions: { allow: ["Bash(ls)"] } },
    null,
    2,
  )}\n`;

  it("adds the two env entries and keeps every other setting", () => {
    const next = JSON.parse(claudeApply(original, ROUTE, KEY));
    expect(next).toEqual({
      model: "opus",
      env: { FOO: "1", ANTHROPIC_BASE_URL: ROUTE, ANTHROPIC_AUTH_TOKEN: KEY },
      permissions: { allow: ["Bash(ls)"] },
    });
  });

  it("removes exactly its entries and returns the original bytes", () => {
    const applied = claudeApply(original, ROUTE, KEY);
    expect(claudeRemove(applied, ROUTE, DIGEST)).toEqual({ text: original, result: "removed" });
  });

  it("drops the env object it created, so a new file returns to {}", () => {
    const applied = claudeApply("{}\n", ROUTE, KEY);
    expect(claudeRemove(applied, ROUTE, DIGEST).text).toBe("{}\n");
  });

  it("keeps an entry the user changed and reports it", () => {
    const applied = JSON.parse(claudeApply(original, ROUTE, KEY));
    applied.env.ANTHROPIC_AUTH_TOKEN = "user-own-token";
    const out = claudeRemove(JSON.stringify(applied, null, 2), ROUTE, DIGEST);
    expect(out.result).toBe("changed");
    const left = JSON.parse(out.text);
    expect(left.env).toEqual({ FOO: "1", ANTHROPIC_AUTH_TOKEN: "user-own-token" });
  });

  it("refuses an invalid or non-object file without changing it", async () => {
    expect(() => claudeApply("{not json", ROUTE, KEY)).toThrow(SetupFailure);
    expect(() => claudeApply("[]", ROUTE, KEY)).toThrow(SetupFailure);
    expect(() => claudeApply('{"env": "x"}', ROUTE, KEY)).toThrow(SetupFailure);
    const file = join(dir, "settings.json");
    await writeFile(file, "{not json");
    await expect(applyClaude(file, ROUTE, KEY, NOW)).rejects.toMatchObject({ code: "settings_invalid" });
    expect(await readFile(file, "utf8")).toBe("{not json");
    expect(await backups("settings.json")).toHaveLength(0);
  });

  it("backs the file up byte for byte before it writes, and writes a new file with mode 0600", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, original);
    await applyClaude(file, ROUTE, KEY, NOW);
    const [backup] = await backups("settings.json");
    expect(backup).toMatch(/\.agent-memory-backup-20261121T050000Z$/);
    expect(await readFile(join(dir, backup), "utf8")).toBe(original);

    const created = join(dir, "sub", "settings.json");
    await applyClaude(created, ROUTE, KEY, NOW);
    expect((await stat(created)).mode & 0o777).toBe(0o600);
    expect(await removeClaude(created, ROUTE, DIGEST, NOW)).toBe("removed");
    expect(await readFile(created, "utf8")).toBe("{}\n");
  });

  it("writes through a symlink instead of replacing it", async () => {
    const target = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(target, original);
    await symlink(target, link);
    await applyClaude(link, ROUTE, KEY, NOW);
    expect((await stat(link)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  });

  it("does not change a file that already holds the entries", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, claudeApply(original, ROUTE, KEY));
    await applyClaude(file, ROUTE, KEY, NOW);
    expect(await backups("settings.json")).toHaveLength(0);
  });
});

describe("codex config", () => {
  const original = [
    'model = "gpt-5"',
    "",
    "[projects.\"/work\"]",
    'trust_level = "trusted"',
    "",
    "[tui]",
    "notifications = true",
    "",
  ].join("\n");

  it("sets the provider at the top level and adds the provider table at the end", () => {
    const next = codexApply(original, CODEX_ROUTE, KEY);
    expect(next.startsWith('model_provider = "team-proxy"\nmodel = "gpt-5"\n')).toBe(true);
    expect(next).toContain(`[model_providers.team-proxy]`);
    expect(next).toContain(`base_url = "${CODEX_ROUTE}"`);
    expect(next).toContain(`experimental_bearer_token = "${KEY}"`);
    expect(next).toContain('wire_api = "responses"');
    // Everything of the user is still there, in order.
    expect(next).toContain('[projects."/work"]\ntrust_level = "trusted"\n\n[tui]\nnotifications = true\n');
  });

  it("returns the original bytes after the removal", () => {
    const applied = codexApply(original, CODEX_ROUTE, KEY);
    expect(codexRemove(applied, CODEX_ROUTE, DIGEST)).toEqual({ text: original, result: "removed" });
  });

  it("returns to an empty file for a new file", () => {
    expect(codexRemove(codexApply(null, CODEX_ROUTE, KEY), CODEX_ROUTE, DIGEST).text).toBe("");
  });

  it("replaces an earlier team-proxy table and a different model_provider, once", () => {
    const earlier = [
      'model_provider = "team-proxy"',
      "",
      "[model_providers.team-proxy]",
      'base_url = "https://proxy.example.net:8097/codex/old"',
      'experimental_bearer_token = "old-key"',
      "",
      "[model_providers.team-proxy.http_headers]",
      'x-extra = "1"',
      "",
      "[tui]",
      "notifications = true",
      "",
    ].join("\n");
    const next = codexApply(earlier, CODEX_ROUTE, KEY);
    expect(next.match(/model_provider =/g)).toHaveLength(1);
    expect(next.match(/\[model_providers\.team-proxy\]/g)).toHaveLength(1);
    expect(next).not.toContain("old-key");
    expect(next).not.toContain("http_headers");
    expect(next).toContain("[tui]\nnotifications = true\n");
  });

  it("refuses a config with a top-level profile", async () => {
    const file = join(dir, "config.toml");
    await writeFile(file, 'profile = "work"\n');
    await expect(applyCodex(file, CODEX_ROUTE, KEY, NOW)).rejects.toMatchObject({ code: "codex_profile" });
    expect(await readFile(file, "utf8")).toBe('profile = "work"\n');
  });

  it("does not touch model_provider keys that sit inside a table", () => {
    const text = '[profiles.work]\nmodel_provider = "other"\n';
    const next = codexApply(text, CODEX_ROUTE, KEY);
    expect(next).toContain('[profiles.work]\nmodel_provider = "other"');
  });

  it("keeps a provider the user changed, together with the line that selects it", () => {
    const applied = codexApply(original, CODEX_ROUTE, KEY).replace(
      `experimental_bearer_token = "${KEY}"`,
      'experimental_bearer_token = "user-token"',
    );
    const out = codexRemove(applied, CODEX_ROUTE, DIGEST);
    expect(out.result).toBe("changed");
    expect(out.text).toBe(applied);
  });

  it("keeps the hook blocks the installer wrote and works with CRLF files", () => {
    const withHooks = `# >>> agent-memory hooks >>>\n[[hooks.SessionStart]]\n# <<< agent-memory hooks <<<\n${original}`;
    const applied = codexApply(withHooks, CODEX_ROUTE, KEY);
    expect(applied).toContain("# >>> agent-memory hooks >>>\n[[hooks.SessionStart]]\n# <<< agent-memory hooks <<<");
    expect(codexRemove(applied, CODEX_ROUTE, DIGEST).text).toBe(withHooks);

    const crlf = original.replace(/\n/g, "\r\n");
    const out = codexApply(crlf, CODEX_ROUTE, KEY);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(codexRemove(out, CODEX_ROUTE, DIGEST).text).toBe(crlf);
  });

  it("round trips through files with a backup", async () => {
    const file = join(dir, "config.toml");
    await writeFile(file, original);
    await applyCodex(file, CODEX_ROUTE, KEY, NOW);
    const [backup] = await backups("config.toml");
    expect(await readFile(join(dir, backup), "utf8")).toBe(original);
    expect(await removeCodex(file, CODEX_ROUTE, DIGEST, NOW)).toBe("removed");
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await removeCodex(file, CODEX_ROUTE, DIGEST, NOW)).toBe("absent");
  });
});

describe("omp models", () => {
  const providers: OmpProvider[] = [
    {
      name: "memory-chat",
      api: "openai-completions",
      baseUrl: "https://proxy.example.net:8097/omp/default/v1",
      models: ["gpt-x", "deepseek-y"],
    },
  ];
  const route = "https://proxy.example.net:8097/omp/default";
  const original = ["providers:", "  mine:", '    baseUrl: "https://api.example.com/v1"', "    apiKey: MINE", "", "theme: dark", ""].join("\n");

  it("inserts a marked region under providers and keeps the rest", () => {
    const next = ompApply(original, providers, KEY);
    expect(next).toContain('    apiKey: "fake-device-key-0001"');
    expect(next).toContain("supportsPromptCacheKey: true");
    expect(next).toContain("  mine:\n");
    expect(next.indexOf("paseo-agent-memory providers (managed)")).toBeLessThan(next.indexOf("  mine:"));
  });

  it("returns the original bytes, also when it had to add the providers key", () => {
    expect(ompRemove(ompApply(original, providers, KEY), route, DIGEST)).toEqual({
      text: original,
      result: "removed",
    });
    const noProviders = "theme: dark\n";
    expect(ompRemove(ompApply(noProviders, providers, KEY), route, DIGEST).text).toBe(noProviders);
  });

  it("asks the caller to delete a file that held only the region", () => {
    expect(ompRemove(ompApply(null, providers, KEY), route, DIGEST)).toEqual({ text: null, result: "removed" });
  });

  it("replaces its own region on a second run", () => {
    const twice = ompApply(ompApply(original, providers, "old-key-0000"), providers, KEY);
    expect(twice.match(/>>> paseo-agent-memory/g)).toHaveLength(1);
    expect(twice).not.toContain("old-key-0000");
  });

  it("keeps a region whose key the user changed", () => {
    const applied = ompApply(original, providers, KEY).replace(JSON.stringify(KEY), '"user-key"');
    expect(ompRemove(applied, route, DIGEST)).toEqual({ text: applied, result: "changed" });
  });

  it("refuses CRLF files, inline providers and a damaged region", () => {
    expect(() => ompApply("providers:\r\n", providers, KEY)).toThrow(SetupFailure);
    expect(() => ompApply("providers: {}\n", providers, KEY)).toThrow(SetupFailure);
    expect(() => ompApply("  # >>> paseo-agent-memory providers (managed)\n", providers, KEY)).toThrow(SetupFailure);
  });

  it("round trips through files, including a file that did not exist", async () => {
    const file = join(dir, "agent", "models.yml");
    await mkdir(join(dir, "agent"));
    await applyOmp(file, providers, KEY, NOW);
    expect(await removeOmp(file, route, DIGEST, NOW)).toBe("removed");
    await expect(stat(file)).rejects.toThrow();

    await writeFile(file, original);
    await applyOmp(file, providers, KEY, NOW);
    expect((await readdir(join(dir, "agent"))).filter((e) => e.includes("agent-memory-backup"))).toHaveLength(1);
    expect(await removeOmp(file, route, DIGEST, NOW)).toBe("removed");
    expect(await readFile(file, "utf8")).toBe(original);
  });
});

describe("existing provider of the user", () => {
  it("leaves a Claude base URL on another host, and replaces one on the proxy", () => {
    const own = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://llm.example.org/v1" } });
    expect(() => claudeApply(own, ROUTE, KEY)).toThrowError(expect.objectContaining({ code: "own_provider" }));
    const old = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example.net:8097/claude-code/old" } });
    expect(JSON.parse(claudeApply(old, ROUTE, KEY)).env.ANTHROPIC_BASE_URL).toBe(ROUTE);
  });

  it("leaves a Codex model_provider that is not team-proxy, and a team-proxy table on another host", () => {
    expect(() => codexApply('model_provider = "openai"\n', CODEX_ROUTE, KEY)).toThrowError(
      expect.objectContaining({ code: "own_provider" }),
    );
    const foreign = '[model_providers.team-proxy]\nbase_url = "https://llm.example.org/v1"\n';
    expect(() => codexApply(foreign, CODEX_ROUTE, KEY)).toThrowError(
      expect.objectContaining({ code: "own_provider" }),
    );
    const otherService = '[model_providers.team-proxy]\nbase_url = "http://proxy.example.net:5678/webhook"\n';
    expect(() => codexApply(otherService, CODEX_ROUTE, KEY)).toThrowError(
      expect.objectContaining({ code: "own_provider" }),
    );
  });

  it("treats the proxy's plain-HTTP address with the same client route as Agent-Memory", () => {
    const manual =
      'model_provider = "team-proxy"\n[model_providers.team-proxy]\nname = "TDAI team-proxy"\nbase_url = "http://proxy.example.net:8096/codex/default"\n';
    const out = codexApply(manual, CODEX_ROUTE, KEY);
    expect(out).toContain(`base_url = "${CODEX_ROUTE}"`);
    expect(out).not.toContain(":8096");
    const claude = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://proxy.example.net:8096/claude-code/default" } });
    expect(JSON.parse(claudeApply(claude, ROUTE, KEY)).env.ANTHROPIC_BASE_URL).toBe(ROUTE);
  });

  it("refuses an inline or dotted model_providers form", () => {
    for (const text of [
      'model_providers = { team-proxy = { base_url = "x" } }\n',
      'model_providers.team-proxy.base_url = "x"\n',
      '[model_providers]\nteam-proxy = { base_url = "x" }\n',
    ]) {
      expect(() => codexApply(text, CODEX_ROUTE, KEY), text).toThrowError(
        expect.objectContaining({ code: "toml_unsupported" }),
      );
    }
  });
});

describe("omp structure checks", () => {
  const providers: OmpProvider[] = [
    { name: "memory-chat", api: "openai-completions", baseUrl: "https://p/v1", models: ["m"] },
  ];

  it("refuses children that are not indented by two spaces", () => {
    expect(() => ompApply("providers:\n    mine:\n      baseUrl: x\n", providers, KEY)).toThrowError(
      expect.objectContaining({ code: "models_invalid" }),
    );
    expect(() => ompApply("providers:\n\tmine:\n", providers, KEY)).toThrowError(
      expect.objectContaining({ code: "models_invalid" }),
    );
  });

  it("refuses a user provider that has the name of a plugin provider", () => {
    const text = "providers:\n  memory-chat:\n    baseUrl: x\n";
    expect(() => ompApply(text, providers, KEY)).toThrowError(expect.objectContaining({ code: "models_invalid" }));
    expect(() => ompApply('providers:\n  "memory-anthropic":\n    a: 1\n', providers, KEY)).toThrowError(
      expect.objectContaining({ code: "models_invalid" }),
    );
  });

  it("accepts two-space children with other names", () => {
    expect(ompApply("providers:\n  mine:\n    baseUrl: x\n", providers, KEY)).toContain("  mine:");
  });
});

describe("atomic writes and backups", () => {
  it("deletes the backup of a removal, because it still holds the key, and keeps the file mode", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, claudeApply("{}\n", ROUTE, KEY), { mode: 0o640 });
    await chmod(file, 0o640);
    expect(await removeClaude(file, ROUTE, DIGEST, NOW)).toBe("removed");
    expect(await backups("settings.json")).toHaveLength(0);
    for (const name of await readdir(dir)) expect(await readFile(join(dir, name), "utf8")).not.toContain(KEY);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(await readdir(dir)).toEqual(expect.not.arrayContaining([expect.stringContaining("agent-memory-tmp")]));
  });

  it("writes through a symlink to its target and leaves the link", async () => {
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(real, "{}\n");
    await symlink(real, link);
    await applyClaude(link, ROUTE, KEY, NOW);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(await removeClaude(link, ROUTE, DIGEST, NOW)).toBe("removed");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe("{}\n");
  });

  it("keeps the installer-era backup of the user's own file when a removal runs", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, '{"model":"opus"}\n');
    await applyClaude(file, ROUTE, KEY, NOW);
    expect(await removeClaude(file, ROUTE, DIGEST, NOW + 1000)).toBe("removed");
    const kept = await backups("settings.json");
    expect(kept).toHaveLength(1);
    expect(await readFile(join(dir, kept[0]), "utf8")).toBe('{"model":"opus"}\n');
  });

  it("makes no backup when a removal takes nothing", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, claudeApply("{}\n", ROUTE, KEY));
    expect(await removeClaude(file, ROUTE, keyDigest("other-key-00000001"), NOW)).toBe("changed");
    expect(await backups("settings.json")).toHaveLength(0);
  });

  it("writes to the target of a dangling symlink and leaves the link", async () => {
    const real = join(dir, "real", "settings.json");
    const link = join(dir, "link.json");
    await symlink(real, link);
    await applyClaude(link, ROUTE, KEY, NOW);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect((await stat(real)).mode & 0o777).toBe(0o600);
  });

  it("does not create anything when a removal meets a dangling symlink", async () => {
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    await symlink(real, link);
    expect(await removeClaude(link, ROUTE, DIGEST, NOW)).toBe("absent");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(stat(real)).rejects.toThrow();
  });

  it("deletes the target, not the link, when a file only held the plugin's region", async () => {
    const real = join(dir, "real.yml");
    const link = join(dir, "link.yml");
    const ompRoute = "https://proxy.example.net:8097/omp/default";
    const ompProviders: OmpProvider[] = [
      { name: "memory-chat", api: "openai-completions", baseUrl: `${ompRoute}/v1`, models: ["m1"] },
    ];
    await symlink(real, link);
    await applyOmp(link, ompProviders, KEY, NOW);
    expect(await removeOmp(link, ompRoute, DIGEST, NOW)).toBe("removed");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(stat(real)).rejects.toThrow();
    expect(await readdir(dir)).not.toContain(expect.stringContaining("backup"));
  });

  it("follows a chain of links", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, "{}\n");
    await symlink(real, join(dir, "mid.json"));
    await symlink("mid.json", join(dir, "top.json"));
    await applyClaude(join(dir, "top.json"), ROUTE, KEY, NOW);
    expect((await lstat(join(dir, "top.json"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(dir, "mid.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  });

  it("gives a new file mode 0600 and leaves no temporary file", async () => {
    const file = join(dir, "new", "settings.json");
    await applyClaude(file, ROUTE, KEY, NOW);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "new"))).toEqual(["settings.json"]);
  });
});

describe("antigravity mcp config", () => {
  const URL_MCP = "https://panel.example.net:8126/api/v1/mcp";
  const entry = { disabled: false, serverUrl: URL_MCP, headers: { "x-tdai-service-id": "default", "x-tdai-user-key": KEY } };

  it("adds the server with both headers and keeps other servers and keys", () => {
    const before = JSON.stringify({ theme: "dark", mcpServers: { fs: { disabled: false, serverUrl: "https://fs.example.net/mcp" } } });
    const out = JSON.parse(agyMcpApply(before, URL_MCP, "default", KEY));
    expect(out.theme).toBe("dark");
    expect(out.mcpServers.fs.serverUrl).toBe("https://fs.example.net/mcp");
    expect(out.mcpServers["agent-memory"]).toEqual(entry);
  });

  it("removes exactly its entry, and reports an empty file for deletion", () => {
    const withOthers = agyMcpApply(JSON.stringify({ mcpServers: { fs: { serverUrl: "https://fs.example.net/mcp" } } }), URL_MCP, "default", KEY);
    const out = agyMcpRemove(withOthers, DIGEST, true);
    expect(out.result).toBe("removed");
    expect(JSON.parse(out.text as string)).toEqual({ mcpServers: { fs: { serverUrl: "https://fs.example.net/mcp" } } });
    expect(agyMcpRemove(agyMcpApply(null, URL_MCP, "default", KEY), DIGEST, true)).toEqual({ text: null, result: "removed" });
  });

  it("keeps an entry with another key and reports it", () => {
    const text = agyMcpApply(null, URL_MCP, "default", "someone-elses-key-1");
    expect(agyMcpRemove(text, DIGEST, true)).toEqual({ text, result: "changed" });
  });

  it("does not replace an agent-memory entry that is not an Agent-Memory MCP address", () => {
    const text = JSON.stringify({ mcpServers: { "agent-memory": { serverUrl: "https://own.example.net/other" } } });
    expect(() => agyMcpApply(text, URL_MCP, "default", KEY)).toThrow(SetupFailure);
  });

  it("treats an agent-memory entry on another host as the user's own", () => {
    const text = JSON.stringify({ mcpServers: { "agent-memory": { serverUrl: "https://other.example.net/api/v1/mcp" } } });
    expect(() => agyMcpApply(text, URL_MCP, "default", KEY)).toThrow(SetupFailure);
  });

  it("keeps the fields of its own entry when it updates it, including disabled: true", () => {
    const text = JSON.stringify({
      mcpServers: {
        "agent-memory": { disabled: true, timeout: 30, serverUrl: URL_MCP, headers: { "x-extra": "1", "x-tdai-user-key": "old-key-0001" } },
      },
    });
    const out = JSON.parse(agyMcpApply(text, URL_MCP, "default", KEY)).mcpServers["agent-memory"];
    expect(out).toEqual({
      disabled: true,
      timeout: 30,
      serverUrl: URL_MCP,
      headers: { "x-extra": "1", "x-tdai-service-id": "default", "x-tdai-user-key": KEY },
    });
  });

  it("never deletes a file that existed before, even when the removal leaves it empty", () => {
    for (const before of ["{}", '{"mcpServers":{}}']) {
      const out = agyMcpRemove(agyMcpApply(before, URL_MCP, "default", KEY), DIGEST, false);
      expect(out.result).toBe("removed");
      expect(out.text).not.toBeNull();
      expect(JSON.parse(out.text as string).mcpServers ?? {}).toEqual({});
    }
  });

  it("closes a file that was open to the group to the owner only, also when the content is unchanged", async () => {
    const file = join(dir, "open.json");
    await writeFile(file, "{}");
    await chmod(file, 0o644);
    await applyAgyMcp(file, URL_MCP, "default", KEY, NOW);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await chmod(file, 0o644);
    await applyAgyMcp(file, URL_MCP, "default", KEY, NOW);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses invalid files without changing them", async () => {
    const file = join(dir, "mcp_config.json");
    await writeFile(file, "{broken");
    await expect(applyAgyMcp(file, URL_MCP, "default", KEY, NOW)).rejects.toMatchObject({ code: "settings_invalid" });
    expect(await readFile(file, "utf8")).toBe("{broken");
    expect(() => agyMcpApply('{"mcpServers": []}', URL_MCP, "default", KEY)).toThrow(SetupFailure);
  });

  it("round trips through a file: 0600 for a new file, no backup left after removal, file gone", async () => {
    const file = join(dir, "config", "mcp_config.json");
    await applyAgyMcp(file, URL_MCP, "default", KEY, NOW);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await removeAgyMcp(file, DIGEST, true, NOW)).toBe("removed");
    await expect(stat(file)).rejects.toThrow();
    expect(await removeAgyMcp(file, DIGEST, true, NOW)).toBe("absent");
  });
});
