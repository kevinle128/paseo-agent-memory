import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDataDir } from "../server/data-dir";
import { createDeviceApi } from "../server/device-api";
import {
  createLoginMachine,
  sanitizeDeviceName,
  type MachineSettings,
} from "../server/login-machine";
import { createStore } from "../server/store";
import type { AccountStatus } from "../shared/status";
import { startFakePanel, type FakePanel, type Scripted } from "./fake-panel";

const KEY = "fake-user-key-aaaa";
const OTHER_KEY = "fake-user-key-bbbb";
const DEVICE_CODE = "fake-device-code-0001";
const CLAIM_TOKEN = "fake-claim-token-0001";
const KEY_ID = "keyid-wxyz-0001";
const SECRETS = [KEY, OTHER_KEY, DEVICE_CODE, CLAIM_TOKEN];
const T0 = Date.UTC(2026, 10, 24, 3, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const startBody = (extra: { interval?: number; expires_in?: number } = {}) => (origin: string) => ({
  device_code: DEVICE_CODE,
  user_code: "ABCD-EFGH",
  verification_uri: `${origin}/ext/vtc/device`,
  verification_uri_complete: `${origin}/ext/vtc/device?code=ABCD-EFGH`,
  interval: 5,
  expires_in: 600,
  ...extra,
});

const approved = (
  now: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  status: "approved",
  key_id: KEY_ID,
  expires_at: new Date(now + 7 * DAY).toISOString(),
  renewed: false,
  user_key: KEY,
  user: { user_id: "u1", email: "an@vtc.vn", display_name: "An" },
  teams: [{ team_id: "t1", name: "Core", role: "member" }],
  ...extra,
});

const pendingBody = { status: "account_pending", claim_token: CLAIM_TOKEN, retry_after: 60 };
const protocol = (error: string, status = 400): Scripted => ({ status, body: { error } });

let dir: string;
let panel: FakePanel;
let extraPanels: FakePanel[];
let clock: number;
let timers: { fn: () => void; ms: number; cancelled: boolean }[];
let controller: AbortController;
let settings: MachineSettings;
let logs: string[];
let statuses: AccountStatus[];

function build() {
  const store = createStore(dir);
  const machine = createLoginMachine({
    store,
    api: createDeviceApi({ signal: controller.signal, timeoutMs: 2_000 }),
    readSettings: async () => ({ ...settings }),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    hostName: () => "test-host",
    abort: () => controller.abort(),
  });
  const record = async (promise: Promise<AccountStatus>) => {
    const status = await promise;
    statuses.push(status);
    return status;
  };
  return {
    store,
    init: () => machine.init(),
    status: () => record(machine.status()),
    poll: () => record(machine.poll()),
    login: () => record(machine.login()),
    logout: (force = false) => record(machine.logout(force)),
    stop: () => machine.stop(),
  };
}

const advance = (ms: number) => {
  clock += ms;
};
const activeTimers = () => timers.filter((timer) => !timer.cancelled);

async function fresh() {
  const machine = build();
  await machine.init();
  return machine;
}

/** Brings a machine to the connected state against the fake panel. */
async function connect(machine: Awaited<ReturnType<typeof fresh>>) {
  panel.queue("start", { body: startBody() });
  await machine.login();
  panel.queue("token", { body: approved(clock) });
  advance(5_000);
  return machine.poll();
}

const fileOf = async (name: string) => JSON.parse(await readFile(join(dir, name), "utf8"));

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "pam-machine-")), "data");
  await ensureDataDir(dir);
  panel = await startFakePanel();
  extraPanels = [];
  clock = T0;
  timers = [];
  controller = new AbortController();
  settings = { origin: panel.origin, deviceName: "", instanceId: "default" };
  logs = [];
  statuses = [];
  for (const method of ["log", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  const text = JSON.stringify(statuses);
  for (const secret of [...SECRETS, KEY_ID]) expect(text).not.toContain(secret);
  const logText = logs.join("\n");
  for (const secret of [...SECRETS, KEY_ID]) expect(logText).not.toContain(secret);
  controller.abort();
  await panel.close();
  await Promise.all(extraPanels.map((extra) => extra.close()));
  await rm(join(dir, ".."), { recursive: true, force: true });
});

