import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { HTTP_TIMEOUT_MS } from "../shared/constants";
import type { HookFailureReason } from "../shared/harness";
import { searchDirs, type Paths } from "./harness-paths";
import { rememberStderr, sanitizeOutput, STDERR_TAIL_BYTES } from "./installer-output";

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
  /** Values removed from stderr before it is shown. Never placed in the environment or the arguments. */
  redact?: string[];
  signal: AbortSignal;
}

export interface InstallerResult {
  ok: boolean;
  reason?: HookFailureReason;
  exitCode?: number | null;
  /** Redacted stderr lines for the account screen. Never logged and never stored. */
  output?: string[];
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
      let counted = 0;
      let stderr: Uint8Array = Buffer.alloc(0);
      let stderrTruncated = false;
      let stopped = false;
      let reason: InstallerResult["reason"];
      const failed = (result: Omit<InstallerResult, "ok" | "output">): InstallerResult => {
        const output = sanitizeOutput(stderr, {
          secrets: run.redact ?? [],
          home: run.paths.home,
          truncated: stderrTruncated,
        });
        return { ok: false, ...result, ...(output.length > 0 ? { output } : {}) };
      };
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
      // Stdout is counted and dropped. Stderr is kept only long enough to build a redacted excerpt for the
      // account screen. A log line still carries nothing from either stream.
      const count = (chunk: Buffer) => {
        counted += chunk.length;
        if (counted > MAX_OUTPUT_BYTES * 64) stop();
      };
      child.stdout.on("data", count);
      child.stderr.on("data", (chunk: Buffer) => {
        count(chunk);
        const next = rememberStderr(stderr, chunk, STDERR_TAIL_BYTES);
        stderr = next.buffer;
        if (next.truncated) stderrTruncated = true;
      });
      child.on("error", () => finish(failed({ reason: "spawn", exitCode: null })));
      // After a stop, a grandchild may keep the pipes open, so the exit of the script itself ends the run.
      child.on("exit", (code) => {
        if (stopped) finish(failed({ reason: reason ?? "exit", exitCode: code }));
      });
      child.on("close", (code) =>
        finish(
          code === 0
            ? { ok: true, exitCode: 0 }
            : failed({ reason: reason ?? "exit", exitCode: code }),
        ),
      );
      child.stdin.on("error", () => undefined);
      child.stdin.end(script);
    });
  };
}
