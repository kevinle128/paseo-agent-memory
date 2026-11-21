import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createDeviceApi } from "../server/device-api";
import { startFakePanel, type FakePanel } from "./fake-panel";

const SECRET_KEY = "fake-key-secret-1";
const DEVICE_CODE = "fake-device-code-1";
const CLAIM_TOKEN = "fake-claim-token-1";

let panel: FakePanel;
let lifetime: AbortController;
let logs: string[];

beforeEach(async () => {
  panel = await startFakePanel();
  lifetime = new AbortController();
  logs = [];
  for (const method of ["log", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  lifetime.abort();
  await panel.close();
});

const api = (extra: { timeoutMs?: number; fetch?: typeof fetch } = {}) =>
  createDeviceApi({ signal: lifetime.signal, ...extra });

const startBody = (origin: string, complete = `${origin}/ext/vtc/device?code=ABCD-EFGH`) => ({
  device_code: DEVICE_CODE,
  user_code: "ABCD-EFGH",
  verification_uri: `${origin}/ext/vtc/device`,
  verification_uri_complete: complete,
  interval: 5,
  expires_in: 600,
});

const approved = {
  status: "approved",
  key_id: "key-1234",
  expires_at: "2026-12-01T00:00:00Z",
  renewed: false,
  user_key: SECRET_KEY,
  user: { user_id: "u1", username: "an" },
};

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("device api requests", () => {
  it("sends start, token and claim bodies in the server's field names", async () => {
    panel.queue("start", { body: startBody });
    panel.queue("token", { body: { status: "account_pending", claim_token: CLAIM_TOKEN, retry_after: 60 } });
    panel.queue("claim", { body: approved });
    const client = api();
    const started = await client.start(panel.origin, {
      install_id: "install-0001",
      device_name: "laptop",
      has_key: false,
    });
    expect(started.device_code).toBe(DEVICE_CODE);
    await client.token(panel.origin, DEVICE_CODE);
    await client.claim(panel.origin, { install_id: "install-0001", claim_token: CLAIM_TOKEN });
    expect(panel.requests.map((request) => [request.route, request.body])).toEqual([
      ["start", { install_id: "install-0001", device_name: "laptop", has_key: false }],
      ["token", { device_code: DEVICE_CODE }],
      ["claim", { install_id: "install-0001", claim_token: CLAIM_TOKEN }],
    ]);
  });

  it("sends the key only in the key header on logout", async () => {
    panel.queue("logout", { body: { ok: true } });
    await api().logout(panel.origin, "install-0001", SECRET_KEY);
    const [request] = panel.requests;
    expect(request.headers["x-tdai-user-key"]).toBe(SECRET_KEY);
    expect(JSON.stringify(request.body)).not.toContain(SECRET_KEY);
  });

  it("parses an approved grant with identity and teams", async () => {
    panel.queue("token", {
      body: {
        ...approved,
        user: { user_id: "u1", email: "an@vtc.vn", display_name: "An" },
        teams: [{ team_id: "t1", name: "Core", role: "member" }],
      },
    });
    const grant = await api().token(panel.origin, DEVICE_CODE);
    expect(grant).toMatchObject({
      status: "approved",
      user: { email: "an@vtc.vn", display_name: "An" },
      teams: [{ name: "Core", role: "member" }],
    });
  });

  it("ignores a malformed teams list instead of failing the login", async () => {
    panel.queue("token", { body: { ...approved, teams: "nope" } });
    const grant = await api().token(panel.origin, DEVICE_CODE);
    expect(grant.status).toBe("approved");
    expect(grant.status === "approved" && grant.teams).toBeUndefined();
  });
});

describe("device api errors", () => {
  it("maps protocol bodies, rate limits and outages", async () => {
    panel.queue(
      "token",
      { status: 400, body: { error: "authorization_pending" } },
      { status: 409, body: { error: "key_limit_exceeded" } },
      { status: 429, body: { error: "slow_down" } },
      { status: 503, body: { error: "temporarily_unavailable" } },
      { status: 400, body: {} },
    );
    const client = api();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rejection(client.token(panel.origin, DEVICE_CODE)));
    expect(results.map((error) => [error.kind, error.code, error.status])).toEqual([
      ["protocol", "authorization_pending", 400],
      ["protocol", "key_limit_exceeded", 409],
      ["rate_limited", "slow_down", 429],
      ["server_unavailable", "temporarily_unavailable", 503],
      ["bad_response", undefined, 400],
    ]);
  });

  it("logs waiting for the person as information and a real failure as an error", async () => {
    vi.restoreAllMocks();
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    panel.queue("token", { status: 400, body: { error: "authorization_pending" } }, { status: 409, body: { error: "key_limit_exceeded" } });
    const client = api();
    await rejection(client.token(panel.origin, DEVICE_CODE));
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    await rejection(client.token(panel.origin, DEVICE_CODE));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("reports a closed port as a network error", async () => {
    const origin = panel.origin;
    await panel.close();
    const error = await rejection(api().token(origin, DEVICE_CODE));
    expect(error.kind).toBe("network");
    panel = await startFakePanel();
  });

  it("reports bad JSON and a wrong shape as a bad response", async () => {
    panel.queue("token", { raw: "<html>" }, { body: { status: "approved" } });
    const client = api();
    expect((await rejection(client.token(panel.origin, DEVICE_CODE))).kind).toBe("bad_response");
    expect((await rejection(client.token(panel.origin, DEVICE_CODE))).kind).toBe("bad_response");
  });

  it("refuses a verification link on another origin", async () => {
    panel.queue("start", { body: (origin: string) => startBody(origin, "https://evil.example.net/x") });
    const error = await rejection(
      api().start(panel.origin, { install_id: "install-0001", device_name: "d", has_key: false }),
    );
    expect(error.kind).toBe("bad_response");
  });

  it("refuses redirects", async () => {
    panel.queue("token", { status: 302, headers: { location: "https://evil.example.net/" } });
    expect((await rejection(api().token(panel.origin, DEVICE_CODE))).kind).toBe("network");
  });

  it("times out a request that never answers", async () => {
    panel.queue("token", { hang: true });
    const error = await rejection(api({ timeoutMs: 50 }).token(panel.origin, DEVICE_CODE));
    expect(error.kind).toBe("network");
  });

  it("aborts an in-flight request when the plugin stops", async () => {
    panel.queue("token", { hang: true });
    const pending = rejection(api({ timeoutMs: 5_000 }).token(panel.origin, DEVICE_CODE));
    await vi.waitFor(() => expect(panel.count("token")).toBe(1), { timeout: 5000 });
    lifetime.abort();
    expect((await pending).kind).toBe("network");
  });

  it("keeps secrets out of error messages and log lines", async () => {
    panel.queue(
      "token",
      { status: 500, body: { error: "boom", user_key: SECRET_KEY } },
      { status: 400, body: { error: "invalid_grant", claim_token: CLAIM_TOKEN } },
    );
    const client = api();
    const first = await rejection(client.token(panel.origin, DEVICE_CODE));
    const second = await rejection(client.claim(panel.origin, { install_id: "i-0000001", claim_token: CLAIM_TOKEN }));
    const text = [first.message, second.message, ...logs].join("\n");
    for (const secret of [SECRET_KEY, DEVICE_CODE, CLAIM_TOKEN]) expect(text).not.toContain(secret);
  });
});

describe("team list", () => {
  const call = () => api().teams(panel.origin, "default", SECRET_KEY, "u1");

  it("sends the key in the header and reads a wrapped page", async () => {
    panel.queue("team-list", { body: { code: 0, data: { items: [{ team_id: "t1", name: "Core" }], total: 1 } } });
    expect(await call()).toEqual([{ name: "Core" }]);
    const [request] = panel.requests;
    expect(request.headers["x-tdai-user-key"]).toBe(SECRET_KEY);
    expect(request.headers["x-tdai-service-id"]).toBe("default");
    expect(request.body).toEqual({ user_id: "u1" });
  });

  it("reads a bare page", async () => {
    panel.queue("team-list", { body: { items: [{ name: "Ops" }] } });
    expect(await call()).toEqual([{ name: "Ops" }]);
  });

  it("returns an empty list when the call fails and says why", async () => {
    panel.queue("team-list", { status: 401, body: { code: 40101 } }, { body: { unexpected: true } });
    expect(await call()).toEqual([]);
    expect(await call()).toEqual([]);
    expect(logs.join("\n")).toContain("team list unavailable (401)");
    expect(logs.join("\n")).toContain("team list unavailable (parse)");
    expect(logs.join("\n")).not.toContain(SECRET_KEY);
  });
});
