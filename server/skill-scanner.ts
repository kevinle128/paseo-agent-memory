import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { HarnessId } from "../shared/harness";
import {
  LocalInventoryItem,
  localSkillNameError,
  relativeSkillPathError,
  type InventorySource,
} from "../shared/inventory";
import {
  agyDataDir,
  codexDir,
  detectHarnesses,
  ompAgentDir,
  type Paths,
} from "./harness-paths";

/** One skill folder the walker accepted. The payload builder checks it again. */
export interface ScannedSkill {
  harness: HarnessId;
  source: InventorySource;
  name: string;
  root_kind: string;
  relative_path: string;
  content_hash: string;
}

/** Passed only by tests. Production leaves this empty so no live plugin cache is guessed. */
export interface ThirdPartyRoot {
  dir: string;
  harness: HarnessId;
  rootKind?: string;
}

export interface ScanArgs {
  paths: Paths;
  env?: NodeJS.ProcessEnv;
  workspaces?: readonly string[];
  thirdPartyRoots?: readonly ThirdPartyRoot[];
  detect?: typeof detectHarnesses;
}

interface RootSpec {
  harness: HarnessId;
  source: "user" | "project";
  rootKind: string;
  dir: string;
  /** Set for project roots so two workspaces can share a skill folder name. */
  pathPrefix?: string;
}

function userRoots(paths: Paths): RootSpec[] {
  return [
    { harness: "claude", source: "user", rootKind: "claude_user", dir: join(paths.home, ".claude", "skills") },
    { harness: "codex", source: "user", rootKind: "codex_agents_user", dir: join(paths.home, ".agents", "skills") },
    { harness: "codex", source: "user", rootKind: "codex_user", dir: join(codexDir(paths), "skills") },
    { harness: "omp", source: "user", rootKind: "omp_user", dir: join(ompAgentDir(paths), "skills") },
    { harness: "agy", source: "user", rootKind: "agy_config_user", dir: join(paths.home, ".gemini", "config", "skills") },
    { harness: "agy", source: "user", rootKind: "agy_cli_user", dir: join(agyDataDir(paths), "skills") },
    { harness: "agy", source: "user", rootKind: "agy_gemini_user", dir: join(paths.home, ".gemini", "skills") },
  ];
}

/**
 * Hash of the canonical workspace. The workspace path, home directory, and
 * username are not copied into the skill's relative path.
 */
function projectPathPrefix(canonicalWorkspace: string): string {
  const digest = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 12);
  return `ws-${digest}`;
}

function projectRoots(workspace: string, canonicalWorkspace: string): RootSpec[] {
  const pathPrefix = projectPathPrefix(canonicalWorkspace);
  return [
    { harness: "claude", source: "project", rootKind: "claude_project", dir: join(workspace, ".claude", "skills"), pathPrefix },
    { harness: "codex", source: "project", rootKind: "codex_project", dir: join(workspace, ".agents", "skills"), pathPrefix },
  ];
}

async function pathIdentities(input: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!input) return ids;
  ids.add(input);
  const resolved = resolve(input);
  ids.add(resolved);
  for (const candidate of [input, resolved]) {
    try {
      ids.add(await realpath(candidate));
    } catch {
      // Missing paths still compare by the raw and resolved spellings.
    }
  }
  return ids;
}

