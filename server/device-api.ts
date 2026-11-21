import { z } from "zod";
import { HTTP_TIMEOUT_MS } from "../shared/constants";

// Server answers that mean "keep asking", not an error.
const EXPECTED_WAITING = new Set(["authorization_pending", "slow_down", "claim_in_progress"]);

export type ApiErrorKind =
  | "protocol"
  | "rate_limited"
  | "server_unavailable"
  | "network"
  | "bad_response";

/** Messages are fixed text: a key, device code or claim token never reaches an error or a log. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(`device api ${kind}${code ? ` (${code})` : ""}${status ? ` [${status}]` : ""}`);
    this.name = "ApiError";
  }
}

const StartResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  interval: z.number().positive(),
  expires_in: z.number().positive(),
});
export type StartResponse = z.infer<typeof StartResponse>;

const TeamList = z.array(z.object({ name: z.string(), role: z.string().optional() }));

const ApprovedResponse = z.object({
  status: z.literal("approved"),
  key_id: z.string().min(1),
  expires_at: z.string(),
  renewed: z.boolean(),
  user_key: z.string().optional(),
  user: z.object({
    user_id: z.string().min(1),
    username: z.string().optional(),
    email: z.string().optional(),
    display_name: z.string().optional(),
  }),
  // A malformed list must not fail a login that otherwise succeeded.
  teams: TeamList.optional().catch(undefined),
});

const PendingResponse = z.object({
  status: z.literal("account_pending"),
  claim_token: z.string().min(1).optional(),
  retry_after: z.number().positive(),
  email: z.string().optional(),
});

const GrantResponse = z.discriminatedUnion("status", [ApprovedResponse, PendingResponse]);
export type GrantResponse = z.infer<typeof GrantResponse>;
export type ApprovedGrant = z.infer<typeof ApprovedResponse>;

const ErrorBody = z.object({ error: z.string() });
const TeamListBody = z.object({
  items: z.array(z.object({ name: z.string() }).loose()),
});

export interface DeviceApiOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal: AbortSignal;
}

interface Call {
  route: string;
  url: string;
  headers?: Record<string, string>;
  body: unknown;
}

export function createDeviceApi(opts: DeviceApiOptions) {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;

  async function send(call: Call): Promise<{ status: number; json: unknown }> {
    // One controller covers the timeout and the plugin's shutdown signal, for the body read too.
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await doFetch(call.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...call.headers,
        },
        body: JSON.stringify(call.body),
        signal: controller.signal,
      });
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        if (controller.signal.aborted) throw new Error("aborted");
        json = undefined;
      }
      return { status: response.status, json };
    } catch {
      console.error(`${call.route} failed (network)`);
      throw new ApiError("network");
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", abort);
    }
  }

  function fail(route: string, status: number, json: unknown): never {
    const body = ErrorBody.safeParse(json);
    const code = body.success ? body.data.error : undefined;
    // Waiting for the person to log in is the normal state of a device login, not a failure.
    const log = code && EXPECTED_WAITING.has(code) ? console.log : console.error;
    log(`${route} ${code && EXPECTED_WAITING.has(code) ? "waiting" : "failed"} (${status}${code ? ` ${code}` : ""})`);
    if (status === 429) throw new ApiError("rate_limited", code, status);
    if (status >= 500) throw new ApiError("server_unavailable", code, status);
    if (code) throw new ApiError("protocol", code, status);
    throw new ApiError("bad_response", undefined, status);
  }

  async function post<T>(call: Call, schema: z.ZodType<T>): Promise<T> {
    const { status, json } = await send(call);
    if (status !== 200) fail(call.route, status, json);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      console.error(`${call.route} failed (bad_response)`);
      throw new ApiError("bad_response", undefined, status);
    }
    return parsed.data;
  }

  const deviceUrl = (origin: string, name: string) => `${origin}/api/v1/ext/vtc/device/${name}`;

  return {
    async start(
      origin: string,
      body: { install_id: string; device_name: string; has_key: boolean },
    ): Promise<StartResponse> {
      const response = await post(
        { route: "device/start", url: deviceUrl(origin, "start"), body },
        StartResponse,
      );
      // A misconfigured Panel must not send the person to another site.
      let sameOrigin = false;
      try {
        sameOrigin = new URL(response.verification_uri_complete).origin === origin;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        console.error("device/start failed (bad_response)");
        throw new ApiError("bad_response");
      }
      return response;
    },

    token(origin: string, deviceCode: string): Promise<GrantResponse> {
      return post(
        {
          route: "device/token",
          url: deviceUrl(origin, "token"),
          body: { device_code: deviceCode },
        },
        GrantResponse,
      );
    },

    claim(
      origin: string,
      body: { install_id: string; claim_token: string },
    ): Promise<GrantResponse> {
      return post({ route: "device/claim", url: deviceUrl(origin, "claim"), body }, GrantResponse);
    },

    async logout(origin: string, installId: string, key: string): Promise<void> {
      const { status, json } = await send({
        route: "device/logout",
        url: deviceUrl(origin, "logout"),
        headers: { "x-tdai-user-key": key },
        body: { install_id: installId },
      });
      if (status !== 200) fail("device/logout", status, json);
    },

    /** Best effort. Any failure returns an empty list, so the screen just hides the team row. */
    async teams(
      origin: string,
      instanceId: string,
      key: string,
      userId: string,
    ): Promise<{ name: string; role?: string }[]> {
      try {
        const { status, json } = await send({
          route: "team/list",
          url: `${origin}/api/v1/meta/team/list`,
          headers: { "x-tdai-service-id": instanceId, "x-tdai-user-key": key },
          body: { user_id: userId },
        });
        if (status !== 200) {
          console.log(`team list unavailable (${status})`);
          return [];
        }
        // The Panel proxy wraps results as { code, data }; accept a bare page too.
        const record = json as { code?: unknown; data?: unknown } | undefined;
        const page = TeamListBody.safeParse(
          record && typeof record === "object" && "data" in record ? record.data : json,
        );
        if (!page.success) {
          console.log("team list unavailable (parse)");
          return [];
        }
        return page.data.items.map((item) => ({ name: item.name }));
      } catch {
        console.log("team list unavailable (network)");
        return [];
      }
    },
  };
}

export type DeviceApi = ReturnType<typeof createDeviceApi>;
