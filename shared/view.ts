import { RENEW_WINDOW_MS } from "./constants";
import type { AccountStatus } from "./status";

export type ScreenName = "login" | "waiting" | "pending" | "connected";

export function screenFor(status: AccountStatus): ScreenName {
  switch (status.state) {
    case "waiting_browser":
      return "waiting";
    case "account_pending":
      return "pending";
    case "connected":
      return "connected";
    default:
      return "login";
  }
}

export function refetchIntervalFor(status: AccountStatus | undefined): number | false {
  switch (status?.state) {
    case "waiting_browser":
      return 2_000;
    case "account_pending":
      return 5_000;
    case "connected":
    case "expired":
      return 60_000;
    default:
      return false;
  }
}

/** True from one day before expiry until expiry. */
export function isRenewDue(expiresAtMs: number, nowMs: number): boolean {
  return expiresAtMs > nowMs && expiresAtMs - nowMs <= RENEW_WINDOW_MS;
}
