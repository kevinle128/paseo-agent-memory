import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { HTTP_TIMEOUT_MS } from "../shared/constants";
import { searchDirs, type Paths } from "./harness-paths";

const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;
export const INSTALLER_TIMEOUT_MS = 90_000;

export interface InstallerRun {
  /** The proxy origin that serves `/setup/hooks.sh`. */
  proxyOrigin: string;
  /** Fixed arguments only: `--client`, `--base-url`, `--uninstall`. The key never goes here. */
  args: string[];
  paths: Paths;
  /** Reaches the installer through its environment (antigravity reads it), never through its arguments. */
  key?: string;
  signal: AbortSignal;
}

export interface InstallerResult {
  ok: boolean;
  reason?: "download" | "spawn" | "timeout" | "exit";
  exitCode?: number | null;
}

export type RunInstaller = (run: InstallerRun) => Promise<InstallerResult>;

/**
 * The environment is built from nothing, so a variable of the daemon (a token, a proxy setting) never reaches
 * the installer. CODEX_HOME and PI_CODING_AGENT_DIR are passed only when the daemon has them.
 */
export function installerEnv(
  paths: Paths,
  key: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {
    HOME: paths.home,
    SHELL: paths.shell,
    PATH: searchDirs(env, paths).join(delimiter),
    LANG: env.LANG ?? "C.UTF-8",
  };
  if (env.TMPDIR) out.TMPDIR = env.TMPDIR;
  if (env.USER) out.USER = env.USER;
  if (paths.codexHome) out.CODEX_HOME = paths.codexHome;
  if (paths.ompDir) out.PI_CODING_AGENT_DIR = paths.ompDir;
  if (key) out.AGENT_MEMORY_KEY = key;
  return out;
}

async function download(
  proxyOrigin: string,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, HTTP_TIMEOUT_MS);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await doFetch(`${proxyOrigin}/setup/hooks.sh`, {
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) return null;
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_SCRIPT_BYTES || !response.body) return null;
    // Counted by bytes while it streams, so an oversized body is never held in memory.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SCRIPT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return text.startsWith("#!") ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Runs the Agent-Memory hook installer the way the Guide page does (`curl .../setup/hooks.sh | bash -s -- ...`),
 * but with an argument list, so a value from the server is never part of a shell string.
 */
export function createInstallerRunner(
  opts: { fetch?: typeof fetch; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): RunInstaller {
  return async (run) => {
    const script = await download(run.proxyOrigin, run.signal, opts.fetch ?? fetch);
    if (script === null) return { ok: false, reason: "download" };
    return new Promise<InstallerResult>((resolve) => {
      const child = spawn("bash", ["-s", "--", ...run.args], {
        env: installerEnv(run.paths, run.key, opts.env),
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so a stop also ends what the script started (a sleeping `codex app-server`).
        detached: true,
      });
      let settled = false;
      let output = 0;
      let stopped = false;
      let reason: InstallerResult["reason"];
      const finish = (result: InstallerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.signal.removeEventListener("abort", stop);
        resolve(result);
      };
      const stop = () => {
        stopped = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      };
      const timer = setTimeout(() => {
        reason = "timeout";
        stop();
      }, opts.timeoutMs ?? INSTALLER_TIMEOUT_MS);
      run.signal.addEventListener("abort", stop, { once: true });
      // The output is read to be counted and dropped: the installer prints paths, and a log line must not
      // carry anything from it. Only the exit code is kept.
      const drain = (chunk: Buffer) => {
        output += chunk.length;
        if (output > MAX_OUTPUT_BYTES * 64) stop();
      };
      child.stdout.on("data", drain);
      child.stderr.on("data", drain);
      child.on("error", () => finish({ ok: false, reason: "spawn" }));
      // After a stop, a grandchild may keep the pipes open, so the exit of the script itself ends the run.
      child.on("exit", (code) => {
        if (stopped) finish({ ok: false, reason: reason ?? "exit", exitCode: code });
      });
      child.on("close", (code) =>
        finish(
          code === 0 ? { ok: true, exitCode: 0 } : { ok: false, reason: reason ?? "exit", exitCode: code },
        ),
      );
      child.stdin.on("error", () => undefined);
      child.stdin.end(script);
    });
  };
}