describe("new device login", () => {
  it("logs in, waits for the browser, and connects after approval", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    const waiting = await machine.login();
    expect(waiting).toMatchObject({
      state: "waiting_browser",
      origin: panel.origin,
      verificationUri: `${panel.origin}/ext/vtc/device?code=ABCD-EFGH`,
    });
    expect(panel.requests[0].body).toMatchObject({ device_name: "test-host", has_key: false });

    panel.queue("token", protocol("authorization_pending"), { body: approved(clock) });
    advance(5_000);
    expect((await machine.poll()).state).toBe("waiting_browser");
    advance(5_000);
    const connected = await machine.poll();
    expect(connected).toMatchObject({
      state: "connected",
      account: { username: "An", email: "an@vtc.vn" },
      teams: [{ name: "Core", role: "member" }],
      deviceName: "test-host",
      renewDue: false,
    });
    const saved = await fileOf("credential.json");
    expect(saved).toMatchObject({ key: KEY, keyId: KEY_ID, origin: panel.origin });
    expect(panel.count("team-list")).toBe(0);
    expect((await stat(join(dir, "credential.json"))).mode & 0o777).toBe(0o600);
  });

  it("asks the server for teams when the approval carries none", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", { body: approved(clock, { teams: undefined }) });
    panel.queue("team-list", { body: { code: 0, data: { items: [{ name: "Ops" }] } } });
    advance(5_000);
    const status = await machine.poll();
    expect(status).toMatchObject({ state: "connected", teams: [{ name: "Ops" }] });
    expect(panel.requests.find((request) => request.route === "team-list")?.headers["x-tdai-user-key"]).toBe(KEY);
  });

  it("makes no request when polled before the due time", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    advance(4_999);
    await machine.poll();
    await machine.poll();
    expect(panel.count("token")).toBe(0);
    advance(1);
    panel.queue("token", protocol("authorization_pending"));
    await machine.poll();
    expect(panel.count("token")).toBe(1);
  });

  it("arms one timer for the next due poll and fires it", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    expect(activeTimers().map((timer) => timer.ms)).toEqual([5_000]);
    panel.queue("token", protocol("authorization_pending"));
    advance(5_000);
    activeTimers()[0].fn();
    await vi.waitFor(() => expect(panel.count("token")).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(activeTimers().map((timer) => timer.ms)).toEqual([5_000]), { timeout: 5000 });
  });

  it("adds five seconds on slow_down and caps the interval at sixty", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody({ expires_in: 100_000 }) });
    await machine.login();
    for (let i = 0; i < 13; i++) {
      panel.queue("token", protocol("slow_down"));
      advance(70_000);
      await machine.poll();
    }
    const before = panel.count("token");
    panel.queue("token", protocol("authorization_pending"));
    advance(59_000);
    await machine.poll();
    expect(panel.count("token")).toBe(before);
    advance(1_000);
    await machine.poll();
    expect(panel.count("token")).toBe(before + 1);
  });

  it("slows down on a rate limit answer and shows the error", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", protocol("slow_down", 429));
    advance(5_000);
    expect(await machine.poll()).toMatchObject({ state: "waiting_browser", lastError: "rate_limited" });
    advance(9_999);
    await machine.poll();
    expect(panel.count("token")).toBe(1);
  });

  it("backs off on server errors and keeps the attempt", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", { status: 503, body: { error: "temporarily_unavailable" } });
    advance(5_000);
    expect(await machine.poll()).toMatchObject({
      state: "waiting_browser",
      lastError: "server_unavailable",
    });
    advance(9_000);
    await machine.poll();
    expect(panel.count("token")).toBe(1);
    panel.queue("token", protocol("authorization_pending"));
    advance(1_000);
    const status = await machine.poll();
    expect(panel.count("token")).toBe(2);
    expect(status).toEqual(expect.objectContaining({ state: "waiting_browser" }));
    expect("lastError" in status).toBe(false);
  });

  it("signs out with login_expired when the device code runs out", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody({ expires_in: 20 }) });
    await machine.login();
    advance(25_000);
    expect(await machine.poll()).toMatchObject({ state: "signed_out", reason: "login_expired" });
    expect(panel.count("token")).toBe(0);
  });

  it("signs out when the server reports an expired, refused or over-limit login", async () => {
    const cases: [Scripted, string][] = [
      [protocol("expired_token"), "login_expired"],
      [protocol("access_denied"), "access_denied"],
      [protocol("key_limit_exceeded", 409), "key_limit"],
    ];
    for (const [response, reason] of cases) {
      const machine = await fresh();
      panel.queue("start", { body: startBody() });
      await machine.login();
      panel.queue("token", response);
      advance(5_000);
      expect(await machine.poll()).toMatchObject({ state: "signed_out", reason });
    }
  });

  it("does not poll again after the attempt is gone", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", protocol("access_denied"));
    advance(5_000);
    await machine.poll();
    expect(activeTimers()).toEqual([]);
    advance(60_000);
    await machine.poll();
    expect(panel.count("token")).toBe(1);
  });
});

