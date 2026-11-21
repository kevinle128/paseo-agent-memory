import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInstallerRunner, installerEnv } from "../server/hooks-installer";
import type { Paths } from "../server/harness-paths";

const KEY = "fake-device-key-0001";
let dir: string;
let server: Server;
let origin: string;
let script: { status: number; body: string; stream?: boolean };
let paths: Paths;
const signal = () => new AbortController().signal;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pam-installer-"));
  paths = { home: dir, shell: "/bin/zsh" };
  script = { status: 200, body: "" };
  server = createServer((req, res) => {
    res.writeHead(req.url === "/setup/hooks.sh" ? script.status : 404);
    if (script.stream) {
      // No Content-Length: the size is only known while the body streams.
      for (let at = 0; at < script.body.length; at += 65536) res.write(script.body.slice(at, at + 65536));
      res.end();
    } else res.end(script.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const recorder = (out: string) =>
  `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${out}.args'\nenv | cut -d= -f1 | sort > '${out}.env'\nprintf '%s' "$HOME" > '${out}.home'\nexit "\${EXIT:-0}"\n`;

describe("installerEnv", () => {
  it("builds the environment from nothing and passes the key only when it is given", () => {
    const base = { PATH: "/usr/bin", LANG: "en_US.UTF-8", SECRET_TOKEN: "x", ANTHROPIC_API_KEY: "y" };
    const env = installerEnv(paths, undefined, base);
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "SHELL"]);
    expect(env.CODEX_HOME).toBeUndefined();
    const withAll = installerEnv({ ...paths, codexHome: "/c", ompDir: "/o" }, KEY, base);
    expect(withAll).toMatchObject({ CODEX_HOME: "/c", PI_CODING_AGENT_DIR: "/o", AGENT_MEMORY_KEY: KEY });
    expect(JSON.stringify(withAll)).not.toContain("SECRET_TOKEN");
  });
});

describe("createInstallerRunner", () => {
  const runner = () => createInstallerRunner({ env: { PATH: "/usr/bin:/bin" } });

  it("runs the downloaded script with the given arguments and the temporary HOME", async () => {
    const out = join(dir, "run");
    script.body = recorder(out);
    const result = await runner()({
      proxyOrigin: origin,
      args: ["--client", "codex", "--base-url", `${origin}/codex/default`],
      paths,
      signal: signal(),
    });
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect((await readFile(`${out}.args`, "utf8")).trim().split("\n")).toEqual([
      "--client",
      "codex",
      "--base-url",
      `${origin}/codex/default`,
    ]);
    expect(await readFile(`${out}.home`, "utf8")).toBe(dir);
  });

  it("gives the key to antigravity through the environment and never through the arguments", async () => {
    const out = join(dir, "agy");
    script.body = recorder(out);
    await runner()({
      proxyOrigin: origin,
      args: ["--client", "antigravity", "--base-url", `${origin}/antigravity/default`],
      paths,
      key: KEY,
      signal: signal(),
    });
    expect(await readFile(`${out}.args`, "utf8")).not.toContain(KEY);
    expect(await readFile(`${out}.env`, "utf8")).toContain("AGENT_MEMORY_KEY");
  });

  it("reports a non-zero exit, a refused download and a script that is not a script", async () => {
    script.body = "#!/usr/bin/env bash\nexit 3\n";
    expect(await runner()({ proxyOrigin: origin, args: [], paths, signal: signal() })).toEqual({
      ok: false,
      reason: "exit",
      exitCode: 3,
    });
    script.status = 404;
    expect(await runner()({ proxyOrigin: origin, args: [], paths, signal: signal() })).toMatchObject({
      ok: false,
      reason: "download",
    });
    script.status = 200;
    script.body = "<html>not found</html>";
    expect(await runner()({ proxyOrigin: origin, args: [], paths, signal: signal() })).toMatchObject({
      ok: false,
      reason: "download",
    });
  });

  it("stops a script that runs too long", async () => {
    script.body = "#!/usr/bin/env bash\nsleep 30\n";
    const result = await createInstallerRunner({ env: { PATH: "/usr/bin:/bin" }, timeoutMs: 200 })({
      proxyOrigin: origin,
      args: [],
      paths,
      signal: signal(),
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("stops a script when the plugin stops", async () => {
    script.body = "#!/usr/bin/env bash\nsleep 30\n";
    const controller = new AbortController();
    const pending = runner()({ proxyOrigin: origin, args: [], paths, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ ok: false });
  });
});

describe("download size", () => {
  it("refuses a script over 1 MiB, whether or not the size is declared", async () => {
    const big = `#!/usr/bin/env bash\n${"#".repeat(1024 * 1024)}\nexit 0\n`;
    for (const stream of [false, true]) {
      script = { status: 200, body: big, stream };
      expect(await createInstallerRunner({ env: { PATH: "/usr/bin:/bin" } })({
        proxyOrigin: origin,
        args: [],
        paths,
        signal: signal(),
      })).toMatchObject({ ok: false, reason: "download" });
    }
  });

  it("counts bytes, not characters", async () => {
    const wide = `#!/usr/bin/env bash\n# ${"\u00e9".repeat(600 * 1024)}\nexit 0\n`;
    script = { status: 200, body: wide, stream: true };
    expect(await createInstallerRunner({ env: { PATH: "/usr/bin:/bin" } })({
      proxyOrigin: origin,
      args: [],
      paths,
      signal: signal(),
    })).toMatchObject({ ok: false, reason: "download" });
  });
});
