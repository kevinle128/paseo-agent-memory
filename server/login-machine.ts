import {
  CLAIM_MAX_BACKOFF_S,
  CLAIM_MIN_INTERVAL_S,
  DEVICE_MAX_INTERVAL_S,
  DEVICE_SLOW_DOWN_STEP_S,
} from "../shared/constants";
import type { AccountStatus, ErrorCode, SignedOutReason } from "../shared/status";
import { isRenewDue } from "../shared/view";
import { ApiError, type ApprovedGrant, type DeviceApi } from "./device-api";
import type { HarnessSetup } from "./harness-setup";
import type { PendingFile, Store } from "./store";

export interface MachineSettings {
  origin: string | null;
  originError?: "invalid_base_url" | "not_configured";
  deviceName: string;
  instanceId: string;
}

export interface MachineDeps {
  store: Store;
  api: DeviceApi;
  readSettings(): Promise<MachineSettings>;
  now(): number;
  /** Returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  hostName(): string;
  /** Called by `stop()` to abort in-flight requests. */
  abort?(): void;
  /** Sets up and removes the client configuration. Absent in tests that only exercise the login. */
  harness?: HarnessSetup;
}

interface Attempt {
  origin: string;
  deviceCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalS: number;
  nextPollAt: number;
  errors: number;
  deviceName: string;
}

type Credential = NonNullable<Awaited<ReturnType<Store["readCredential"]>>>;

const FALLBACK_DEVICE_NAME = "Paseo device";

export function sanitizeDeviceName(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
  return cleaned || FALLBACK_DEVICE_NAME;
}

function errorCodeFor(error: ApiError): Exclude<ErrorCode, "logout_unreachable"> {
  switch (error.kind) {
    case "rate_limited":
    case "server_unavailable":
    case "network":
      return error.kind;
    default:
      return "bad_response";
  }
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // Never log the message: it could carry file paths or request details.
  console.error(`unexpected failure (${error instanceof Error ? error.name : "unknown"})`);
  return new ApiError("bad_response");
}