function sharesIdentity(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  const resolved = resolve(workspace);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function isStrictlyInside(parentReal: string, targetReal: string): boolean {
  const prefix = parentReal.endsWith(sep) ? parentReal : parentReal + sep;
  return targetReal.startsWith(prefix);
}

/**
 * Hash `SKILL.md` only when the skill directory and the file both resolve
 * inside the root. A symlink whose target leaves the root is skipped unread.
 */
async function hashContainedSkill(
  rootReal: string,
  skillDir: string,
  skillFile: string,
): Promise<string | null> {
  let skillReal: string;
  let fileReal: string;
  try {
    skillReal = await realpath(skillDir);
    fileReal = await realpath(skillFile);
  } catch {
    return null;
  }
  if (!isStrictlyInside(rootReal, skillReal) || !isStrictlyInside(rootReal, fileReal)) return null;
  if (!isStrictlyInside(skillReal, fileReal)) return null;
  try {
    const fileStat = await lstat(fileReal);
    if (!fileStat.isFile()) return null;
    const bytes = await readFile(fileReal);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

async function scanFlatRoot(root: RootSpec, push: (item: ScannedSkill) => void): Promise<void> {
  if (!(await isDirectory(root.dir))) return;
  let rootReal: string;
  try {
    rootReal = await realpath(root.dir);
  } catch {
    return;
  }
  let entries;
  try {
    entries = await readdir(root.dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (localSkillNameError(entry.name)) continue;
    const relativePath = root.pathPrefix ? `${root.pathPrefix}/${entry.name}/SKILL.md` : `${entry.name}/SKILL.md`;
    if (relativeSkillPathError(relativePath)) continue;
    const skillDir = join(root.dir, entry.name);
    let dirStat;
    try {
      dirStat = await stat(skillDir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const contentHash = await hashContainedSkill(rootReal, skillDir, join(skillDir, "SKILL.md"));
    if (!contentHash) continue;
    push({
      harness: root.harness,
      source: root.source,
      name: entry.name,
      root_kind: root.rootKind,
      relative_path: relativePath,
      content_hash: contentHash,
    });
  }
}

async function scanThirdParty(root: ThirdPartyRoot, push: (item: ScannedSkill) => void): Promise<void> {
  if (!(await isDirectory(root.dir))) return;
  let rootReal: string;
  try {
    rootReal = await realpath(root.dir);
  } catch {
    return;
  }
  let plugins;
  try {
    plugins = await readdir(root.dir, { withFileTypes: true });
  } catch {
    return;
  }
  const rootKind = root.rootKind ?? `${root.harness}_third_party`;
  for (const plugin of plugins) {
    if (!plugin.isDirectory() && !plugin.isSymbolicLink()) continue;
    if (localSkillNameError(plugin.name)) continue;
    const skillsDir = join(root.dir, plugin.name, "skills");
    if (!(await isDirectory(skillsDir))) continue;
    let skills;
    try {
      skills = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const skill of skills) {
      if (!skill.isDirectory() && !skill.isSymbolicLink()) continue;
      if (localSkillNameError(skill.name)) continue;
      const relativePath = `${plugin.name}/skills/${skill.name}/SKILL.md`;
      if (relativeSkillPathError(relativePath)) continue;
      const skillDir = join(skillsDir, skill.name);
      let dirStat;
      try {
        dirStat = await stat(skillDir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;
      const contentHash = await hashContainedSkill(rootReal, skillDir, join(skillDir, "SKILL.md"));
      if (!contentHash) continue;
      push({
        harness: root.harness,
        source: "third_party_plugin",
        name: skill.name,
        root_kind: rootKind,
        relative_path: relativePath,
        content_hash: contentHash,
      });
    }
  }
}

/**
 * Walk the skill folders this plugin can set up. `paths.home` is used only
 * to choose directories and to skip a workspace that is the home directory.
 * It is not copied into the returned items.
 */
export async function scanLocalSkills(args: ScanArgs): Promise<ScannedSkill[]> {
  const env = args.env ?? process.env;
  const detect = args.detect ?? detectHarnesses;
  let installed: HarnessId[] = [];
  try {
    installed = await detect(args.paths, env);
  } catch {
    installed = [];
  }
  const installedSet = new Set(installed);
  const items: ScannedSkill[] = [];
  const seen = new Set<string>();
  const push = (item: ScannedSkill) => {
    const key = `${item.harness}\0${item.root_kind}\0${item.relative_path}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  const user = userRoots(args.paths);
  const ordered = [
    ...user.filter((root) => installedSet.has(root.harness)),
    ...user.filter((root) => !installedSet.has(root.harness)),
  ];
  for (const root of ordered) {
    // An installed client contributes its roots. A listed root is still walked
    // when the directory exists and the client was not detected.
    if (!installedSet.has(root.harness) && !(await isDirectory(root.dir))) continue;
    await scanFlatRoot(root, push);
  }

  const homeIds = await pathIdentities(args.paths.home);
  const seenWorkspaces = new Set<string>();
  for (const workspace of args.workspaces ?? []) {
    if (!workspace) continue;
    if (sharesIdentity(await pathIdentities(workspace), homeIds)) continue;
    const canonical = await canonicalWorkspace(workspace);
    if (seenWorkspaces.has(canonical)) continue;
    seenWorkspaces.add(canonical);
    for (const root of projectRoots(workspace, canonical)) await scanFlatRoot(root, push);
  }
  for (const root of args.thirdPartyRoots ?? []) await scanThirdParty(root, push);
  return items;
}

/**
 * The replace body. This function does not read the home directory or the
 * environment. Items that fail the folder allowlist or the item schema are dropped.
 */
export function buildReplacePayload(args: {
  userKey: string;
  machineId: string;
  items: readonly ScannedSkill[];
}): { user_key: string; machine_id: string; items: LocalInventoryItem[] } {
  const items: LocalInventoryItem[] = [];
  for (const item of args.items) {
    if (localSkillNameError(item.name) || relativeSkillPathError(item.relative_path)) continue;
    const parsed = LocalInventoryItem.safeParse(item);
    if (!parsed.success) continue;
    items.push(parsed.data);
  }
  return { user_key: args.userKey, machine_id: args.machineId, items };
}