describe("waiting for an admin", () => {
  async function toPending() {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", { body: { ...pendingBody, email: "an@vtc.vn" } });
    advance(5_000);
    const status = await machine.poll();
    return { machine, status };
  }

  it("stores the claim and claims no earlier than sixty seconds later", async () => {
    const { machine, status } = await toPending();
    expect(status).toMatchObject({ state: "account_pending", email: "an@vtc.vn" });
    const saved = await fileOf("pending.json");
    expect(saved).toMatchObject({ claimToken: CLAIM_TOKEN, origin: panel.origin });
    expect((await stat(join(dir, "pending.json"))).mode & 0o777).toBe(0o600);

    advance(59_000);
    await machine.poll();
    expect(panel.count("claim")).toBe(0);

    panel.queue("claim", { body: { status: "account_pending", retry_after: 60 } });
    advance(1_000);
    expect((await machine.poll()).state).toBe("account_pending");
    expect(panel.count("claim")).toBe(1);
    expect(panel.requests.at(-1)?.body).toMatchObject({ claim_token: CLAIM_TOKEN });

    advance(30_000);
    await machine.poll();
    expect(panel.count("claim")).toBe(1);

    panel.queue("claim", { body: approved(clock) });
    advance(30_000);
    expect(await machine.poll()).toMatchObject({ state: "connected" });
    expect(await fileOf("credential.json")).toMatchObject({ key: KEY });
    await expect(stat(join(dir, "pending.json"))).rejects.toThrow();
  });

  it("keeps polling at the normal interval while a claim is in progress", async () => {
    const { machine } = await toPending();
    panel.queue("claim", protocol("claim_in_progress", 409));
    advance(60_000);
    const first = await machine.poll();
    expect(first).toMatchObject({ state: "account_pending" });
    expect("lastError" in first).toBe(false);
    advance(59_000);
    await machine.poll();
    expect(panel.count("claim")).toBe(1);
    panel.queue("claim", { body: approved(clock) });
    advance(1_000);
    expect(await machine.poll()).toMatchObject({ state: "connected" });
    expect(panel.count("claim")).toBe(2);
  });

  it("clears an earlier claim error when the claim is in progress", async () => {
    const { machine } = await toPending();
    panel.queue("claim", { status: 503, body: { error: "temporarily_unavailable" } });
    advance(60_000);
    expect(await machine.poll()).toMatchObject({ lastError: "server_unavailable" });
    panel.queue("claim", protocol("claim_in_progress", 409));
    advance(600_000);
    const status = await machine.poll();
    expect(status).toMatchObject({ state: "account_pending" });
    expect("lastError" in status).toBe(false);
  });

  it("backs off claim errors and keeps waiting", async () => {
    const { machine } = await toPending();
    panel.queue("claim", { status: 503, body: { error: "temporarily_unavailable" } });
    advance(60_000);
    expect(await machine.poll()).toMatchObject({
      state: "account_pending",
      lastError: "server_unavailable",
    });
    advance(60_000);
    await machine.poll();
    expect(panel.count("claim")).toBe(1);
    panel.queue("claim", { body: { status: "account_pending", retry_after: 60 } });
    advance(60_000);
    const status = await machine.poll();
    expect(panel.count("claim")).toBe(2);
    expect("lastError" in status).toBe(false);
  });

  it("claims after a restart against the stored address even when the setting changed", async () => {
    await toPending();
    settings = { ...settings, origin: "http://127.0.0.1:9" };
    const restarted = await fresh();
    panel.queue("claim", { body: approved(clock) });
    const status = await restarted.poll();
    expect(panel.count("claim")).toBe(1);
    expect(await fileOf("credential.json")).toMatchObject({ origin: panel.origin, key: KEY });
    expect(status).toMatchObject({ state: "signed_out", reason: "server_changed" });
  });

  it("clears the claim when the server no longer knows it", async () => {
    const { machine } = await toPending();
    panel.queue("claim", protocol("invalid_grant"));
    advance(60_000);
    expect(await machine.poll()).toMatchObject({ state: "signed_out", reason: "login_expired" });
    await expect(stat(join(dir, "pending.json"))).rejects.toThrow();
  });

  it("clears the claim when the admin refuses the account", async () => {
    const { machine } = await toPending();
    panel.queue("claim", protocol("access_denied"));
    advance(60_000);
    expect(await machine.poll()).toMatchObject({ state: "signed_out", reason: "access_denied" });
  });

  it("clears the claim at the key limit", async () => {
    const { machine } = await toPending();
    panel.queue("claim", protocol("key_limit_exceeded", 409));
    advance(60_000);
    expect(await machine.poll()).toMatchObject({ state: "signed_out", reason: "key_limit" });
  });

  it("drops a stored claim when a new login starts", async () => {
    const { machine } = await toPending();
    panel.queue("start", { body: startBody() });
    expect((await machine.login()).state).toBe("waiting_browser");
    await expect(stat(join(dir, "pending.json"))).rejects.toThrow();
  });
});

