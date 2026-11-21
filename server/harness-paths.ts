import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import type { HarnessId } from "../shared/harness";

/**
 * Where each client keeps its files. `codexHome` and `ompDir` are set only when the daemon environment
 * sets them: the installer must see the same variables, and Codex derives hook trust keys differently
 * when CODEX_HOME is set.
 */
export interface Paths {
  home: string;
  codexHome?: string;
  ompDir?: string;
  shell: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): Paths {
  let shell = env.SHELL;
  if (!shell) {
    try {
      shell = userInfo().shell ?? undefined;
    } catch {
      shell = undefined;
    }
  }
  return {
    home,
    ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}),
    ...(env.PI_CODING_AGENT_DIR ? { ompDir: env.PI_CODING_AGENT_DIR } : {}),
    shell: shell || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
  };
}

export const claudeDir = (p: Paths) => join(p.home, ".claude");
export const claudeSettingsFile = (p: Paths) => join(claudeDir(p), "settings.json");
export const codexDir = (p: Paths) => p.codexHome ?? join(p.home, ".codex");
export const codexConfigFile = (p: Paths) => join(codexDir(p), "config.toml");
export const ompAgentDir = (p: Paths) => p.ompDir ?? join(p.home, ".omp", "agent");
export const agyDataDir = (p: Paths) => join(p.home, ".gemini", "antigravity-cli");
/** The file `agy mcp add` writes; agy reads it for every launch. */
export const agyMcpFile = (p: Paths) => join(p.home, ".gemini", "config", "mcp_config.json");
export const agyUrlFile = (p: Paths) => join(p.home, ".agent-memory", "antigravity.url");

const CLI_NAME: Record<HarnessId, string> = {
  claude: "claude",
  codex: "codex",
  omp: "omp",
  agy: "agy",
};

/** A daemon started from an app often has a short PATH, so the usual install directories are added. */
export function searchDirs(env: NodeJS.ProcessEnv, p: Paths): string[] {
  const fromEnv = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const extra = [
    join(p.home, ".local", "bin"),
    join(p.home, ".bun", "bin"),
    join(p.home, ".npm-global", "bin"),
    join(p.home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [...new Set([...fromEnv, ...extra])];
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A client counts as installed when its CLI is an executable in a search directory, or its own config
 * directory exists (the desktop app, or a CLI outside the search path, still leaves the directory).
 */
export async function detectHarnesses(
  p: Paths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessId[]> {
  const dirs = searchDirs(env, p);
  const configDir: Record<HarnessId, string> = {
    claude: claudeDir(p),
    codex: codexDir(p),
    omp: ompAgentDir(p),
    agy: agyDataDir(p),
  };
  const found: HarnessId[] = [];
  for (const id of Object.keys(CLI_NAME) as HarnessId[]) {
    let installed = await isDirectory(configDir[id]);
    for (const dir of installed ? [] : dirs) {
      if (await isExecutableFile(join(dir, CLI_NAME[id]))) {
        installed = true;
        break;
      }
    }
    if (installed) found.push(id);
  }
  return found;
}
