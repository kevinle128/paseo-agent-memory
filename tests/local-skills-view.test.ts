import { describe, expect, it } from "vitest";
import type { LocalInventoryRow } from "../shared/inventory";
import { displayInventoryRows, isSafeInventoryRow, renderInventoryText } from "../client/local-skills-view";

const HASH = "a".repeat(64);

function row(overrides: Partial<LocalInventoryRow>): LocalInventoryRow {
  return {
    inventory_id: 1,
    machine_id: "machine-1",
    harness: "claude",
    source: "user",
    name: "alpha",
    root_kind: "claude_user",
    relative_path: "alpha/SKILL.md",
    content_hash: HASH,
    reported_at_ms: 1_700_000_000_000,
    present: 1,
    ...overrides,
  };
}

describe("local skills view", () => {
  it("renders fixture rows and drops absolute or home paths", () => {
    const good = [
      row({}),
      row({
        inventory_id: 2,
        harness: "codex",
        source: "project",
        name: "beta",
        root_kind: "codex_project",
        relative_path: "beta/SKILL.md",
        content_hash: "b".repeat(64),
      }),
      row({
        inventory_id: 3,
        harness: "agy",
        source: "third_party_plugin",
        name: "gamma",
        root_kind: "agy_third_party",
        relative_path: "demo/skills/gamma/SKILL.md",
        content_hash: "c".repeat(64),
      }),
    ];
    const badPaths = ["/Users/alice/skills/alpha/SKILL.md", "Users/alice/alpha/SKILL.md", "~/alpha/SKILL.md", "../alpha/SKILL.md"];
    const bad = badPaths.map((relative_path, index) =>
      row({ inventory_id: 10 + index, name: `bad-${index}`, relative_path }),
    );
    for (const item of bad) expect(isSafeInventoryRow(item)).toBe(false);
    for (const item of good) expect(isSafeInventoryRow(item)).toBe(true);

    const text = renderInventoryText([...good, ...bad], {
      harness: (id) => `harness.${id}`,
      source: (source) => `inventorySources.${source}`,
    });
    expect(text).toContain("alpha");
    expect(text).toContain("inventorySources.user");
    expect(text).toContain("harness.claude");
    expect(text).toContain("beta");
    expect(text).toContain("inventorySources.project");
    expect(text).toContain("gamma");
    expect(text).toContain("inventorySources.third_party_plugin");
    expect(text).toContain("a".repeat(12));
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("Users/alice");
    expect(text).not.toContain("~/");
    expect(text).not.toContain("..");
    expect(text).not.toContain("bad-0");
    expect(text).not.toContain("bad-1");
    expect(text).not.toContain("bad-2");
    expect(text).not.toContain("bad-3");
  });

  it("omits malformed rows and non-arrays without throwing", () => {
    const labels = {
      harness: (id: LocalInventoryRow["harness"]) => id,
      source: (source: LocalInventoryRow["source"]) => source,
    };
    const malformed = [
      null,
      undefined,
      { name: null },
      { root_kind: undefined },
      { relative_path: 42 },
      { content_hash: "short" },
      { ...row({}), reported_at_ms: Number.NaN },
      { ...row({}), reported_at_ms: 1e20 },
    ];
    for (const item of malformed) {
      expect(() => isSafeInventoryRow(item)).not.toThrow();
      expect(isSafeInventoryRow(item)).toBe(false);
    }
    for (const rows of [null, undefined, 42, "rows"]) {
      expect(() => displayInventoryRows(rows, labels)).not.toThrow();
      expect(displayInventoryRows(rows, labels)).toEqual([]);
    }
    expect(displayInventoryRows([row({}), ...malformed], labels).map((item) => item.name)).toEqual(["alpha"]);
  });

  it("renders a skill folder named users, home, or v1..v2 when the path head is a workspace token", () => {
    const labels = {
      harness: () => "h",
      source: (source: LocalInventoryRow["source"]) => source,
    };
    const accepted = [
      row({
        name: "users",
        source: "project",
        root_kind: "claude_project",
        relative_path: "ws-abcdef012345/users/SKILL.md",
      }),
      row({
        name: "home",
        source: "project",
        root_kind: "claude_project",
        relative_path: "ws-abcdef012345/home/SKILL.md",
      }),
      row({
        name: "v1..v2",
        source: "third_party_plugin",
        root_kind: "claude_third_party",
        relative_path: "plugin/skills/v1..v2/SKILL.md",
      }),
    ];
    for (const item of accepted) expect(isSafeInventoryRow(item)).toBe(true);
    const text = renderInventoryText(accepted, labels);
    expect(text).toContain("ws-abcdef012345/users/SKILL.md");
    expect(text).toContain("ws-abcdef012345/home/SKILL.md");
    expect(text).toContain("plugin/skills/v1..v2/SKILL.md");
    expect(isSafeInventoryRow(row({ relative_path: "users/alpha/SKILL.md" }))).toBe(false);
    expect(isSafeInventoryRow(row({ relative_path: "../alpha/SKILL.md" }))).toBe(false);
  });
});
