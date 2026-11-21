import { z } from "zod";
import { RemovalView, SetupView } from "./harness";

export const SignedOutReason = z.enum([
  "logged_out",
  "login_expired",
  "access_denied",
  "key_limit",
  "key_mismatch",
  "not_configured",
  "invalid_base_url",
  "server_changed",
]);
export type SignedOutReason = z.infer<typeof SignedOutReason>;

export const ErrorCode = z.enum([
  "network",
  "server_unavailable",
  "rate_limited",
  "bad_response",
  "logout_unreachable",
  "logout_failed",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Account = z.object({ username: z.string(), email: z.string().optional() });
export type Account = z.infer<typeof Account>;

export const Team = z.object({ name: z.string(), role: z.string().optional() });
export type Team = z.infer<typeof Team>;

const lastError = ErrorCode.optional();
// Present on every state: the record outlives the login screen, and a failed removal is shown after log out.
const setup = SetupView.optional();
const removal = RemovalView.optional();
const removing = z.boolean().optional();

export const AccountStatus = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("signed_out"),
    origin: z.string(),
    reason: SignedOutReason.optional(),
    lastError,
    setup,
    removal,
    removing,
  }),
  z.object({
    state: z.literal("waiting_browser"),
    origin: z.string(),
    verificationUri: z.string(),
    expiresAt: z.string(),
    lastError,
    setup,
    removal,
    removing,
  }),
  z.object({
    state: z.literal("account_pending"),
    origin: z.string(),
    requestedAt: z.string(),
    email: z.string().optional(),
    lastError,
    setup,
    removal,
    removing,
  }),
  z.object({
    state: z.literal("connected"),
    origin: z.string(),
    account: Account,
    teams: z.array(Team),
    deviceName: z.string(),
    expiresAt: z.string(),
    renewDue: z.boolean(),
    lastError,
    setup,
    removal,
    removing,
  }),
  z.object({
    state: z.literal("expired"),
    origin: z.string(),
    account: Account,
    deviceName: z.string(),
    expiredAt: z.string(),
    lastError,
    setup,
    removal,
    removing,
  }),
]);
export type AccountStatus = z.infer<typeof AccountStatus>;