describe("renewal and replacement", () => {
  it("renews the same key without a new value and moves the expiry", async () => {
    const machine = await fresh();
    await connect(machine);
    const before = await fileOf("credential.json");
    advance(2 * DAY);
    panel.queue("start", { body: startBody() });
    await machine.login();
    expect(panel.requests.filter((r) => r.route === "start").at(-1)?.body).toMatchObject({ has_key: true });
    panel.queue("token", {
      body: approved(clock, { renewed: true, user_key: undefined }),
    });
    advance(5_000);
    expect(await machine.poll()).toMatchObject({ state: "connected" });
    const after = await fileOf("credential.json");
    expect(after.key).toBe(KEY);
    expect(after.keyId).toBe(before.keyId);
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt));
  });

  it("deletes the credential when a renewal names another key", async () => {
    const machine = await fresh();
    await connect(machine);
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", {
      body: approved(clock, { renewed: true, user_key: undefined, key_id: "keyid-other-9999" }),
    });
    advance(5_000);
    expect(await machine.poll()).toMatchObject({ state: "signed_out", reason: "key_mismatch" });
    await expect(stat(join(dir, "credential.json"))).rejects.toThrow();
    panel.queue("start", { body: startBody() });
    await machine.login();
    expect(panel.requests.filter((r) => r.route === "start").at(-1)?.body).toMatchObject({ has_key: false });
  });

  it("replaces the key when the server answers a renewal with a new value", async () => {
    const machine = await fresh();
    await connect(machine);
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", {
      body: approved(clock, { renewed: false, user_key: OTHER_KEY, key_id: "keyid-new-0002" }),
    });
    advance(5_000);
    await machine.poll();
    expect(await fileOf("credential.json")).toMatchObject({ key: OTHER_KEY, keyId: "keyid-new-0002" });
  });

  it("treats a fresh key without a value as a bad response and keeps polling", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", { body: approved(clock, { user_key: undefined }) });
    advance(5_000);
    expect(await machine.poll()).toMatchObject({ state: "waiting_browser", lastError: "bad_response" });
    await expect(stat(join(dir, "credential.json"))).rejects.toThrow();
  });

  it("keeps an expired credential and sends has_key on the next login", async () => {
    const machine = await fresh();
    await connect(machine);
    advance(8 * DAY);
    expect(await machine.status()).toMatchObject({ state: "expired", account: { username: "An" } });
    panel.queue("start", { body: startBody() });
    await machine.login();
    expect(panel.requests.filter((r) => r.route === "start").at(-1)?.body).toMatchObject({ has_key: true });
  });

  it("turns renewDue on one day before expiry", async () => {
    const machine = await fresh();
    await connect(machine);
    advance(6 * DAY - 5_000 - 1);
    expect(await machine.status()).toMatchObject({ state: "connected", renewDue: false });
    advance(1);
    expect(await machine.status()).toMatchObject({ state: "connected", renewDue: true });
  });

  it("shows server_changed and sends has_key false to a different server", async () => {
    const machine = await fresh();
    await connect(machine);
    const second = await startFakePanel();
    extraPanels.push(second);
    settings = { ...settings, origin: second.origin };
    expect(await machine.status()).toMatchObject({ state: "signed_out", reason: "server_changed" });
    second.queue("start", { body: startBody() });
    await machine.login();
    expect(second.requests[0].body).toMatchObject({ has_key: false });
  });
});

