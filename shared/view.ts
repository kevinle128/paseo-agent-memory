import { RENEW_WINDOW_MS } from "./constants";
import type { AccountStatus } from "./status";

/** A saved login counts only for the server that the settings point at now. */
export function credentialMatchesOrigin(settingsOrigin: string | null, credentialOrigin: string): boolean {
  return settingsOrigin !== null && settingsOrigin === credentialOrigin;
}

/** The switch value of the `mcp` settings document. Only a document that is ready can turn the MCP on. */
export function mcpEnabled(
  state: { status: string; values?: { enabled: boolean } } | undefined,
): boolean {
  return state?.status === "ready" && state.values?.enabled === true;
}

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
  if (status?.setup?.running || status?.setup?.installing?.length || status?.removing) return 2_000;
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
