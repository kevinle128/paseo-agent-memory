import { z } from "zod";
import { HTTP_TIMEOUT_MS } from "../shared/constants";
import { parseBaseUrl } from "../shared/base-url";

const Instances = z.object({
  instances: z.array(
    z.object({ instance_id: z.string(), proxy_endpoint: z.string().optional() }).loose(),
  ),
});

/**
 * The proxy origin of an instance, from the Panel's public instance list (the same field the Guide page
 * reads). Null when the Panel does not give a usable address: nothing is guessed.
 */
export async function fetchProxyOrigin(opts: {
  panelOrigin: string;
  instanceId: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, opts.timeoutMs ?? HTTP_TIMEOUT_MS);
  if (opts.signal.aborted) abort();
  else opts.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await (opts.fetch ?? fetch)(`${opts.panelOrigin}/api/v1/meta/instances`, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status !== 200) return null;
    const parsed = Instances.safeParse(await response.json());
    if (!parsed.success) return null;
    const match = parsed.data.instances.find((item) => item.instance_id === opts.instanceId);
    if (!match?.proxy_endpoint) return null;
    const origin = parseBaseUrl(match.proxy_endpoint.trim().replace(/\/+$/, ""));
    return origin.ok ? origin.origin : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", abort);
  }
}
