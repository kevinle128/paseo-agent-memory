import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalInventoryRow } from "../shared/inventory";
import { createInventoryApi } from "../server/inventory-api";
import { createInventorySync } from "../server/inventory-sync";
import { resolvePaths } from "../server/harness-paths";
import { createStore, type CredentialFile } from "../server/store";
import { startFakePanel, type FakePanel } from "./fake-panel";

const SECRET_KEY = "fake-inventory-key-1";
const SECRET_KEY_B = "fake-inventory-key-2";
const MARKER = "sync-home-marker-9f3a";
const USER_BODY = "user-skill-body-9f3a";
const PROJECT_BODY = "project-skill-body-9f3a";
const PLUGIN_BODY = "plugin-skill-body-9f3a";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let tmp = "";
let panel: FakePanel;
let lifetime: AbortController;
let logs: string[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "inventory-sync-"));
  panel = await startFakePanel();
  lifetime = new AbortController();
  logs = [];
  for (const method of ["log", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  lifetime.abort();
  await panel.close();
  await rm(tmp, { recursive: true, force: true });
});

async function writeSkill(dir: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
}

function credential(installId: string, expiresAt: string, extra?: Partial<CredentialFile>): CredentialFile {
  return {
    version: 1,
    origin: panel.origin,
    instanceId: "inst-1",
    installId,
    keyId: "key-1234",
    key: SECRET_KEY,
    expiresAt,
    account: { userId: "u1", username: "an" },
    teams: [],
    deviceName: "laptop",
    savedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function row(installId: string, fields: Pick<LocalInventoryRow, "name" | "source" | "root_kind" | "relative_path" | "content_hash"> & { inventory_id: number }): LocalInventoryRow {
  return {
    inventory_id: fields.inventory_id,
    machine_id: installId,
    harness: "claude",
    source: fields.source,
    name: fields.name,
    root_kind: fields.root_kind,
    relative_path: fields.relative_path,
    content_hash: fields.content_hash,
    reported_at_ms: 1_700_000_000_000,
    present: 1,
  };
}

async function fixture() {
  const home = join(tmp, "Users", MARKER);
  const workspace = join(tmp, "proj-workspace");
  const third = join(tmp, "plugin-cache");
  await writeSkill(join(home, ".claude", "skills", "user-skill"), USER_BODY);
  await writeSkill(join(workspace, ".claude", "skills", "project-skill"), PROJECT_BODY);
  await writeSkill(join(third, "demo-plugin", "skills", "plugin-skill"), PLUGIN_BODY);
  const storeDir = join(tmp, "store");
  await mkdir(storeDir);
  const store = createStore(storeDir);
  const installId = await store.loadOrCreateInstallId();
  const paths = resolvePaths({ PATH: "" }, home);
  const settings = { origin: panel.origin, deviceName: "laptop", instanceId: "inst-1" };
  const sync = createInventorySync({
    store,
    readSettings: async () => ({ ...settings }),
    api: createInventoryApi({ signal: lifetime.signal }),
    paths,
    env: { PATH: "" },
    thirdPartyRoots: [{ dir: third, harness: "claude" }],
    now: () => Date.parse("2026-06-01T00:00:00.000Z"),
  });
  return { home, workspace, installId, store, sync, settings };
}

function queueExchange(items: LocalInventoryRow[]): void {
  panel.queue("inventory-replace", { body: { code: 0, message: "ok", data: { count: items.length } } });
  panel.queue("inventory-list", { body: { code: 0, message: "ok", data: { items } } });
}

function userRow(installId: string, name: string, inventoryId: number): LocalInventoryRow {
  return row(installId, {
    inventory_id: inventoryId,
    name,
    source: "user",
    root_kind: "claude_user",
    relative_path: `${name}/SKILL.md`,
    content_hash: sha(name),
  });
}

describe("inventory sync", () => {
  it("posts a replace body with three sources and then shows the list rows", async () => {
    const { home, workspace, installId, store, sync } = await fixture();
    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z"));
    const rows = [
      row(installId, {
        inventory_id: 1,
        name: "user-skill",
        source: "user",
        root_kind: "claude_user",
        relative_path: "user-skill/SKILL.md",
        content_hash: sha(USER_BODY),
      }),
      row(installId, {
        inventory_id: 2,
        name: "project-skill",
        source: "project",
        root_kind: "claude_project",
        relative_path: "project-skill/SKILL.md",
        content_hash: sha(PROJECT_BODY),
      }),
      row(installId, {
        inventory_id: 3,
        name: "plugin-skill",
        source: "third_party_plugin",
        root_kind: "claude_third_party",
        relative_path: "demo-plugin/skills/plugin-skill/SKILL.md",
        content_hash: sha(PLUGIN_BODY),
      }),
      row(installId, {
        inventory_id: 4,
        name: "hidden",
        source: "user",
        root_kind: "claude_user",
        relative_path: "/Users/hidden/SKILL.md",
        content_hash: sha("nope"),
      }),
    ];
    panel.queue("inventory-replace", { body: { code: 0, message: "ok", data: { machine_id: installId, count: 3 } } });
    panel.queue("inventory-list", { body: { code: 0, message: "ok", data: { items: rows } } });

    const view = await sync.list(["", home, workspace]);
    expect(view.state).toBe("connected");
    if (view.state !== "connected") return;
    expect(view.error).toBeUndefined();
    expect(view.items.map((item) => item.name)).toEqual(["user-skill", "project-skill", "plugin-skill"]);
    expect(view.items.map((item) => item.source)).toEqual(["user", "project", "third_party_plugin"]);

    const replace = panel.requests.find((request) => request.route === "inventory-replace");
    expect(replace?.headers["x-tdai-service-id"]).toBe("inst-1");
    expect(replace?.headers["x-tdai-user-key"]).toBe(SECRET_KEY);
    expect(replace?.body.user_key).toBe(SECRET_KEY);
    expect(replace?.body.machine_id).toBe(installId);
    const items = replace?.body.items as { source: string }[];
    expect(new Set(items.map((item) => item.source))).toEqual(new Set(["user", "project", "third_party_plugin"]));
    const posted = JSON.stringify(replace?.body);
    expect(posted).not.toContain(home);
    expect(posted).not.toContain(MARKER);
    expect(posted).not.toContain(USER_BODY);
    expect(posted).not.toContain(PROJECT_BODY);
    expect(posted).not.toContain(PLUGIN_BODY);
    expect(JSON.stringify(logs)).not.toContain(SECRET_KEY);

    const list = panel.requests.find((request) => request.route === "inventory-list");
    expect(list?.body).toEqual({ user_key: SECRET_KEY, machine_id: installId });
  });

  it("maps HTTP 401 to auth_failed and does not log the key", async () => {
    const { workspace, installId, store, sync } = await fixture();
    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z"));
    panel.queue("inventory-replace", { status: 401, body: { code: 401, message: "invalid_user_key" } });
    const view = await sync.list([workspace]);
    expect(view).toMatchObject({ state: "connected", error: "auth_failed", items: [] });
    expect(panel.count("inventory-list")).toBe(0);
    expect(JSON.stringify(logs)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(view)).not.toContain(SECRET_KEY);
  });

  it("does not post when the saved login is expired", async () => {
    const { workspace, installId, store, sync } = await fixture();
    await store.writeCredential(credential(installId, "2000-01-01T00:00:00.000Z"));
    const view = await sync.list([workspace]);
    expect(view).toEqual({ state: "signed_out" });
    expect(panel.requests).toEqual([]);
  });

  it("runs a second list only after the first scan finishes", async () => {
    const { workspace, installId, store, sync } = await fixture();
    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z"));
    const listed = [
      row(installId, {
        inventory_id: 1,
        name: "user-skill",
        source: "user",
        root_kind: "claude_user",
        relative_path: "user-skill/SKILL.md",
        content_hash: sha(USER_BODY),
      }),
    ];
    panel.queue("inventory-replace", { body: { code: 0, data: { count: 1 } } });
    panel.queue("inventory-list", { body: { code: 0, data: { items: listed } } });
    const [first, second] = await Promise.all([sync.list([workspace]), sync.list([workspace])]);
    expect(panel.count("inventory-replace")).toBe(1);
    expect(panel.count("inventory-list")).toBe(1);
    expect(first).toEqual(second);
  });

  it("scans the next login after logout instead of keeping the previous rows", async () => {
    const { workspace, installId, store, sync } = await fixture();
    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z"));
    queueExchange([userRow(installId, "user-a", 1)]);
    const first = await sync.list([workspace]);
    expect(first).toMatchObject({ state: "connected", items: [expect.objectContaining({ name: "user-a" })] });

    await store.deleteCredential();
    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z", {
      keyId: "key-bbbb",
      key: SECRET_KEY_B,
      account: { userId: "u2", username: "bee" },
    }));
    queueExchange([userRow(installId, "user-b", 2)]);
    const replacesBefore = panel.count("inventory-replace");
    await sync.backgroundScan();
    expect(panel.count("inventory-replace")).toBe(replacesBefore + 1);
    expect(panel.count("inventory-list")).toBe(replacesBefore + 1);
    const backgroundReplace = panel.requests.filter((request) => request.route === "inventory-replace").at(-1);
    expect(backgroundReplace?.headers["x-tdai-user-key"]).toBe(SECRET_KEY_B);
    expect(backgroundReplace?.body.user_key).toBe(SECRET_KEY_B);

    queueExchange([userRow(installId, "user-b", 2)]);
    const listsBefore = panel.count("inventory-list");
    const second = await sync.list([workspace]);
    expect(panel.count("inventory-list")).toBe(listsBefore + 1);
    expect(second).toMatchObject({ state: "connected", items: [expect.objectContaining({ name: "user-b" })] });
    expect(JSON.stringify(second)).not.toContain("user-a");
    const listedReplace = panel.requests.filter((request) => request.route === "inventory-replace").at(-1);
    const sources = (listedReplace?.body.items as { source: string }[]).map((item) => item.source);
    expect(sources).toContain("project");
    expect(JSON.stringify(logs)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(logs)).not.toContain(SECRET_KEY_B);
  });

  it("drops the cached rows when the credential is replaced without a signed-out call", async () => {
    const { workspace, installId, store, sync } = await fixture();
    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z"));
    queueExchange([userRow(installId, "user-a", 1)]);
    await sync.list([workspace]);

    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z", {
      keyId: "key-bbbb",
      key: SECRET_KEY_B,
    }));
    queueExchange([userRow(installId, "user-b", 2)]);
    const replacesBefore = panel.count("inventory-replace");
    await sync.backgroundScan();
    expect(panel.count("inventory-replace")).toBe(replacesBefore + 1);
    const backgroundReplace = panel.requests.filter((request) => request.route === "inventory-replace").at(-1);
    expect(backgroundReplace?.body.user_key).toBe(SECRET_KEY_B);

    queueExchange([userRow(installId, "user-b", 2)]);
    const second = await sync.list([workspace]);
    expect(second).toMatchObject({ state: "connected", items: [expect.objectContaining({ name: "user-b" })] });
    expect(JSON.stringify(second)).not.toContain("user-a");
    expect(JSON.stringify(logs)).not.toContain(SECRET_KEY_B);
  });

  it("drops the cache when the origin or instance id changes", async () => {
    const { workspace, installId, store, sync, settings } = await fixture();
    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z"));
    queueExchange([userRow(installId, "user-a", 1)]);
    await sync.list([workspace]);

    settings.instanceId = "inst-2";
    queueExchange([userRow(installId, "user-b", 2)]);
    const replacesBefore = panel.count("inventory-replace");
    await sync.backgroundScan();
    expect(panel.count("inventory-replace")).toBe(replacesBefore + 1);
    const backgroundReplace = panel.requests.filter((request) => request.route === "inventory-replace").at(-1);
    expect(backgroundReplace?.headers["x-tdai-service-id"]).toBe("inst-2");

    queueExchange([userRow(installId, "user-b", 2)]);
    const second = await sync.list([workspace]);
    expect(second).toMatchObject({ state: "connected", items: [expect.objectContaining({ name: "user-b" })] });
    expect(JSON.stringify(second)).not.toContain("user-a");

    settings.origin = "http://127.0.0.1:9";
    const replacesAtOrigin = panel.count("inventory-replace");
    await sync.backgroundScan();
    const signedOut = await sync.list([workspace]);
    expect(signedOut).toEqual({ state: "signed_out" });
    expect(panel.count("inventory-replace")).toBe(replacesAtOrigin);
    expect(JSON.stringify(signedOut)).not.toContain("user-b");
  });

  it("scans a larger workspace set and then reuses that set", async () => {
    const { workspace, installId, store, sync } = await fixture();
    const wsB = join(tmp, "proj-workspace-b");
    const bodyB = "ws-b-body-9f3a";
    await writeSkill(join(wsB, ".claude", "skills", "second-project"), bodyB);
    await store.writeCredential(credential(installId, "2099-01-01T00:00:00.000Z"));
    queueExchange([userRow(installId, "user-a", 1)]);
    await sync.list([workspace]);
    const firstReplace = panel.requests.filter((request) => request.route === "inventory-replace").at(-1);
    const firstNames = (firstReplace?.body.items as { name: string }[]).map((item) => item.name);
    expect(firstNames).not.toContain("second-project");

    queueExchange([userRow(installId, "user-b", 2)]);
    const replacesBefore = panel.count("inventory-replace");
    const grown = await sync.list([workspace, wsB]);
    expect(panel.count("inventory-replace")).toBe(replacesBefore + 1);
    const grownReplace = panel.requests.filter((request) => request.route === "inventory-replace").at(-1);
    const grownNames = (grownReplace?.body.items as { name: string }[]).map((item) => item.name);
    expect(grownNames).toContain("second-project");
    expect(grownNames).toContain("project-skill");
    expect(JSON.stringify(grownReplace?.body)).not.toContain(bodyB);
    expect(grown).toMatchObject({ state: "connected", items: [expect.objectContaining({ name: "user-b" })] });

    const listsBefore = panel.count("inventory-list");
    const repeated = await sync.list([workspace, wsB]);
    expect(panel.count("inventory-list")).toBe(listsBefore);
    expect(panel.count("inventory-replace")).toBe(replacesBefore + 1);
    expect(repeated).toEqual(grown);
  });
});
