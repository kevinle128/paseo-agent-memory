import { createHash } from "node:crypto";
import {
  LocalInventoryRow,
  localSkillNameError,
  relativeSkillPathError,
  type InventoryErrorCode,
  type LocalInventoryView,
} from "../shared/inventory";
import { credentialMatchesOrigin } from "../shared/view";
import type { MachineSettings } from "./login-machine";
import { InventoryApiError, type InventoryApi } from "./inventory-api";
import { scanLocalSkills, type ScanArgs, type ScannedSkill } from "./skill-scanner";
import type { Store } from "./store";

type Session =
  | { state: "signed_out" }
  | {
      state: "connected";
      origin: string;
      instanceId: string;
      key: string;
      machineId: string;
      fingerprint: string;
    };

/** Hash of origin, instance, machine, key id, and the key digest. The raw key is not kept. */
function sessionFingerprint(input: {
  origin: string;
  instanceId: string;
  machineId: string;
  keyId: string;
  key: string;
}): string {
  const keyHash = createHash("sha256").update(input.key).digest("hex");
  return createHash("sha256")
    .update([input.origin, input.instanceId, input.machineId, input.keyId, keyHash].join("\0"))
    .digest("hex");
}

export interface InventorySyncDeps {
  store: Pick<Store, "loadOrCreateInstallId" | "readCredential">;
  readSettings(): Promise<MachineSettings>;
  api: InventoryApi;
  scan?: (args: ScanArgs) => Promise<ScannedSkill[]>;
  paths: ScanArgs["paths"];
  env?: NodeJS.ProcessEnv;
  thirdPartyRoots?: ScanArgs["thirdPartyRoots"];
  now?: () => number;
}

function connectedError(kind: InventoryErrorCode): LocalInventoryView {
  return { state: "connected", scanning: false, items: [], error: kind };
}

/** Sorted unique non-empty workspace strings. An empty list is an empty key, not "no scan". */
function workspacesKey(workspaces: readonly string[]): string {
  return [...new Set(workspaces.filter((workspace) => workspace.length > 0))].sort().join("\0");
}

function acceptRow(row: unknown): LocalInventoryRow | null {
  const parsed = LocalInventoryRow.safeParse(row);
  if (!parsed.success) return null;
  if (parsed.data.present !== 1) return null;
  if (localSkillNameError(parsed.data.name)) return null;
  if (relativeSkillPathError(parsed.data.relative_path)) return null;
  return parsed.data;
}

/**
 * One scan at a time. The screen reads the rows Core returned from list,
 * after a successful replace. There is no timer.
 */
export function createInventorySync(deps: InventorySyncDeps) {
  const scan = deps.scan ?? scanLocalSkills;
  const now = deps.now ?? Date.now;
  let tail: Promise<void> = Promise.resolve();
  let syncedWorkspacesKey: string | null = null;
  let cachedSessionFingerprint: string | null = null;
  let cached: LocalInventoryView | null = null;

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function session(): Promise<Session> {
    const settings = await deps.readSettings();
    const credential = await deps.store.readCredential();
    if (!credential || !settings.origin) return { state: "signed_out" };
    if (!credentialMatchesOrigin(settings.origin, credential.origin)) return { state: "signed_out" };
    const expiresAt = Date.parse(credential.expiresAt);
    if (!(expiresAt > now())) return { state: "signed_out" };
    const machineId = await deps.store.loadOrCreateInstallId();
    return {
      state: "connected",
      origin: settings.origin,
      instanceId: settings.instanceId,
      key: credential.key,
      machineId,
      fingerprint: sessionFingerprint({
        origin: settings.origin,
        instanceId: settings.instanceId,
        machineId,
        keyId: credential.keyId,
        key: credential.key,
      }),
    };
  }

  function adopt(current: Session): Exclude<Session, { state: "signed_out" }> | null {
    if (current.state === "signed_out") {
      syncedWorkspacesKey = null;
      cachedSessionFingerprint = null;
      cached = { state: "signed_out" };
      return null;
    }
    if (current.fingerprint !== cachedSessionFingerprint) {
      syncedWorkspacesKey = null;
      cached = null;
    }
    return current;
  }

  async function perform(current: Exclude<Session, { state: "signed_out" }>, workspaces: readonly string[], markWorkspaces: boolean): Promise<LocalInventoryView> {
    try {
      const items = await scan({
        paths: deps.paths,
        env: deps.env,
        workspaces,
        thirdPartyRoots: deps.thirdPartyRoots,
      });
      await deps.api.replace(current.origin, current.instanceId, current.key, current.machineId, items);
      const listed = await deps.api.list(current.origin, current.instanceId, current.key, current.machineId);
      const view: LocalInventoryView = {
        state: "connected",
        scanning: false,
        items: listed.flatMap((row) => {
          const accepted = acceptRow(row);
          return accepted ? [accepted] : [];
        }),
        syncedAt: new Date(now()).toISOString(),
      };
      cached = view;
      cachedSessionFingerprint = current.fingerprint;
      if (markWorkspaces) syncedWorkspacesKey = workspacesKey(workspaces);
      return view;
    } catch (error) {
      const kind = error instanceof InventoryApiError ? error.kind : "bad_response";
      if (!(error instanceof InventoryApiError)) {
        console.error(`inventory scan failed (${error instanceof Error ? error.name : "unknown"})`);
      }
      const view = connectedError(kind);
      cached = view;
      cachedSessionFingerprint = current.fingerprint;
      return view;
    }
  }

  return {
    /**
     * Plugin start and the moment a login is stored.
     * Those callers have no Paseo handle: PluginServerContext does not expose
     * paseo.workspaces, and the login callback is not a PluginHandlerContext.
     * This scan therefore sends workspaces: []. Project skills already reported
     * to Core stay absent until list() runs with the Account screen's directories.
     */
    backgroundScan(): Promise<void> {
      return enqueue(async () => {
        const current = adopt(await session());
        if (!current) return;
        if (syncedWorkspacesKey !== null) return;
        await perform(current, [], false);
      }).then(
        () => undefined,
        () => undefined,
      );
    },

    list(workspaces: readonly string[] | null): Promise<LocalInventoryView> {
      return enqueue(async () => {
        const current = adopt(await session());
        if (!current) return cached ?? { state: "signed_out" };
        if (workspaces === null) return connectedError("bad_response");
        if (
          syncedWorkspacesKey !== null &&
          syncedWorkspacesKey === workspacesKey(workspaces) &&
          cached?.state === "connected" &&
          !cached.error
        ) {
          return cached;
        }
        return perform(current, workspaces, true);
      });
    },

    rescan(workspaces: readonly string[] | null): Promise<LocalInventoryView> {
      return enqueue(async () => {
        const current = adopt(await session());
        if (!current) return cached ?? { state: "signed_out" };
        if (workspaces === null) return connectedError("bad_response");
        return perform(current, workspaces, true);
      });
    },
  };
}

export type InventorySync = ReturnType<typeof createInventorySync>;
