import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_NAME } from "../shared/constants";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * The directory sits beside, not inside, `plugin-settings`, so removing the plugin keeps the key
 * file and only a log out deletes it.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PASEO_AGENT_MEMORY_DATA_DIR;
  if (override) return expandHome(override);
  const home = env.PASEO_HOME ? expandHome(env.PASEO_HOME) : join(homedir(), ".paseo");
  return join(home, "plugin-data", DATA_DIR_NAME);
}

export async function ensureDataDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
