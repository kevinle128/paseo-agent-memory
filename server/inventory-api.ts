import { z } from "zod";
import { HTTP_TIMEOUT_MS } from "../shared/constants";
import { InventoryErrorCode, type LocalInventoryRow } from "../shared/inventory";
import { buildReplacePayload, type ScannedSkill } from "./skill-scanner";

/** Fixed text only: a key, header, path, or file body never reaches an error or a log. */
export class InventoryApiError extends Error {
  constructor(readonly kind: InventoryErrorCode) {
    super(`inventory api ${kind}`);
    this.name = "InventoryApiError";
  }
}

export interface InventoryApiOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal: AbortSignal;
}

const Envelope = z.object({
  code: z.number(),
  data: z.unknown().optional(),
});

function kindFor(status: number, json: unknown): InventoryErrorCode | "ok" {
  const parsed = Envelope.safeParse(json);
  const code = parsed.success ? parsed.data.code : undefined;
  if (status === 401 || code === 401) return "auth_failed";
  if (status >= 500 || (code !== undefined && code >= 50_000)) return "server_unavailable";
  if (status === 200 && code === 0) return "ok";
  return "bad_response";
}

export function createInventoryApi(opts: InventoryApiOptions) {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;

  async function send(
    route: string,
    url: string,
    instanceId: string,
    key: string,
    body: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await doFetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-tdai-service-id": instanceId,
          "x-tdai-user-key": key,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
      if (controller.signal.aborted) throw new InventoryApiError("network");
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof InventoryApiError) throw error;
      console.error(`${route} failed (network)`);
      throw new InventoryApiError("network");
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", abort);
    }
  }

  function interpret(route: string, status: number, json: unknown): z.infer<typeof Envelope> | never {
    const kind = kindFor(status, json);
    if (kind !== "ok") {
      console.error(`${route} failed (${kind})`);
      throw new InventoryApiError(kind);
    }
    const parsed = Envelope.safeParse(json);
    if (!parsed.success) {
      console.error(`${route} failed (bad_response)`);
      throw new InventoryApiError("bad_response");
    }
    return parsed.data;
  }

  return {
    async replace(
      origin: string,
      instanceId: string,
      key: string,
      machineId: string,
      items: readonly ScannedSkill[],
    ): Promise<void> {
      const body = buildReplacePayload({ userKey: key, machineId, items });
      const { status, json } = await send(
        "inventory/replace",
        `${origin}/api/v1/skill/local-inventory/replace`,
        instanceId,
        key,
        body,
      );
      interpret("inventory/replace", status, json);
    },

    async list(
      origin: string,
      instanceId: string,
      key: string,
      machineId: string,
    ): Promise<unknown[]> {
      const { status, json } = await send(
        "inventory/list",
        `${origin}/api/v1/skill/local-inventory/list`,
        instanceId,
        key,
        { user_key: key, machine_id: machineId },
      );
      const envelope = interpret("inventory/list", status, json);
      const page = z.object({ items: z.array(z.unknown()) }).safeParse(envelope.data);
      if (!page.success) {
        console.error("inventory/list failed (bad_response)");
        throw new InventoryApiError("bad_response");
      }
      return page.data.items;
    },
  };
}

export type InventoryApi = ReturnType<typeof createInventoryApi>;

/** Rows the screen may keep. Callers still apply the relative-path allowlist. */
export type InventoryListRow = LocalInventoryRow;
