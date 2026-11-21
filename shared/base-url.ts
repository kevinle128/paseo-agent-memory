export type BaseUrlResult =
  | { ok: true; origin: string }
  | { ok: false; reason: "invalid" | "insecure" | "not_origin" };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Accepts an https origin, or an http origin on a loopback host (local tests only). */
export function parseBaseUrl(input: string): BaseUrlResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol === "https:") {
    // fall through to the origin checks
  } else if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, reason: "insecure" };
  } else {
    return { ok: false, reason: "invalid" };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: "not_origin" };
  }
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false, reason: "not_origin" };
  return { ok: true, origin: url.origin };
}
