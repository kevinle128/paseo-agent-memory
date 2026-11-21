import { describe, expect, it } from "vitest";
import { fetchProxyOrigin } from "../server/proxy-endpoint";

const signal = new AbortController().signal;

function respond(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;
}
const ask = (fetchImpl: typeof fetch, instanceId = "default") =>
  fetchProxyOrigin({ panelOrigin: "https://panel.example.net", instanceId, signal, fetch: fetchImpl });

describe("fetchProxyOrigin", () => {
  it("returns the origin of the matching instance, without a trailing slash", async () => {
    const list = {
      instances: [
        { instance_id: "other", proxy_endpoint: "https://other.example.net:1" },
        { instance_id: "default", name: "VTC", gateway_endpoint: "x", proxy_endpoint: "https://proxy.example.net:8097/" },
      ],
      capabilities: { analyticsEnabled: false },
    };
    expect(await ask(respond(200, list))).toBe("https://proxy.example.net:8097");
  });

  it("asks the public instance route with a GET and no credentials", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ instances: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await ask(spy);
    expect(seen?.url).toBe("https://panel.example.net/api/v1/meta/instances");
    expect(seen?.init.method).toBe("GET");
    expect(JSON.stringify(seen?.init.headers)).not.toMatch(/key|authorization/i);
  });

  it.each([
    ["no proxy_endpoint", { instances: [{ instance_id: "default" }] }],
    ["another instance only", { instances: [{ instance_id: "x", proxy_endpoint: "https://p.example.net" }] }],
    ["http on a remote host", { instances: [{ instance_id: "default", proxy_endpoint: "http://p.example.net" }] }],
    ["a path in the address", { instances: [{ instance_id: "default", proxy_endpoint: "https://p.example.net/a" }] }],
    ["not a url", { instances: [{ instance_id: "default", proxy_endpoint: "nope" }] }],
    ["a wrong shape", { items: [] }],
  ])("returns null for %s", async (_name, body) => {
    expect(await ask(respond(200, body))).toBeNull();
  });

  it("accepts http on loopback for local tests", async () => {
    const body = { instances: [{ instance_id: "default", proxy_endpoint: "http://127.0.0.1:8096" }] };
    expect(await ask(respond(200, body))).toBe("http://127.0.0.1:8096");
  });

  it("returns null on an error status, bad JSON and a network failure", async () => {
    expect(await ask(respond(500, {}))).toBeNull();
    expect(await ask(respond(200, "<html>"))).toBeNull();
    expect(await ask((async () => { throw new Error("down"); }) as typeof fetch)).toBeNull();
  });
});
