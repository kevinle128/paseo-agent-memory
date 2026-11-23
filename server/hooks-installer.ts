import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { HTTP_TIMEOUT_MS } from "../shared/constants";
import type { HookFailureReason } from "../shared/harness";
import { searchDirs, type Paths } from "./harness-paths";
import { rememberStderr, sanitizeOutput, STDERR_TAIL_BYTES } from "./installer-output";

const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;
export const INSTALLER_TIMEOUT_MS = 90_000;

/** System variables Git Bash and Windows tools need. Everything else stays out of the installer. */
const WINDOWS_ENV = [
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
] as const;

const HOME_BINS = [
  [".local", "bin"],
  [".bun", "bin"],
  [".npm-global", "bin"],
  [".claude", "local"],
] as const;

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

export type FileExists = (file: string) => boolean;

/**
 * The environment is built from nothing, so a variable of the daemon (a token, a proxy setting) never reaches
 * the installer. CODEX_HOME and PI_CODING_AGENT_DIR are passed only when the daemon has them.
 * On Windows, Git Bash also receives a short allowlist of system variables, and Windows paths are rewritten
 * to the form the installer accepts (`C:\Users\x` becomes `/c/Users/x`).
 */
export function installerEnv(
  paths: Paths,
  key: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  bashPath?: string | null,
): Record<string, string> {
  const out: Record<string, string> = {
    HOME: platform === "win32" ? toGitBashPath(paths.home) : paths.home,
    SHELL: paths.shell,
    PATH: childPath(env, paths, platform, bashPath),
    LANG: env.LANG ?? "C.UTF-8",
  };
  if (env.TMPDIR) out.TMPDIR = env.TMPDIR;
  if (env.USER) out.USER = env.USER;
  if (paths.codexHome) out.CODEX_HOME = platform === "win32" ? toGitBashPath(paths.codexHome) : paths.codexHome;
  if (paths.ompDir) out.PI_CODING_AGENT_DIR = platform === "win32" ? toGitBashPath(paths.ompDir) : paths.ompDir;
  if (platform === "win32") {
    for (const name of WINDOWS_ENV) {
      const value = envValue(env, name);
      if (value) out[name] = value;
    }
  }
  if (key) out.AGENT_MEMORY_KEY = key;
  return out;
}

/**
 * Windows services often have Git for Windows on PATH only as `Git\cmd\git.exe`, not `bash`.
 * Git Bash is taken from its install directories, or from the directory of the `git.exe` that is on PATH.
 * `System32\bash.exe` is the WSL launcher and is never selected. Other platforms keep the bare `bash` name.
 */
export function resolveBash(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: FileExists,
): string | null {
  if (platform !== "win32") return "bash";
  for (const candidate of gitBashCandidates(env)) {
    if (isWslBash(candidate, env)) continue;
    if (exists(candidate)) return candidate;
  }
  const pathValue = envValue(env, "PATH") ?? "";
  for (const entry of pathValue.split(";")) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    const git = path.win32.normalize(path.win32.join(dir, "git.exe"));
    if (!exists(git)) continue;
    const bash = path.win32.normalize(path.win32.join(dir, "..", "bin", "bash.exe"));
    if (isWslBash(bash, env) || !exists(bash)) continue;
    return bash;
  }
  return null;
}

