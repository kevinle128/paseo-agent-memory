import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRoute =
  | "start"
  | "token"
  | "claim"
  | "logout"
  | "team-list"
  | "inventory-replace"
  | "inventory-list";

const PATHS: Record<string, FakeRoute> = {
  "/api/v1/ext/vtc/device/start": "start",
  "/api/v1/ext/vtc/device/token": "token",
  "/api/v1/ext/vtc/device/claim": "claim",
  "/api/v1/ext/vtc/device/logout": "logout",
  "/api/v1/meta/team/list": "team-list",
  "/api/v1/skill/local-inventory/replace": "inventory-replace",
  "/api/v1/skill/local-inventory/list": "inventory-list",
};

export interface Scripted {
  status?: number;
  /** A function receives the fake origin, for fields that must point back to the Panel. */
  body?: unknown | ((origin: string) => unknown);
  headers?: Record<string, string>;
  /** Never answer: used to test timeouts and aborts. */
  hang?: boolean;
  /** Send raw text instead of JSON. */
  raw?: string;
}

export interface RecordedRequest {
  route: FakeRoute;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakePanel {
  origin: string;
  requests: RecordedRequest[];
  /** Queue one response for a route; the last one repeats nothing, an empty queue answers 500. */
  queue(route: FakeRoute, ...responses: Scripted[]): void;
  count(route: FakeRoute): number;
  close(): Promise<void>;
}

export async function startFakePanel(): Promise<FakePanel> {
  const queues: Record<FakeRoute, Scripted[]> = {
    start: [],
    token: [],
    claim: [],
    logout: [],
    "team-list": [],
    "inventory-replace": [],
    "inventory-list": [],
  };
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let origin = "";

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const route = PATHS[req.url ?? ""];
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      requests.push({ route, headers: req.headers, body });
      const scripted = queues[route].shift();
      if (!scripted) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unscripted" }));
        return;
      }
      if (scripted.hang) return;
      if (scripted.raw !== undefined) {
        res.writeHead(scripted.status ?? 200, scripted.headers);
        res.end(scripted.raw);
        return;
      }
      const payload = typeof scripted.body === "function" ? scripted.body(origin) : scripted.body;
      res.writeHead(scripted.status ?? 200, {
        "content-type": "application/json",
        ...scripted.headers,
      });
      res.end(JSON.stringify(payload ?? {}));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    requests,
    queue(route, ...responses) {
      queues[route].push(...responses);
    },
    count: (route) => requests.filter((request) => request.route === route).length,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
