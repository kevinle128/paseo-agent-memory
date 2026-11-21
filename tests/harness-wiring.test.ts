import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDataDir } from "../server/data-dir";
import { createDeviceApi } from "../server/device-api";
import type { HarnessSetup } from "../server/harness-setup";
import { createLoginMachine } from "../server/login-machine";
import { createStore, type CredentialFile } from "../server/store";
import { AccountStatus } from "../shared/status";
import { startFakePanel, type FakePanel } from "./fake-panel";

const KEY = "fake-user-key-aaaa";
const KEY_ID = "keyid-wxyz-0001";
const T0 = Date.UTC(2026, 10, 24, 3, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const approved = (extra: Record<string, unknown> = {}) => ({
  status: "approved",
  key_id: KEY_ID,
  expires_at: new Date(T0 + 7 * DAY).toISOString(),
  renewed: false,
  user_key: KEY,
  user: { user_id: "u1", email: "an@vtc.vn", display_name: "An" },
  teams: [],
  ...extra,
});

let clock = T0;
let dir: string;
let panel: FakePanel;
let controller: AbortController;
let configured: CredentialFile[];
let removed: Array<{ storedAtMarker: boolean }>;
let view: ReturnType<HarnessSetup["view"]>;
let removeGate: Promise<void> | null;
let markerFails: boolean;
let resumedKeyId: string | undefined;

beforeEach(async () => {
  clock = T0;
  dir = join(await mkdtemp(join(tmpdir(), "pam-wiring-")), "data");
  await ensureDataDir(dir);
  panel = await startFakePanel();
  controller = new AbortController();
  configured = [];
  removed = [];
  removeGate = null;
  markerFails = false;
  resumedKeyId = undefined;
  view = {};
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  controller.abort();
  await panel.close();
  await rm(join(dir, ".."), { recursive: true, force: true });
});

function build() {
  const store = createStore(dir);
  const harness = {
    init: async () => undefined,
    resumedRemovalKeyId: () => resumedKeyId,
    configure: (credential: CredentialFile) => {
      configured.push(credential);
    },
    beginRemoval: async () => {
      if (markerFails) return { done: Promise.resolve(), marked: false };
      // The marker is saved while the credential is still stored; the cleanup itself runs later.
      const storedAtMarker = await stat(join(dir, "credential.json")).then(() => true, () => false);
      const done = (async () => {
        if (removeGate) await removeGate;
        removed.push({ storedAtMarker });
      })();
      return { done, marked: true };
    },
    view: () => view,
  } as unknown as HarnessSetup;
  return createLoginMachine({
    store,
    api: createDeviceApi({ signal: controller.signal, timeoutMs: 2_000 }),
    readSettings: async () => ({ origin: panel.origin, deviceName: "", instanceId: "default" }),
    now: () => clock,
    setTimer: () => () => undefined,
    hostName: () => "test-host",
    abort: () => controller.abort(),
    harness,
  });
}

async function login(machine: ReturnType<typeof build>, grant: Record<string, unknown>) {
  panel.queue("start", {
    body: (origin: string) => ({
      device_code: "device-code-0001",
      user_code: "ABCD-EFGH",
      verification_uri: `${origin}/ext/vtc/device`,
      verification_uri_complete: `${origin}/ext/vtc/device?code=ABCD-EFGH`,
      interval: 5,
      expires_in: 600,
    }),
  });
  await machine.login();
  panel.queue("token", { body: grant });
  clock += 5_000;
  return machine.poll();
}

describe("login machine and the harness setup", () => {
  it("sets up the clients once for a newly issued key, with the credential just saved", async () => {
    const machine = build();
    await machine.init();
    expect(await login(machine, approved())).toMatchObject({ state: "connected" });
    expect(configured).toHaveLength(1);
    expect(configured[0]).toMatchObject({ key: KEY, keyId: KEY_ID, origin: panel.origin });
  });

  it("does not set up again when the login only renews the same key", async () => {
    const machine = build();
    await machine.init();
    await login(machine, approved());
    await login(machine, approved({ renewed: true, user_key: undefined }));
    expect(configured).toHaveLength(1);
  });

  it("sets up again for a new key issued after a reinstall", async () => {
    const machine = build();
    await machine.init();
    await login(machine, approved());
    await login(machine, approved({ key_id: "keyid-new-0002", user_key: "fake-user-key-bbbb" }));
    expect(configured.map((credential) => credential.keyId)).toEqual([KEY_ID, "keyid-new-0002"]);
  });

  it("saves the removal marker, deletes the credential, then removes the client setup in the background", async () => {
    const machine = build();
    await machine.init();
    await login(machine, approved());
    panel.queue("logout", { body: { ok: true } });
    expect(await machine.logout(false)).toMatchObject({ state: "signed_out", reason: "logged_out" });
    await vi.waitFor(() => expect(removed).toHaveLength(1));
    expect(removed[0].storedAtMarker).toBe(true);
    await expect(stat(join(dir, "credential.json"))).rejects.toThrow();
  });

  it("keeps the setup while the server cannot be reached, and removes it when the user forces the log out", async () => {
    const machine = build();
    await machine.init();
    await login(machine, approved());
    panel.queue("logout", { status: 503, body: { error: "temporarily_unavailable" } });
    await machine.logout(false);
    expect(removed).toHaveLength(0);
    panel.queue("logout", { status: 503, body: { error: "temporarily_unavailable" } });
    await machine.logout(true);
    await vi.waitFor(() => expect(removed).toHaveLength(1));
  });

  it("shows the setup and a failed removal on every state, and the status still parses", async () => {
    const machine = build();
    await machine.init();
    view = {
      setup: {
        configuredAt: "2026-11-24T03:00:00.000Z",
        harnesses: [{ id: "claude", state: "partial", error: "installer_failed" }],
      },
    };
    const connected = await login(machine, approved());
    expect(AccountStatus.parse(connected)).toMatchObject({ setup: { harnesses: [{ id: "claude" }] } });
    view = { removal: [{ id: "codex", result: "failed" }] };
    panel.queue("logout", { body: { ok: true } });
    const signedOut = await machine.logout(false);
    expect(AccountStatus.parse(signedOut)).toMatchObject({
      state: "signed_out",
      removal: [{ id: "codex", result: "failed" }],
    });
  });
});

describe("log out with a slow removal", () => {
  it("answers and releases the lock while the tool cleanup is still running", async () => {
    let release: () => void = () => undefined;
    removeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const machine = build();
    await machine.init();
    await login(machine, approved());
    panel.queue("logout", { body: { ok: true } });
    expect(await machine.logout(false)).toMatchObject({ state: "signed_out", reason: "logged_out" });
    expect(removed).toHaveLength(0);
    // The lock is free: another call is served before the removal ends.
    expect(await machine.status()).toMatchObject({ state: "signed_out" });
    await expect(stat(join(dir, "credential.json"))).rejects.toThrow();
    release();
    await vi.waitFor(() => expect(removed).toHaveLength(1));
  });

  it("removes what the old key set up when a renewal names another key", async () => {
    const machine = build();
    await machine.init();
    await login(machine, approved());
    const status = await login(
      machine,
      approved({ renewed: true, user_key: undefined, key_id: "keyid-other-9999" }),
    );
    expect(status).toMatchObject({ state: "signed_out", reason: "key_mismatch" });
    await vi.waitFor(() => expect(removed).toHaveLength(1));
  });
});

describe("log out when the removal marker cannot be saved", () => {
  it("keeps the credential and reports the failure, so the user can retry", async () => {
    const machine = build();
    await machine.init();
    await login(machine, approved());
    markerFails = true;
    panel.queue("logout", { body: { ok: true } });
    expect(await machine.logout(false)).toMatchObject({ state: "connected", lastError: "logout_failed" });
    await expect(stat(join(dir, "credential.json"))).resolves.toBeTruthy();
    expect(removed).toHaveLength(0);

    markerFails = false;
    panel.queue("logout", { status: 401, body: { error: "invalid_token" } });
    expect(await machine.logout(false)).toMatchObject({ state: "signed_out", reason: "logged_out" });
    await vi.waitFor(() => expect(removed).toHaveLength(1));
  });
});

describe("start after a crash between the marker and the credential delete", () => {
  it("finishes the log out when a resumed removal belongs to the stored credential", async () => {
    const machine = build();
    await machine.init();
    await login(machine, approved());
    resumedKeyId = KEY_ID;
    panel.queue("logout", { body: { ok: true } });
    const restarted = build();
    expect(await restarted.init()).toBeUndefined();
    expect(await restarted.status()).toMatchObject({ state: "signed_out", reason: "logged_out" });
    await expect(stat(join(dir, "credential.json"))).rejects.toThrow();
  });

  it("keeps a credential that belongs to another key", async () => {
    const machine = build();
    await machine.init();
    await login(machine, approved());
    resumedKeyId = "keyid-other-9999";
    const restarted = build();
    await restarted.init();
    expect(await restarted.status()).toMatchObject({ state: "connected" });
  });
});
