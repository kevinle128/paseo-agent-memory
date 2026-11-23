import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { delimiter } from "node:path";
import { createInstallerRunner, installerEnv, resolveBash } from "../server/hooks-installer";
import { searchDirs, type Paths } from "../server/harness-paths";

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

  it("builds the Windows environment from an allowlist", () => {
    const winPaths: Paths = {
      home: "C:\\Users\\an",
      shell: "C:\\Windows\\System32\\cmd.exe",
      codexHome: "C:\\Users\\an\\.codex",
      ompDir: "D:\\omp",
    };
    const source = {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\an\\AppData\\Local\\Temp",
      SECRET_TOKEN: "x",
      PATH: "C:\\Windows\\System32",
    };
    const env = installerEnv(winPaths, undefined, source, "win32");
    expect(env.SYSTEMROOT).toBe("C:\\Windows");
    expect(env.TEMP).toBe("C:\\Users\\an\\AppData\\Local\\Temp");
    expect(env.HOME).toBe("/c/Users/an");
    expect(env.CODEX_HOME).toBe("/c/Users/an/.codex");
    expect(env.PI_CODING_AGENT_DIR).toBe("/d/omp");
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("SECRET_TOKEN");
    expect(env.PATH).not.toContain("/usr/bin");
    expect(env.PATH).not.toContain("/opt/homebrew/bin");
    const posixHome = installerEnv(
      { ...winPaths, codexHome: "/c/Users/an/.codex", ompDir: "/d/omp" },
      undefined,
      source,
      "win32",
    );
    expect(posixHome.CODEX_HOME).toBe("/c/Users/an/.codex");
    expect(posixHome.PI_CODING_AGENT_DIR).toBe("/d/omp");
    const odd = installerEnv(
      { ...winPaths, home: "\\\\corp\\share\\an", codexHome: "C:\\\\Users\\\\an\\.codex" },
      undefined,
      source,
      "win32",
    );
    expect(odd.HOME).toBe("//corp/share/an");
    expect(odd.CODEX_HOME).toBe("/c/Users/an/.codex");
    const withBash = installerEnv(winPaths, undefined, source, "win32", "C:\\Program Files\\Git\\bin\\bash.exe");
    expect(withBash.PATH.split(";").slice(0, 2)).toEqual([
      "C:\\Program Files\\Git\\bin",
      "C:\\Program Files\\Git\\usr\\bin",
    ]);
    expect(withBash.PATH).not.toContain("/usr/bin");
  });

  it("keeps the Unix environment as it is", () => {
    const base = {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      SECRET_TOKEN: "x",
      ANTHROPIC_API_KEY: "y",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
    };
    const env = installerEnv(paths, undefined, base, "darwin");
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "SHELL"]);
    expect(env.HOME).toBe(paths.home);
    expect(env.SYSTEMROOT).toBeUndefined();
    expect(env.TEMP).toBeUndefined();
    expect(env.PATH).toBe(searchDirs(base, paths).join(delimiter));
    const linux = installerEnv({ ...paths, codexHome: "/c", ompDir: "/o" }, KEY, base, "linux");
    expect(linux.HOME).toBe(paths.home);
    expect(linux.CODEX_HOME).toBe("/c");
    expect(linux.PI_CODING_AGENT_DIR).toBe("/o");
    expect(linux.AGENT_MEMORY_KEY).toBe(KEY);
    expect(linux.SYSTEMROOT).toBeUndefined();
    expect(JSON.stringify(linux)).not.toContain("SECRET_TOKEN");
  });
});

