import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureDataDir } from "../../server/data-dir";
import { createDeviceApi } from "../../server/device-api";
import { createLoginMachine, type MachineSettings } from "../../server/login-machine";
import { createStore } from "../../server/store";
import type { AccountStatus } from "../../shared/status";

// Opt-in: needs the local Agent-Memory stack (Core, Panel with the vtc extension, fake SSO).
const enabled = process.env.PAM_E2E === "1";
const PANEL = process.env.PAM_E2E_PANEL ?? "";
const CORE = process.env.PAM_E2E_CORE ?? "";
const SSO = process.env.PAM_E2E_SSO ?? "";
const ADMIN_KEY = process.env.PAM_E2E_ADMIN_KEY ?? "";

const adminHeaders = {
  "content-type": "application/json",
  "x-tdai-service-id": "default",
  "x-tdai-user-key": ADMIN_KEY,
};

async function post(url: string, body: unknown, headers: Record<string, string> = adminHeaders) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only access to untyped admin responses
}

/** A minimal cookie jar: later Set-Cookie values replace earlier ones by name; an emptied cookie is dropped. */
function addCookies(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const [pair = ""] = header.split(";");
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const value = pair.slice(at + 1);
    if (value) jar.set(pair.slice(0, at), value);
    else jar.delete(pair.slice(0, at));
  }
}
const cookieHeader = (jar: Map<string, string>): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

/** Walks the browser leg with plain HTTP: device page, confirm link, Panel login, fake SSO, back to the Panel. */
async function completeBrowserLogin(verificationUri: string): Promise<void> {
  // A browser loads the device page first; the page holds the only link that starts the login.
  const page = await fetch(verificationUri, { redirect: "manual" });
  expect(page.status).toBe(200);
  const html = await page.text();
  const href = /href="([^"]*\/ext\/vtc\/sso\/login\?[^"]*)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  if (!href) throw new Error("device page has no login link");
  const jar = new Map<string, string>();
  addCookies(jar, page);
  const login = await fetch(new URL(href, PANEL), { redirect: "manual", headers: { cookie: cookieHeader(jar) } });
  expect(login.status).toBe(302);
  addCookies(jar, login);
  const cookie = cookieHeader(jar);
  const toSso = login.headers.get("location");
  if (!toSso) throw new Error("login did not redirect");
  const sso = await fetch(new URL(toSso, PANEL), { redirect: "manual" });
  expect(sso.status).toBe(302);
  const back = sso.headers.get("location");
  if (!back) throw new Error("sso did not redirect back");
  const done = await fetch(new URL(back, PANEL), { redirect: "manual", headers: { cookie } });
  expect(done.status).toBe(200);
}

async function keyIsValid(key: string): Promise<boolean> {
  const { json } = await post(
    `${CORE}/v3/meta/auth/verify`,
    { user_key: key },
    { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}`, "x-tdai-service-id": "default" },
  );
  return json?.data?.valid === true;
}

async function approvePending(email: string): Promise<void> {
  const adminId = (
    await post(`${CORE}/v3/meta/auth/verify`, { user_key: ADMIN_KEY }, {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_KEY}`,
      "x-tdai-service-id": "default",
    })
  ).json?.data?.user?.user_id as string;
  const teams = await post(`${PANEL}/api/v1/meta/team/list`, { user_id: adminId });
  const teamId = teams.json?.data?.items?.[0]?.team_id as string | undefined;
  if (!teamId) throw new Error("no team available for approval");
  const list = await post(`${PANEL}/api/v1/ext/vtc/pending/list`, {});
  const item = list.json?.data?.items?.find((entry: { email?: string }) => entry.email === email);
  if (!item) throw new Error("pending user not listed");
  const result = await post(`${PANEL}/api/v1/ext/vtc/pending/approve`, {
    pending_id: item.pending_id,
    team_id: teamId,
    role: "member",
    mode: "create",
    confirm_create: true,
  });
  expect(result.status).toBe(200);
}