export function createLoginMachine(deps: MachineDeps) {
  let installId = "";
  let credential: Credential | null = null;
  let pending: PendingFile | null = null;
  let attempt: Attempt | null = null;
  let nextClaimAt: number | null = null;
  let claimErrors = 0;
  let lastError: ErrorCode | undefined;
  let lastReason: SignedOutReason | undefined;
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  // Every public method and timer tick runs through one chain, so two polls never overlap.
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(async () => {
      try {
        return await fn();
      } finally {
        schedule();
      }
    });
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function dueAt(): number | null {
    if (attempt) return attempt.nextPollAt;
    if (pending && nextClaimAt !== null) return nextClaimAt;
    return null;
  }

  function schedule(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (stopped) return;
    const due = dueAt();
    if (due === null) return;
    cancelTimer = deps.setTimer(
      () => {
        serialize(tickIfDue).catch(() => {
          console.error("scheduled poll failed");
        });
      },
      Math.max(0, due - deps.now()),
    );
  }

  function expireAttempt(): void {
    if (attempt && deps.now() >= attempt.expiresAt) {
      attempt = null;
      lastReason = "login_expired";
    }
  }

  function backoffAttempt(error: ApiError): void {
    if (!attempt) return;
    attempt.errors += 1;
    const waitS = Math.min(attempt.intervalS * 2 ** attempt.errors, DEVICE_MAX_INTERVAL_S);
    attempt.nextPollAt = deps.now() + waitS * 1000;
    lastError = errorCodeFor(error);
  }

  function backoffClaim(error: ApiError): void {
    claimErrors += 1;
    const waitS = Math.min(CLAIM_MIN_INTERVAL_S * 2 ** claimErrors, CLAIM_MAX_BACKOFF_S);
    nextClaimAt = deps.now() + waitS * 1000;
    lastError = errorCodeFor(error);
  }

  async function dropPending(reason: SignedOutReason): Promise<void> {
    await deps.store.deletePending();
    pending = null;
    nextClaimAt = null;
    claimErrors = 0;
    lastReason = reason;
    lastError = undefined;
  }

  async function holdPending(grant: {
    claim_token?: string;
    retry_after: number;
    email?: string;
  }): Promise<void> {
    const current = attempt;
    if (!current) return;
    if (!grant.claim_token) throw new ApiError("bad_response");
    const next: PendingFile = {
      version: 1,
      origin: current.origin,
      installId,
      claimToken: grant.claim_token,
      deviceName: current.deviceName,
      requestedAt: new Date(deps.now()).toISOString(),
      ...(grant.email ? { email: grant.email } : {}),
    };
    await deps.store.writePending(next);
    pending = next;
    attempt = null;
    claimErrors = 0;
    nextClaimAt = deps.now() + Math.max(CLAIM_MIN_INTERVAL_S, grant.retry_after) * 1000;
    lastError = undefined;
    lastReason = undefined;
  }

  async function applyApproved(
    grant: ApprovedGrant,
    origin: string,
    deviceName: string,
  ): Promise<void> {
    let key: string;
    if (!grant.renewed) {
      if (!grant.user_key) throw new ApiError("bad_response");
      key = grant.user_key;
    } else {
      const previous = credential;
      if (!previous || previous.origin !== origin || previous.keyId !== grant.key_id) {
        // The server renewed a key this device cannot prove it holds: start clean. What the old key set up in
        // the tools is removed as a log out would.
        if (previous) await deps.harness?.beginRemoval();
        await deps.store.deleteCredential();
        await deps.store.deletePending();
        credential = null;
        pending = null;
        attempt = null;
        nextClaimAt = null;
        lastError = undefined;
        lastReason = "key_mismatch";
        return;
      }
      key = previous.key;
    }
    const settings = await deps.readSettings();
    const user = grant.user;
    const teams =
      grant.teams ?? (await deps.api.teams(origin, settings.instanceId, key, user.user_id));
    const next: Credential = {
      version: 1,
      origin,
      instanceId: settings.instanceId,
      installId,
      keyId: grant.key_id,
      key,
      expiresAt: grant.expires_at,
      account: {
        userId: user.user_id,
        username: user.username ?? user.display_name ?? user.email ?? user.user_id,
        ...(user.email ? { email: user.email } : {}),
      },
      teams,
      deviceName,
      savedAt: new Date(deps.now()).toISOString(),
    };
    await deps.store.writeCredential(next);
    await deps.store.deletePending();
    credential = next;
    pending = null;
    attempt = null;
    nextClaimAt = null;
    claimErrors = 0;
    lastError = undefined;
    lastReason = undefined;
    console.log(`login approved (renewed=${grant.renewed}, key_id=${grant.key_id.slice(-4)})`);
    // A renewal keeps the key the clients already hold; only a newly issued key is set up.
    if (!grant.renewed) deps.harness?.configure(next);
  }

  async function pollAttempt(): Promise<void> {
    const current = attempt;
    if (!current) return;
    try {
      const grant = await deps.api.token(current.origin, current.deviceCode);
      if (stopped) return;
      if (grant.status === "approved") {
        await applyApproved(grant, current.origin, current.deviceName);
      } else {
        await holdPending(grant);
      }
    } catch (raw) {
      if (stopped) return;
      const error = asApiError(raw);
      if (error.kind === "protocol") {
        switch (error.code) {
          case "authorization_pending":
            current.errors = 0;
            current.nextPollAt = deps.now() + current.intervalS * 1000;
            lastError = undefined;
            return;
          case "slow_down":
            slowDown(current, undefined);
            return;
          case "expired_token":
            attempt = null;
            lastReason = "login_expired";
            return;
          case "access_denied":
            attempt = null;
            lastReason = "access_denied";
            return;
          case "key_limit_exceeded":
            attempt = null;
            lastReason = "key_limit";
            return;
          default:
            backoffAttempt(error);
            return;
        }
      }
      if (error.kind === "rate_limited") {
        slowDown(current, "rate_limited");
        return;
      }
      backoffAttempt(error);
    }
  }

  function slowDown(current: Attempt, code: ErrorCode | undefined): void {
    current.intervalS = Math.min(current.intervalS + DEVICE_SLOW_DOWN_STEP_S, DEVICE_MAX_INTERVAL_S);
    current.nextPollAt = deps.now() + current.intervalS * 1000;
    lastError = code;
  }

  async function claimPending(): Promise<void> {
    const current = pending;
    if (!current) return;
    try {
      const grant = await deps.api.claim(current.origin, {
        install_id: current.installId,
        claim_token: current.claimToken,
      });
      if (stopped) return;
      if (grant.status === "approved") {
        await applyApproved(grant, current.origin, current.deviceName);
      } else {
        claimErrors = 0;
        nextClaimAt = deps.now() + Math.max(CLAIM_MIN_INTERVAL_S, grant.retry_after) * 1000;
        lastError = undefined;
      }
    } catch (raw) {
      if (stopped) return;
      const error = asApiError(raw);
      if (error.kind === "protocol") {
        switch (error.code) {
          case "invalid_grant":
          case "expired_token":
            await dropPending("login_expired");
            return;
          case "access_denied":
            await dropPending("access_denied");
            return;
          case "key_limit_exceeded":
            await dropPending("key_limit");
            return;
          case "claim_in_progress":
            // Another request holds this claim; it is not a failure, ask again after the normal interval.
            nextClaimAt = deps.now() + CLAIM_MIN_INTERVAL_S * 1000;
            lastError = undefined;
            return;
        }
      }
      backoffClaim(error);
    }
  }

  async function tickIfDue(): Promise<void> {
    if (stopped) return;
    expireAttempt();
    const now = deps.now();
    if (attempt && now >= attempt.nextPollAt) {
      await pollAttempt();
    } else if (pending && nextClaimAt !== null && now >= nextClaimAt) {
      await claimPending();
    }
  }

  async function derive(): Promise<AccountStatus> {
    const settings = await deps.readSettings();
    expireAttempt();
    const now = deps.now();
    const error = { ...(lastError ? { lastError } : {}), ...deps.harness?.view() };
    if (attempt) {
      return {
        state: "waiting_browser",
        origin: attempt.origin,
        verificationUri: attempt.verificationUri,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
        ...error,
      };
    }
    if (pending) {
      return {
        state: "account_pending",
        origin: pending.origin,
        requestedAt: pending.requestedAt,
        ...(pending.email ? { email: pending.email } : {}),
        ...error,
      };
    }
    if (credential && settings.origin === credential.origin) {
      const expiresMs = Date.parse(credential.expiresAt);
      const account = {
        username: credential.account.username,
        ...(credential.account.email ? { email: credential.account.email } : {}),
      };
      if (expiresMs > now) {
        return {
          state: "connected",
          origin: credential.origin,
          account,
          teams: credential.teams,
          deviceName: credential.deviceName,
          expiresAt: new Date(expiresMs).toISOString(),
          renewDue: isRenewDue(expiresMs, now),
          ...error,
        };
      }
      return {
        state: "expired",
        origin: credential.origin,
        account,
        deviceName: credential.deviceName,
        expiredAt: Number.isNaN(expiresMs)
          ? credential.expiresAt
          : new Date(expiresMs).toISOString(),
        ...error,
      };
    }
    const origin = settings.origin ?? "";
    if (credential && settings.origin) {
      return { state: "signed_out", origin, reason: "server_changed", ...error };
    }
    if (settings.originError) {
      return { state: "signed_out", origin, reason: settings.originError, ...error };
    }
    return { state: "signed_out", origin, ...(lastReason ? { reason: lastReason } : {}), ...error };
  }

  function deviceNameFor(settings: MachineSettings): string {
    return sanitizeDeviceName(settings.deviceName || deps.hostName());
  }

  return {
    init(): Promise<void> {
      return serialize(async () => {
        installId = await deps.store.loadOrCreateInstallId();
        credential = await deps.store.readCredential();
        // A removal that the last run saved a marker for but did not finish, with the credential still stored:
        // the log out is finished here, so the user is not left logged in without the tools.
        if (credential && deps.harness?.resumedRemovalKeyId() === credential.keyId) {
          try {
            await deps.api.logout(credential.origin, installId, credential.key);
          } catch {
            // The server may be unreachable. The key then expires on its own.
          }
          await deps.store.deleteCredential();
          credential = null;
          lastReason = "logged_out";
        }
        pending = await deps.store.readPending();
        if (pending) nextClaimAt = deps.now();
      });
    },

    status: derive,

    poll(): Promise<AccountStatus> {
      return serialize(async () => {
        await tickIfDue();
        return derive();
      });
    },

    login(): Promise<AccountStatus> {
      return serialize(async () => {
        if (stopped) return derive();
        const settings = await deps.readSettings();
        if (!settings.origin) {
          lastReason = settings.originError ?? "invalid_base_url";
          return derive();
        }
        const origin = settings.origin;
        const deviceName = deviceNameFor(settings);
        const hasKey = credential !== null && credential.origin === origin;
        try {
          const started = await deps.api.start(origin, {
            install_id: installId,
            device_name: deviceName,
            has_key: hasKey,
          });
          if (stopped) return derive();
          await deps.store.deletePending();
          pending = null;
          nextClaimAt = null;
          claimErrors = 0;
          const now = deps.now();
          attempt = {
            origin,
            deviceCode: started.device_code,
            verificationUri: started.verification_uri_complete,
            expiresAt: now + started.expires_in * 1000,
            intervalS: started.interval,
            // The server counts the start call as the first poll.
            nextPollAt: now + started.interval * 1000,
            errors: 0,
            deviceName,
          };
          lastError = undefined;
          lastReason = undefined;
        } catch (raw) {
          if (!stopped) lastError = errorCodeFor(asApiError(raw));
        }
        return derive();
      });
    },

    logout(force: boolean): Promise<AccountStatus> {
      return serialize(async () => {
        if (stopped) return derive();
        lastError = undefined;
        if (attempt) {
          attempt = null;
          return derive();
        }
        if (pending) {
          await dropPending("logged_out");
          return derive();
        }
        if (credential) {
          let remove = false;
          try {
            await deps.api.logout(credential.origin, installId, credential.key);
            remove = true;
          } catch (raw) {
            if (stopped) return derive();
            const error = asApiError(raw);
            remove =
              force ||
              (error.kind === "protocol" &&
                (error.code === "invalid_token" || error.code === "unknown_device"));
            if (!remove) lastError = "logout_unreachable";
          }
          if (remove) {
            // The key is already expired on the server, or the user forced the removal. The "removal pending"
            // marker is saved first, then the credential goes, and the tool cleanup runs in the background, so
            // the log out never holds this lock for minutes. A client that cannot be cleaned is reported on the
            // screen, and a restart resumes a cleanup that did not finish.
            const begun = await deps.harness?.beginRemoval({ requireMarker: true });
            if (begun && !begun.marked) {
              // Without the marker a crash would strip the tools while the user stays logged in, so the
              // credential stays and the user can retry.
              lastError = "logout_failed";
              return derive();
            }
            await deps.store.deleteCredential();
            credential = null;
            lastReason = "logged_out";
          }
        }
        return derive();
      });
    },

    stop(): void {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
      deps.abort?.();
    },
  };
}

export type LoginMachine = ReturnType<typeof createLoginMachine>;
