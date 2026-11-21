import { describe, expect, it } from "vitest";
import { RENEW_WINDOW_MS } from "../shared/constants";
import type { AccountStatus } from "../shared/status";
import { isRenewDue, refetchIntervalFor, screenFor } from "../shared/view";

const origin = "https://am.example.net";
const account = { username: "an" };
const states: Record<string, AccountStatus> = {
  signed_out: { state: "signed_out", origin },
  waiting: { state: "waiting_browser", origin, verificationUri: `${origin}/x`, expiresAt: "2026-01-01T00:00:00Z" },
  pending: { state: "account_pending", origin, requestedAt: "2026-01-01T00:00:00Z" },
  connected: { state: "connected", origin, account, teams: [], deviceName: "d", expiresAt: "2026-01-01T00:00:00Z", renewDue: false },
  expired: { state: "expired", origin, account, deviceName: "d", expiredAt: "2026-01-01T00:00:00Z" },
};

describe("screenFor", () => {
  it("maps signed out and expired to the login screen", () => {
    expect(screenFor(states.signed_out)).toBe("login");
    expect(screenFor(states.expired)).toBe("login");
    expect(screenFor(states.waiting)).toBe("waiting");
    expect(screenFor(states.pending)).toBe("pending");
    expect(screenFor(states.connected)).toBe("connected");
  });
});

describe("refetchIntervalFor", () => {
  it("polls fast while waiting and slowly once settled", () => {
    expect(refetchIntervalFor(states.waiting)).toBe(2_000);
    expect(refetchIntervalFor(states.pending)).toBe(5_000);
    expect(refetchIntervalFor(states.connected)).toBe(60_000);
    expect(refetchIntervalFor(states.expired)).toBe(60_000);
    expect(refetchIntervalFor(states.signed_out)).toBe(false);
    expect(refetchIntervalFor(undefined)).toBe(false);
  });
});

describe("isRenewDue", () => {
  const now = 1_000_000_000_000;
  it("turns on exactly one day before expiry and off at expiry", () => {
    expect(isRenewDue(now + RENEW_WINDOW_MS + 1, now)).toBe(false);
    expect(isRenewDue(now + RENEW_WINDOW_MS, now)).toBe(true);
    expect(isRenewDue(now + 1, now)).toBe(true);
    expect(isRenewDue(now, now)).toBe(false);
    expect(isRenewDue(now - 1, now)).toBe(false);
  });
});