describe.skipIf(!enabled)("device login against the local Agent-Memory stack", () => {
  let dir: string;
  let logs: string[];
  let settings: MachineSettings;
  let machine: ReturnType<typeof createLoginMachine>;
  let store: ReturnType<typeof createStore>;
  let lifetime: AbortController;
  const keys: string[] = [];

  async function waitFor(state: AccountStatus["state"], timeoutMs = 90_000): Promise<AccountStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await machine.poll();
      if (status.state === state) return status;
      if (Date.now() > deadline) throw new Error(`still ${status.state}, wanted ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  beforeAll(async () => {
    for (const [name, value] of Object.entries({ PANEL, CORE, SSO, ADMIN_KEY })) {
      if (!value) throw new Error(`PAM_E2E_${name} is required`);
    }
    dir = join(await mkdtemp(join(tmpdir(), "pam-e2e-")), "data");
    await ensureDataDir(dir);
    logs = [];
    for (const method of ["log", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    settings = { origin: PANEL, deviceName: "PAM e2e laptop", instanceId: "default" };
    lifetime = new AbortController();
    store = createStore(dir);
    machine = createLoginMachine({
      store,
      api: createDeviceApi({ signal: lifetime.signal }),
      readSettings: async () => ({ ...settings }),
      now: Date.now,
      setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      hostName: hostname,
      abort: () => lifetime.abort(),
    });
    await machine.init();
  }, 60_000);

  afterAll(async () => {
    machine?.stop();
    vi.restoreAllMocks();
    await rm(join(dir, ".."), { recursive: true, force: true });
  });

  async function loginThroughBrowser() {
    const waiting = await machine.login();
    if (waiting.state !== "waiting_browser") throw new Error(`login ended in ${waiting.state}`);
    await completeBrowserLogin(waiting.verificationUri);
  }

  it("E1 waits for an admin, then connects after approval", async () => {
    const suffix = Date.now().toString(36);
    const email = `pam.e2e.${suffix}@vtc.vn`;
    await post(`${SSO}/__as`, { email, userId: String(910000000 + (Date.now() % 1000000)) }, {
      "content-type": "application/json",
    });
    await loginThroughBrowser();
    await waitFor("account_pending");
    expect((await stat(join(dir, "pending.json"))).mode & 0o777).toBe(0o600);

    await approvePending(email);
    const connected = await waitFor("connected");
    expect(connected.state).toBe("connected");
    const saved = JSON.parse(await readFile(join(dir, "credential.json"), "utf8"));
    expect((await stat(join(dir, "credential.json"))).mode & 0o777).toBe(0o600);
    keys.push(saved.key);
    expect(await keyIsValid(saved.key)).toBe(true);
    // Records whether the team row can be filled; read the "team list unavailable" log line if empty.
    console.info(`teams in credential: ${saved.teams.length}`);
  }, 180_000);

  it("E2 renews the same key", async () => {
    const before = JSON.parse(await readFile(join(dir, "credential.json"), "utf8"));
    await loginThroughBrowser();
    await waitFor("connected");
    const after = JSON.parse(await readFile(join(dir, "credential.json"), "utf8"));
    expect(after.keyId).toBe(before.keyId);
    expect(after.key).toBe(before.key);
    expect(Date.parse(after.expiresAt)).toBeGreaterThanOrEqual(Date.parse(before.expiresAt));
  }, 180_000);

  it("E3 replaces the key after a reinstall", async () => {
    const before = JSON.parse(await readFile(join(dir, "credential.json"), "utf8"));
    await rm(join(dir, "credential.json"));
    machine.stop();
    lifetime = new AbortController();
    store = createStore(dir);
    machine = createLoginMachine({
      store,
      api: createDeviceApi({ signal: lifetime.signal }),
      readSettings: async () => ({ ...settings }),
      now: Date.now,
      setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      hostName: hostname,
      abort: () => lifetime.abort(),
    });
    await machine.init();
    await loginThroughBrowser();
    await waitFor("connected");
    const after = JSON.parse(await readFile(join(dir, "credential.json"), "utf8"));
    keys.push(after.key);
    expect(after.keyId).not.toBe(before.keyId);
    expect(await keyIsValid(before.key)).toBe(false);
    expect(await keyIsValid(after.key)).toBe(true);
  }, 180_000);

  it("E4 logs out and the key stops working", async () => {
    const saved = JSON.parse(await readFile(join(dir, "credential.json"), "utf8"));
    const status = await machine.logout(false);
    expect(status).toMatchObject({ state: "signed_out", reason: "logged_out" });
    await expect(stat(join(dir, "credential.json"))).rejects.toThrow();
    expect(await keyIsValid(saved.key)).toBe(false);
  }, 60_000);

  it("E5 never logs a key value", () => {
    const text = logs.join("\n");
    for (const key of keys) expect(text).not.toContain(key);
  });
});
