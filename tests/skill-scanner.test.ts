import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSafeInventoryRow } from "../client/local-skills-view";
import { relativeSkillPathError } from "../shared/inventory";
import { resolvePaths } from "../server/harness-paths";
import { buildReplacePayload, scanLocalSkills, type ScannedSkill } from "../server/skill-scanner";

const BODY = "SECRET_SKILL_BODY_9f3a";
const NESTED = "NESTED_SECRET_BODY_9f3a";
const OUTSIDE = "OUTSIDE_BODY_9f3a";
const EXTERNAL = "EXTERNAL_FILE_BODY_9f3a";
const MARKER = "alice-marker-9f3a";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function writeSkill(dir: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
  await writeFile(join(dir, "agent-memory-skill.json"), "{\"sidecar\":true}");
  await mkdir(join(dir, "notes"), { recursive: true });
  await writeFile(join(dir, "notes", "secret.txt"), NESTED);
}

let tmp = "";

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
});

describe("scanLocalSkills", () => {
  it("reports one skill per source and keeps the home path and file body out of the payload", async () => {
    tmp = await mkdtemp(join(tmpdir(), "skill-scan-"));
    const home = join(tmp, "Users", MARKER);
    const workspace = join(tmp, "proj-workspace");
    const third = join(tmp, "plugin-cache");
    const outside = join(tmp, "outside-secret");
    await writeSkill(join(home, ".claude", "skills", "user-skill"), BODY);
    await writeSkill(join(home, ".agents", "skills", "agents-skill"), `${BODY}-agents`);
    await writeSkill(join(home, ".codex", "skills", "codex-skill"), `${BODY}-codex`);
    await writeSkill(join(home, ".omp", "agent", "skills", "omp-skill"), `${BODY}-omp`);
    await writeSkill(join(home, ".gemini", "config", "skills", "agy-config-skill"), `${BODY}-config`);
    await writeSkill(join(home, ".gemini", "antigravity-cli", "skills", "agy-cli-skill"), `${BODY}-cli`);
    await writeSkill(join(home, ".gemini", "skills", "agy-gemini-skill"), `${BODY}-gemini`);
    await mkdir(join(home, ".claude", "skills", "no-skill"), { recursive: true });
    await writeFile(join(home, ".claude", "skills", "no-skill", "README.md"), "not a skill");
    await writeSkill(outside, OUTSIDE);
    await symlink(outside, join(home, ".claude", "skills", "escaped"));
    const dotdot = join(home, ".claude", "skills", "dotdot");
    await symlink(join("..", "..", "..", "..", "outside-secret"), dotdot);
    expect(await realpath(dotdot)).toBe(await realpath(outside));
    const linked = join(home, ".claude", "skills", "linked-file");
    await mkdir(linked, { recursive: true });
    await writeFile(join(tmp, "external.md"), EXTERNAL);
    await symlink(join(tmp, "external.md"), join(linked, "SKILL.md"));
    await writeSkill(join(workspace, ".claude", "skills", "project-skill"), `${BODY}-project`);
    await writeSkill(join(workspace, ".agents", "skills", "project-agents-skill"), `${BODY}-project-agents`);
    await writeSkill(join(third, "demo-plugin", "skills", "plugin-skill"), `${BODY}-plugin`);

    const paths = resolvePaths({ PATH: "" }, home);
    const items = await scanLocalSkills({
      paths,
      env: { PATH: "" },
      workspaces: ["", home, workspace],
      thirdPartyRoots: [{ dir: third, harness: "claude" }],
    });
    const byName = new Map(items.map((item) => [item.name, item]));
    expect(byName.has("no-skill")).toBe(false);
    expect(byName.has("escaped")).toBe(false);
    expect(byName.has("dotdot")).toBe(false);
    expect(byName.has("linked-file")).toBe(false);
    expect(byName.get("user-skill")).toMatchObject({
      harness: "claude",
      source: "user",
      root_kind: "claude_user",
      relative_path: "user-skill/SKILL.md",
      content_hash: sha(BODY),
    });
    expect(byName.get("project-skill")?.source).toBe("project");
    expect(byName.get("plugin-skill")).toMatchObject({
      source: "third_party_plugin",
      root_kind: "claude_third_party",
      relative_path: "demo-plugin/skills/plugin-skill/SKILL.md",
      content_hash: sha(`${BODY}-plugin`),
    });
    expect(new Set(items.map((item) => item.source))).toEqual(new Set(["user", "project", "third_party_plugin"]));
    expect(byName.get("agents-skill")?.root_kind).toBe("codex_agents_user");
    expect(byName.get("codex-skill")?.root_kind).toBe("codex_user");
    expect(byName.get("omp-skill")?.root_kind).toBe("omp_user");
    expect(byName.get("agy-config-skill")?.root_kind).toBe("agy_config_user");
    expect(byName.get("agy-cli-skill")?.root_kind).toBe("agy_cli_user");
    expect(byName.get("agy-gemini-skill")?.root_kind).toBe("agy_gemini_user");
    expect(byName.get("project-agents-skill")?.root_kind).toBe("codex_project");
    expect(items.some((item) => item.source === "project" && item.name === "user-skill")).toBe(false);

    await writeFile(join(home, ".claude", "skills", "user-skill", "agent-memory-skill.json"), "{\"sidecar\":false}");
    const afterSidecar = await scanLocalSkills({ paths, env: { PATH: "" } });
    expect(afterSidecar.find((item) => item.name === "user-skill")?.content_hash).toBe(sha(BODY));
    await writeFile(join(home, ".claude", "skills", "user-skill", "SKILL.md"), `${BODY}-changed`);
    const changed = await scanLocalSkills({ paths, env: { PATH: "" } });
    expect(changed.find((item) => item.name === "user-skill")?.content_hash).toBe(sha(`${BODY}-changed`));
    expect(changed.find((item) => item.name === "user-skill")?.content_hash).not.toBe(sha(BODY));

    const payload = buildReplacePayload({ userKey: "user-key", machineId: "machine-1", items });
    const json = JSON.stringify(payload);
    expect(json).not.toContain(home);
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain(BODY);
    expect(json).not.toContain(NESTED);
    expect(json).not.toContain(OUTSIDE);
    expect(json).not.toContain(EXTERNAL);
    const unsafe: ScannedSkill = {
      harness: "claude",
      source: "user",
      name: "..",
      root_kind: "claude_user",
      relative_path: "../SKILL.md",
      content_hash: "ab".repeat(32),
    };
    const cleaned = buildReplacePayload({ userKey: "user-key", machineId: "machine-1", items: [unsafe] });
    expect(cleaned.items).toEqual([]);
  });

  it("emits both project skills when two workspaces share a skill folder name", async () => {
    tmp = await mkdtemp(join(tmpdir(), "skill-scan-"));
    const home = join(tmp, "Users", MARKER);
    const repoA = join(tmp, "a", "repo");
    const repoB = join(tmp, "b", "repo");
    const usersWorkspace = join(tmp, "users");
    const namedWorkspace = join(tmp, "projects", MARKER);
    const homeLink = join(tmp, "home-link");
    const bodyA = "shared-body-a-9f3a";
    const bodyB = "shared-body-b-9f3a";
    const bodyUsers = "shared-body-users-9f3a";
    const bodyNamed = "shared-body-named-9f3a";
    const bodyHome = "home-only-body-9f3a";
    await writeSkill(join(home, ".claude", "skills", "home-only-skill"), bodyHome);
    await writeSkill(join(home, ".claude", "skills", "user-skill"), BODY);
    await writeSkill(join(repoA, ".claude", "skills", "shared-skill"), bodyA);
    await writeSkill(join(repoB, ".claude", "skills", "shared-skill"), bodyB);
    await writeSkill(join(usersWorkspace, ".claude", "skills", "shared-skill"), bodyUsers);
    await writeSkill(join(namedWorkspace, ".claude", "skills", "named-skill"), bodyNamed);
    await symlink(home, homeLink);

    const prefixOf = async (workspace: string) => {
      const canonical = await realpath(resolve(workspace));
      return `ws-${sha(canonical).slice(0, 12)}`;
    };
    const prefixA = await prefixOf(repoA);
    const prefixB = await prefixOf(repoB);
    const prefixUsers = await prefixOf(usersWorkspace);
    const prefixNamed = await prefixOf(namedWorkspace);
    expect(new Set([prefixA, prefixB, prefixUsers, prefixNamed]).size).toBe(4);

    const paths = resolvePaths({ PATH: "" }, home);
    const items = await scanLocalSkills({
      paths,
      env: { PATH: "" },
      workspaces: [repoA, `${repoA}/`, repoB, usersWorkspace, namedWorkspace, home, `${home}/`, homeLink],
    });
    const shared = items.filter((item) => item.source === "project" && item.name === "shared-skill");
    expect(shared.map((item) => item.relative_path).sort()).toEqual(
      [`${prefixA}/shared-skill/SKILL.md`, `${prefixB}/shared-skill/SKILL.md`, `${prefixUsers}/shared-skill/SKILL.md`].sort(),
    );
    expect(new Set(shared.map((item) => item.content_hash))).toEqual(new Set([sha(bodyA), sha(bodyB), sha(bodyUsers)]));
    expect(items.find((item) => item.name === "named-skill")).toMatchObject({
      source: "project",
      root_kind: "claude_project",
      relative_path: `${prefixNamed}/named-skill/SKILL.md`,
      content_hash: sha(bodyNamed),
    });
    expect(items.find((item) => item.name === "user-skill")).toMatchObject({
      source: "user",
      relative_path: "user-skill/SKILL.md",
    });
    expect(items.some((item) => item.source === "project" && item.name === "home-only-skill")).toBe(false);

    for (const item of items.filter((entry) => entry.source === "project")) {
      expect(relativeSkillPathError(item.relative_path)).toBeNull();
      expect(item.relative_path.split("/")[0]).toMatch(/^ws-[0-9a-f]{12}$/);
      expect(isSafeInventoryRow({
        inventory_id: 1,
        machine_id: "machine-1",
        harness: item.harness,
        source: item.source,
        name: item.name,
        root_kind: item.root_kind,
        relative_path: item.relative_path,
        content_hash: item.content_hash,
        reported_at_ms: 1,
        present: 1,
      })).toBe(true);
    }

    const payload = buildReplacePayload({ userKey: "user-key", machineId: "machine-1", items });
    expect(payload.items.filter((item) => item.name === "shared-skill")).toHaveLength(3);
    const json = JSON.stringify(payload);
    expect(json).not.toContain(home);
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain(repoA);
    expect(json).not.toContain(repoB);
    expect(json).not.toContain(usersWorkspace);
    expect(json).not.toContain(namedWorkspace);
    expect(json).not.toContain(bodyA);
    expect(json).not.toContain(bodyB);
    expect(json).not.toContain(bodyUsers);
    expect(json).not.toContain(bodyNamed);
    expect(json).not.toContain(bodyHome);
  });
});