describe("logout", () => {
  it("deletes the credential when the server accepts, forgets the key or the device", async () => {
    const answers: Scripted[] = [
      { body: { ok: true } },
      protocol("invalid_token", 401),
      protocol("unknown_device", 404),
    ];
    for (const answer of answers) {
      const machine = await fresh();
      await connect(machine);
      panel.queue("logout", answer);
      expect(await machine.logout()).toMatchObject({ state: "signed_out", reason: "logged_out" });
      await expect(stat(join(dir, "credential.json"))).rejects.toThrow();
      expect(panel.requests.at(-1)?.headers["x-tdai-user-key"]).toBe(KEY);
    }
  });

  it("keeps the credential when the server is unreachable, and force removes it", async () => {
    const machine = await fresh();
    await connect(machine);
    panel.queue("logout", { status: 503, body: { error: "temporarily_unavailable" } });
    expect(await machine.logout()).toMatchObject({ state: "connected", lastError: "logout_unreachable" });
    expect(await fileOf("credential.json")).toMatchObject({ key: KEY });
    panel.queue("logout", { status: 503, body: { error: "temporarily_unavailable" } });
    expect(await machine.logout(true)).toMatchObject({ state: "signed_out", reason: "logged_out" });
    await expect(stat(join(dir, "credential.json"))).rejects.toThrow();
  });

  it("logs out to the stored address after the setting changed", async () => {
    const machine = await fresh();
    await connect(machine);
    settings = { ...settings, origin: "http://127.0.0.1:9" };
    panel.queue("logout", { body: { ok: true } });
    await machine.logout();
    expect(panel.count("logout")).toBe(1);
  });

  it("deletes a stored claim without a request", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", { body: pendingBody });
    advance(5_000);
    await machine.poll();
    const before = panel.requests.length;
    expect(await machine.logout()).toMatchObject({ state: "signed_out", reason: "logged_out" });
    expect(panel.requests.length).toBe(before);
    await expect(stat(join(dir, "pending.json"))).rejects.toThrow();
  });

  it("cancels a login that waits for the browser", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    const before = panel.requests.length;
    expect((await machine.logout()).state).toBe("signed_out");
    expect(panel.requests.length).toBe(before);
    expect(activeTimers()).toEqual([]);
  });

  it("returns to the connected state when a renewal is cancelled", async () => {
    const machine = await fresh();
    await connect(machine);
    panel.queue("start", { body: startBody() });
    await machine.login();
    expect((await machine.logout()).state).toBe("connected");
    expect(panel.count("logout")).toBe(0);
  });
});

describe("configuration", () => {
  it("makes no request while the address is the placeholder", async () => {
    settings = { origin: null, originError: "not_configured", deviceName: "", instanceId: "default" };
    const machine = await fresh();
    expect(await machine.status()).toMatchObject({ state: "signed_out", reason: "not_configured" });
    expect(await machine.login()).toMatchObject({ state: "signed_out", reason: "not_configured" });
    expect(panel.requests).toEqual([]);
  });

  it("reports an invalid address", async () => {
    settings = { origin: null, originError: "invalid_base_url", deviceName: "", instanceId: "default" };
    const machine = await fresh();
    expect(await machine.login()).toMatchObject({ state: "signed_out", reason: "invalid_base_url" });
  });

  it("keeps the previous state and reports the error when start fails", async () => {
    const machine = await fresh();
    panel.queue("start", { status: 429, body: { error: "slow_down" } });
    expect(await machine.login()).toMatchObject({ state: "signed_out", lastError: "rate_limited" });
  });

  it("uses the configured device name and cleans it", async () => {
    settings = { ...settings, deviceName: "  Dale\u0007  \n laptop  " };
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    expect(panel.requests[0].body).toMatchObject({ device_name: "Dale laptop" });
    expect(sanitizeDeviceName("   ")).toBe("Paseo device");
    expect(sanitizeDeviceName("x".repeat(100))).toHaveLength(64);
  });
});

describe("concurrency and shutdown", () => {
  it("sends one request for two concurrent polls", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", protocol("authorization_pending"));
    advance(5_000);
    await Promise.all([machine.poll(), machine.poll()]);
    expect(panel.count("token")).toBe(1);
  });

  it("aborts the in-flight request on stop and then does nothing", async () => {
    const machine = await fresh();
    panel.queue("start", { body: startBody() });
    await machine.login();
    panel.queue("token", { hang: true });
    advance(5_000);
    const polling = machine.poll();
    await vi.waitFor(() => expect(panel.count("token")).toBe(1), { timeout: 5000 });
    machine.stop();
    await expect(polling).resolves.toMatchObject({ state: "waiting_browser" });
    advance(60_000);
    await machine.poll();
    await machine.login();
    expect(panel.count("token")).toBe(1);
    expect(panel.count("start")).toBe(1);
    expect(activeTimers()).toEqual([]);
  });
});