describe("resolveBash", () => {
  it("finds Git Bash and never picks the WSL launcher", () => {
    const programFiles = "C:\\Program Files\\Git\\bin\\bash.exe";
    const wsl = "C:\\Windows\\System32\\bash.exe";
    const env = {
      PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd",
      SYSTEMROOT: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\an\\AppData\\Local",
    };
    const present = new Set([programFiles, wsl, "C:\\Program Files\\Git\\cmd\\git.exe"]);
    expect(resolveBash("win32", env, (file) => present.has(file))).toBe(programFiles);

    const x86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
    expect(
      resolveBash("win32", env, (file) => file === x86 || file.toLowerCase() === wsl.toLowerCase()),
    ).toBe(x86);

    const local = "C:\\Users\\an\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect(resolveBash("win32", env, (file) => file === local || file === wsl)).toBe(local);

    const customGit = "D:\\Tools\\Git\\cmd\\git.exe";
    const customBash = "D:\\Tools\\Git\\bin\\bash.exe";
    expect(
      resolveBash(
        "win32",
        { PATH: "C:\\Windows\\System32;D:\\Tools\\Git\\cmd", SYSTEMROOT: "C:\\Windows" },
        (file) => file === customGit || file === customBash || file === wsl,
      ),
    ).toBe(customBash);

    expect(
      resolveBash("win32", { PATH: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows" }, (file) =>
        /\\system32\\(bash|git)\.exe$/i.test(file),
      ),
    ).toBeNull();

    let called = false;
    expect(
      resolveBash("darwin", { PATH: "C:\\Windows\\System32" }, () => {
        called = true;
        return true;
      }),
    ).toBe("bash");
    expect(resolveBash("linux", {}, () => true)).toBe("bash");
    expect(called).toBe(false);
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

  it("returns redacted stderr and leaves stdout out of it", async () => {
    script.body = [
      "#!/usr/bin/env bash",
      "echo STDOUT_MARKER_SHOULD_STAY_HIDDEN",
      'echo "agent-memory install: bad $AGENT_MEMORY_KEY at $HOME/x" >&2',
      "exit 1",
      "",
    ].join("\n");
    const result = await runner()({
      proxyOrigin: origin,
      args: ["--client", "codex"],
      paths,
      key: KEY,
      redact: [KEY],
      signal: signal(),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const shown = (result.output ?? []).join("\n");
    expect(shown).toContain("***");
    expect(shown).toContain("~/x");
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain("STDOUT_MARKER_SHOULD_STAY_HIDDEN");
    expect(shown).not.toContain(dir);
  });

  it("redacts a key that arrives in two stderr writes", async () => {
    script.body = [
      "#!/usr/bin/env bash",
      "printf '%s' \"${AGENT_MEMORY_KEY:0:8}\" >&2",
      "sleep 0.2",
      "printf '%s at %s/x\\n' \"${AGENT_MEMORY_KEY:8}\" \"$HOME\" >&2",
      "exit 1",
      "",
    ].join("\n");
    const result = await runner()({
      proxyOrigin: origin,
      args: [],
      paths,
      key: KEY,
      redact: [KEY],
      signal: signal(),
    });
    const shown = (result.output ?? []).join("\n");
    expect(shown).toContain("***");
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain(KEY.slice(0, 8));
    expect(shown).not.toContain(dir);
  });

  it("reports spawn when no Git Bash is found", async () => {
    script.body = "#!/usr/bin/env bash\nexit 0\n";
    const result = await createInstallerRunner({
      platform: "win32",
      env: { PATH: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows" },
      exists: (file) => file.toLowerCase() === "c:\\windows\\system32\\bash.exe",
    })({ proxyOrigin: origin, args: [], paths, signal: signal() });
    expect(result).toEqual({ ok: false, reason: "spawn", exitCode: null });
  });

  describe("on Windows", () => {
    const bashExe = "C:\\Program Files\\Git\\bin\\bash.exe";
    const fakeSpawn = (taskkillCode: number | "error") => {
      const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end: () => undefined }),
        kills: 0,
        kill() {
          child.kills += 1;
          child.emit("exit", 1, null);
          return true;
        },
      });
      const spawnFn = ((file: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ file, args, options });
        if (file === bashExe) return child;
        const killer = Object.assign(new EventEmitter(), { unref: () => undefined });
        setImmediate(() => {
          if (taskkillCode === "error") killer.emit("error", new Error("ENOENT"));
          else {
            if (taskkillCode === 0) child.emit("exit", 1, null);
            killer.emit("exit", taskkillCode, null);
          }
        });
        return killer;
      }) as unknown as NonNullable<Parameters<typeof createInstallerRunner>[0]>["spawn"];
      return { calls, child, spawnFn };
    };
    const winRunner = (spawnFn: ReturnType<typeof fakeSpawn>["spawnFn"]) =>
      createInstallerRunner({
        platform: "win32",
        env: { PATH: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows" },
        exists: (file) => file === bashExe,
        spawn: spawnFn,
      });

    it("does not detach bash and ends a flooded run with one taskkill and no exit code", async () => {
      script.body = "#!/usr/bin/env bash\nexit 0\n";
      const fake = fakeSpawn(0);
      const pending = winRunner(fake.spawnFn)({ proxyOrigin: origin, args: [], paths, signal: signal() });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const chunk = Buffer.alloc(64 * 1024);
      for (let i = 0; i < 20; i += 1) fake.child.stdout.emit("data", chunk);
      expect(await pending).toEqual({ ok: false, reason: "exit", exitCode: null });
      expect(fake.calls[0].options.detached).toBe(false);
      const taskkills = fake.calls.filter((call) => call.file !== bashExe);
      expect(taskkills).toHaveLength(1);
      expect(taskkills[0].file).toBe("C:\\Windows\\System32\\taskkill.exe");
      expect(taskkills[0].args).toEqual(["/PID", "4242", "/T", "/F"]);
      expect(fake.child.kills).toBe(0);
    });

    it.each([1, "error"] as const)("falls back to child.kill() when taskkill fails (%s)", async (outcome) => {
      script.body = "#!/usr/bin/env bash\nexit 0\n";
      const fake = fakeSpawn(outcome);
      const controller = new AbortController();
      const pending = winRunner(fake.spawnFn)({ proxyOrigin: origin, args: [], paths, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      expect(await pending).toEqual({ ok: false, reason: "exit", exitCode: null });
      expect(fake.child.kills).toBe(1);
    });
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
