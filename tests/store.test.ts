import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDataDir, resolveDataDir } from "../server/data-dir";
import { createStore, type CredentialFile, type PendingFile } from "../server/store";

let dir: string;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "pam-store-")), "data");
  await ensureDataDir(dir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(join(dir, ".."), { recursive: true, force: true });
});

const credential: CredentialFile = {
  version: 1,
  origin: "https://am.example.net",
  instanceId: "default",
  installId: "11111111-2222-3333-4444-555555555555",
  keyId: "key-abcd",
  key: "fake-key-value-for-tests",
  expiresAt: "2026-12-01T00:00:00.000Z",
  account: { userId: "u1", username: "an" },
  teams: [{ name: "Core" }],
  deviceName: "laptop",
  savedAt: "2026-11-24T00:00:00.000Z",
};
const pending: PendingFile = {
  version: 1,
  origin: "https://am.example.net",
  installId: credential.installId,
  claimToken: "fake-claim-token",
  deviceName: "laptop",
  requestedAt: "2026-11-24T00:00:00.000Z",
};

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("data dir", () => {
  it("prefers the explicit override, then PASEO_HOME, then the user home", () => {
    expect(resolveDataDir({ PASEO_AGENT_MEMORY_DATA_DIR: "/x/y" })).toBe("/x/y");
    expect(resolveDataDir({ PASEO_HOME: "/p" })).toBe("/p/plugin-data/paseo-agent-memory");
    expect(resolveDataDir({})).toMatch(/\.paseo\/plugin-data\/paseo-agent-memory$/);
  });
});

describe("store", () => {
  it("creates the install id once and keeps it across reloads", async () => {
    const first = await createStore(dir).loadOrCreateInstallId();
    expect(first).toMatch(/^[A-Za-z0-9-]{8,128}$/);
    expect(await createStore(dir).loadOrCreateInstallId()).toBe(first);
  });

  it("writes credential and pending with mode 0600 and the directory with 0700", async () => {
    const store = createStore(dir);
    await store.writeCredential(credential);
    await store.writePending(pending);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, "credential.json"))).toBe(0o600);
    expect(await mode(join(dir, "pending.json"))).toBe(0o600);
    expect(await store.readCredential()).toEqual(credential);
    expect(await store.readPending()).toEqual(pending);
  });

  it("keeps mode 0600 when it replaces a looser existing file", async () => {
    await writeFile(join(dir, "credential.json"), "{}", { mode: 0o644 });
    await createStore(dir).writeCredential(credential);
    expect(await mode(join(dir, "credential.json"))).toBe(0o600);
  });

  it("leaves no temporary file after a write", async () => {
    const store = createStore(dir);
    await store.writeCredential(credential);
    await store.writeCredential({ ...credential, keyId: "key-next" });
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("moves a corrupt file aside and returns null without logging its content", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeFile(join(dir, "credential.json"), "{not json fake-key-value-for-tests", {
      mode: 0o600,
    });
    const store = createStore(dir);
    expect(await store.readCredential()).toBeNull();
    const names = await readdir(dir);
    expect(names.some((name) => name.startsWith("credential.json.corrupt-"))).toBe(true);
    expect(names).not.toContain("credential.json");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("fake-key-value");
  });

  it("moves a file that fails the schema aside", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await writeFile(join(dir, "pending.json"), JSON.stringify({ version: 1 }), { mode: 0o600 });
    expect(await createStore(dir).readPending()).toBeNull();
  });

  it("reads a harness record from before failure details existed", async () => {
    const older = {
      version: 1,
      keyId: "key-abcd",
      keyDigest: "a".repeat(64),
      proxyOrigin: "https://proxy.example",
      instanceId: "default",
      configuredAt: "2026-01-01T00:00:00.000Z",
      paths: { home: "/tmp/home", shell: "/bin/zsh" },
      harnesses: [
        {
          id: "claude",
          state: "partial",
          error: "installer_failed",
          route: "https://proxy.example/claude-code/default",
        },
      ],
    };
    await writeFile(join(dir, "harness.json"), JSON.stringify(older), { mode: 0o600 });
    expect(await createStore(dir).readHarness()).toEqual(older);
  });

  it("drops installer output if a record on disk carries it", async () => {
    const withOutput = {
      version: 1,
      keyId: "key-abcd",
      keyDigest: "b".repeat(64),
      proxyOrigin: "https://proxy.example",
      instanceId: "default",
      configuredAt: "2026-01-01T00:00:00.000Z",
      paths: { home: "/tmp/home", shell: "/bin/zsh" },
      harnesses: [
        {
          id: "codex",
          state: "partial",
          error: "installer_failed",
          route: "https://proxy.example/codex/default",
          failures: [
            {
              step: "hook",
              error: "installer_failed",
              reason: "exit",
              exitCode: 1,
              output: ["leaked-installer-line"],
            },
          ],
        },
      ],
    };
    await writeFile(join(dir, "harness.json"), JSON.stringify(withOutput), { mode: 0o600 });
    const read = await createStore(dir).readHarness();
    expect(read?.harnesses[0].failures).toEqual([
      { step: "hook", error: "installer_failed", reason: "exit", exitCode: 1 },
    ]);
    expect(JSON.stringify(read)).not.toContain("leaked-installer-line");
  });

  it("returns null for a missing file and deletes idempotently", async () => {
    const store = createStore(dir);
    expect(await store.readCredential()).toBeNull();
    await store.deleteCredential();
    await store.writePending(pending);
    await store.deletePending();
    await store.deletePending();
    expect(await store.readPending()).toBeNull();
  });
});