/** `C:\Users\x` and `C:/Users/x` become `/c/Users/x`. A path that is already POSIX is left as it is. */
function toGitBashPath(value: string): string {
  const unc = /^[/\\]{2}([^/\\].*)$/.exec(value);
  if (unc) return `//${unc[1].replace(/[/\\]+/g, "/")}`;
  const match = /^([A-Za-z]):(?:[/\\](.*))?$/.exec(value);
  if (!match) return value;
  const rest = (match[2] ?? "").replace(/[/\\]+/g, "/").replace(/^\/+|\/+$/g, "");
  return rest.length > 0 ? `/${match[1].toLowerCase()}/${rest}` : `/${match[1].toLowerCase()}`;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const programFiles = envValue(env, "ProgramFiles") ?? "C:\\Program Files";
  const programFilesX86 = envValue(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
  const localAppData = envValue(env, "LOCALAPPDATA");
  const roots = [
    envValue(env, "ProgramW6432"),
    programFiles,
    "C:\\Program Files",
    programFilesX86,
    "C:\\Program Files (x86)",
  ].filter((root): root is string => Boolean(root));
  const files = roots.map((root) => path.win32.normalize(path.win32.join(root, "Git", "bin", "bash.exe")));
  if (localAppData) {
    files.push(path.win32.normalize(path.win32.join(localAppData, "Programs", "Git", "bin", "bash.exe")));
  }
  return dedupe(files);
}

function isWslBash(file: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = path.win32.normalize(file).toLowerCase();
  if (normalized.endsWith("\\system32\\bash.exe")) return true;
  const root = envValue(env, "SYSTEMROOT") ?? envValue(env, "WINDIR") ?? "C:\\Windows";
  const launcher = path.win32.normalize(path.win32.join(root, "System32", "bash.exe")).toLowerCase();
  return normalized === launcher;
}

function childPath(
  env: NodeJS.ProcessEnv,
  paths: Paths,
  platform: NodeJS.Platform,
  bashPath?: string | null,
): string {
  if (platform !== "win32") return searchDirs(env, paths).join(path.delimiter);
  // Git Bash's own bin and usr\bin (mkdir, sed, grep, mktemp) have to precede System32.
  // Windows ships different programs under some of the same names, and the fixed Unix directories
  // used on macOS and Linux are not added here.
  const gitDirs = bashPath ? gitToolDirs(bashPath) : [];
  const fromEnv = (envValue(env, "PATH") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const homeBins = HOME_BINS.map((parts) => path.win32.join(paths.home, ...parts));
  return dedupe([...gitDirs, ...fromEnv, ...homeBins]).join(";");
}

function gitToolDirs(bashPath: string): string[] {
  const binDir = path.win32.dirname(path.win32.normalize(bashPath));
  const root = path.win32.dirname(binDir);
  return [binDir, path.win32.join(root, "usr", "bin")];
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function taskkillExe(env: NodeJS.ProcessEnv): string {
  const root = envValue(env, "SYSTEMROOT") ?? envValue(env, "WINDIR") ?? "C:\\Windows";
  return path.win32.join(root, "System32", "taskkill.exe");
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
  opts: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: FileExists;
  } = {},
): RunInstaller {
  const platform = opts.platform ?? process.platform;
  const baseEnv = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  return async (run) => {
    const bash = resolveBash(platform, baseEnv, exists);
    if (bash === null) return { ok: false, reason: "spawn", exitCode: null };
    const script = await download(run.proxyOrigin, run.signal, opts.fetch ?? fetch);
    if (script === null) return { ok: false, reason: "download" };
    return new Promise<InstallerResult>((resolve) => {
      const child = spawn(bash, ["-s", "--", ...run.args], {
        env: installerEnv(run.paths, run.key, baseEnv, platform, bash),
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so a stop also ends what the script started (a sleeping `codex app-server`).
        detached: true,
        windowsHide: true,
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
        // A flood of output calls stop() on every chunk; one taskkill is enough.
        if (stopped && platform === "win32") return;
        stopped = true;
        if (platform === "win32") {
          // A negative pid does not signal a Windows process tree. taskkill /T ends bash and what it started.
          if (!child.pid) {
            child.kill();
            return;
          }
          const killer = spawn(taskkillExe(baseEnv), ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.unref();
          const fallback = () => {
            try {
              child.kill();
            } catch {
              // The process may already be gone.
            }
          };
          killer.on("error", fallback);
          killer.on("exit", (code) => {
            if (code !== 0) fallback();
          });
          return;
        }
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
