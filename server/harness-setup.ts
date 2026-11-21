import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HTTP_TIMEOUT_MS } from "../shared/constants";
import { mcpUrl } from "../shared/mcp-entry";
import {
  INSTALLER_CLIENT,
  type HarnessErrorCode,
  type HarnessId,
  type RemovalView,
  type SetupView,
} from "../shared/harness";
import {
  SetupFailure,
  applyAgyMcp,
  applyClaude,
  applyCodex,
  applyOmp,
  checkAgyUrl,
  keyDigest,
  removeAgyMcp,
  removeClaude,
  removeCodex,
  removeOmp,
  type OmpProvider,
  type Removal,
} from "./harness-files";
import {
  agyMcpFile,
  agyUrlFile,
  claudeSettingsFile,
  codexConfigFile,
  ompAgentDir,
  type Paths,
} from "./harness-paths";
import type { RunInstaller } from "./hooks-installer";
import { fetchProxyOrigin } from "./proxy-endpoint";
import type { CredentialFile, HarnessFile, Store } from "./store";

// The key and the instance id enter URLs, JSON, TOML and YAML. Anything outside this set is refused.
const KEY_PATTERN = /^[A-Za-z0-9._-]{8,512}$/;
const INSTANCE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const REMOVAL_DEADLINE_MS = 5 * 60_000;

export interface HarnessSetupDeps {
  store: Pick<Store, "readHarness" | "writeHarness" | "deleteHarness" | "readCredential">;
  paths: Paths;
  detect(paths: Paths): Promise<HarnessId[]>;
  runInstaller: RunInstaller;
  now(): number;
  /** One total time limit for a removal, all clients together. Defaults to REMOVAL_DEADLINE_MS. */
  removalDeadlineMs?: number;
  /** Ends in-flight requests and installer processes when the plugin stops. */
  signal: AbortSignal;
  fetch?: typeof fetch;
}

export interface HarnessView {
  /** A removal is running in the background. */
  removing?: boolean;
  setup?: SetupView;
  removal?: RemovalView;
}

const ModelList = z.object({
  data: z.array(z.object({ id: z.string(), source: z.string().optional(), format: z.string().optional() }).loose()),
});

const PROVIDER_FOR_FORMAT: Record<string, { name: string; api: OmpProvider["api"]; v1: boolean }> = {
  "anthropic-messages": { name: "memory-anthropic", api: "anthropic-messages", v1: false },
  "openai-responses": { name: "memory-responses", api: "openai-responses", v1: true },
};
const CHAT_PROVIDER = { name: "memory-chat", api: "openai-completions", v1: true } as const;

/**
 * The omp provider is built from the models the proxy lists for this key, one provider per wire format.
 * An empty list means omp has nothing to offer, so no provider is invented.
 */
export async function fetchOmpProviders(opts: {
  route: string;
  key: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<OmpProvider[]> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, HTTP_TIMEOUT_MS);
  if (opts.signal.aborted) abort();
  else opts.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await (opts.fetch ?? fetch)(`${opts.route}/v1/models`, {
      redirect: "error",
      headers: { authorization: `Bearer ${opts.key}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status !== 200) return [];
    const parsed = ModelList.safeParse(await response.json());
    if (!parsed.success) return [];
    const groups = new Map<string, OmpProvider>();
    for (const model of parsed.data.data) {
      if (!model.id || !model.source || !model.format) continue;
      const kind = PROVIDER_FOR_FORMAT[model.format] ?? CHAT_PROVIDER;
      const existing = groups.get(kind.name);
      if (existing) existing.models.push(model.id);
      else {
        groups.set(kind.name, {
          name: kind.name,
          api: kind.api,
          baseUrl: kind.v1 ? `${opts.route}/v1` : opts.route,
          models: [model.id],
        });
      }
    }
    return [...groups.values()];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", abort);
  }
}

async function ompModelsFiles(paths: Paths): Promise<string[]> {
  const found: string[] = [];
  for (const name of ["models.yml", "models.yaml"]) {
    const file = join(ompAgentDir(paths), name);
    if (await stat(file).then((s) => s.isFile(), () => false)) found.push(file);
  }
  return found;
}

function combine(results: Removal[]): Removal {
  if (results.includes("changed")) return "changed";
  return results.includes("removed") ? "removed" : "absent";
}

export function createHarnessSetup(deps: HarnessSetupDeps) {
  let record: HarnessFile | null = null;
  let running = false;
  let removal: RemovalView | undefined;
  // The key a removal resumed at start belongs to. The login machine ends that key's log out if its credential is still stored.
  let resumedKeyId: string | undefined;
  // Removals that are queued or running. The record carries `removalPending` while this is above zero.
  let removals = 0;
  // One job at a time: the clients share ~/.agent-memory, and a log out must wait for a setup in progress.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  // Record writes run one after another and read `record` and `removals` when they run, so a setup commit
  // that was started before the marker can never write the record without it.
  let saves: Promise<unknown> = Promise.resolve();
  function save(): Promise<void> {
    const write = async () => {
      if (!record) return;
      const { removalPending: _previous, ...rest } = record;
      await deps.store.writeHarness(removals > 0 ? { ...rest, removalPending: true } : rest);
    };
    const next = saves.then(write, write);
    saves = next.catch(() => undefined);
    return next;
  }

  function drop(): Promise<void> {
    const erase = async () => {
      record = null;
      await deps.store.deleteHarness();
    };
    const next = saves.then(erase, erase);
    saves = next.catch(() => undefined);
    return next;
  }

  // Setups that are queued or running. A log out aborts all of them: each stops at its next step.
  const setups = new Set<AbortController>();

  async function configureOne(
    id: HarnessId,
    ctx: { proxyOrigin: string; panelOrigin: string; instanceId: string; key: string; agyMcpCreated: boolean },
    signal: AbortSignal,
    commit: (entry: HarnessFile["harnesses"][number]) => Promise<void>,
  ): Promise<HarnessFile["harnesses"][number]> {
    const client = INSTALLER_CLIENT[id];
    const route = `${ctx.proxyOrigin}/${client}/${ctx.instanceId}`;
    try {
      if (id === "claude") {
        await applyClaude(claudeSettingsFile(deps.paths), route, ctx.key, deps.now());
      } else if (id === "codex") {
        await applyCodex(codexConfigFile(deps.paths), route, ctx.key, deps.now());
      } else if (id === "omp") {
        const providers = await fetchOmpProviders({
          route,
          key: ctx.key,
          signal,
          fetch: deps.fetch,
        });
        if (providers.length === 0) throw new SetupFailure("no_models");
        const file = (await ompModelsFiles(deps.paths))[0] ?? join(ompAgentDir(deps.paths), "models.yml");
        await applyOmp(file, providers, ctx.key, deps.now());
      }
    } catch (error) {
      const code: HarnessErrorCode = error instanceof SetupFailure ? error.code : "write_failed";
      console.error(`harness ${id} not configured (${code})`);
      return { id, state: "failed", error: code, route };
    }
    // Antigravity has no provider step; its MCP entry is the only file written before the installer.
    // It is recorded before it is written, so a crash or a log out never leaves it without a record.
    // A failed MCP step leaves the client usable, so it only downgrades the result to partial.
    let mcpError: HarnessErrorCode | undefined;
    let mcp: { mcpWritten: boolean; mcpCreated: boolean } | undefined;
    if (id === "agy") {
      const file = agyMcpFile(deps.paths);
      const existed = await stat(file).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
      // A setup for a new key finds the file an earlier setup created, which stays the plugin's to delete.
      mcp = { mcpWritten: true, mcpCreated: !existed || ctx.agyMcpCreated };
      await commit({ id, state: "partial", route, ...mcp });
      try {
        await applyAgyMcp(file, mcpUrl(ctx.panelOrigin), ctx.instanceId, ctx.key, deps.now());
      } catch (error) {
        mcpError = error instanceof SetupFailure ? error.code : "write_failed";
        // The write is atomic, so a failed step wrote nothing and the removal has nothing to look for.
        mcp = { mcpWritten: false, mcpCreated: false };
        console.error(`harness agy mcp not configured (${mcpError})`);
      }
    } else {
      // The provider is on disk now, so it is recorded before the installer runs.
      await commit({ id, state: "partial", route });
    }
    const hook = await deps.runInstaller({
      proxyOrigin: ctx.proxyOrigin,
      args: ["--client", client, "--base-url", route],
      paths: deps.paths,
      key: id === "agy" ? ctx.key : undefined,
      signal,
    });
    if (hook.ok) {
      return mcpError
        ? { id, state: "partial", error: mcpError, route, ...mcp }
        : { id, state: "configured", route, ...mcp };
    }
    console.error(`harness ${id} hook not installed (${hook.reason ?? "exit"} ${hook.exitCode ?? ""})`.trim());
    return { id, state: id === "agy" ? "failed" : "partial", error: "installer_failed", route, ...mcp };
  }

  async function doConfigure(credential: CredentialFile, abort: AbortController): Promise<void> {
    // A log out that came while this setup was queued ends it before it writes anything.
    if (abort.signal.aborted) return;
    // The setup also stops when the plugin stops.
    const stopWithPlugin = () => abort.abort();
    if (deps.signal.aborted) stopWithPlugin();
    else deps.signal.addEventListener("abort", stopWithPlugin, { once: true });
    const signal = abort.signal;
    running = true;
    removal = undefined;
    const previous = record ?? (await deps.store.readHarness().catch(() => null));
    const agyMcpCreated =
      previous?.harnesses.some((h) => h.id === "agy" && h.mcpWritten === true && h.mcpCreated === true) ?? false;
    const base: HarnessFile = {
      version: 1,
      keyId: credential.keyId,
      keyDigest: keyDigest(credential.key),
      proxyOrigin: "",
      instanceId: credential.instanceId,
      configuredAt: new Date(deps.now()).toISOString(),
      paths: deps.paths,
      harnesses: [],
    };
    record = base;
    try {
      const proxyOrigin = await fetchProxyOrigin({
        panelOrigin: credential.origin,
        instanceId: credential.instanceId,
        signal,
        fetch: deps.fetch,
      });
      if (!proxyOrigin) {
        record = { ...base, error: "no_proxy" };
        await save();
        return;
      }
      if (!KEY_PATTERN.test(credential.key) || !INSTANCE_PATTERN.test(credential.instanceId)) {
        record = { ...base, proxyOrigin, error: "bad_key" };
        await save();
        return;
      }
      const current: HarnessFile = { ...base, proxyOrigin };
      record = current;
      await save();
      const ctx = {
        proxyOrigin,
        panelOrigin: credential.origin,
        instanceId: credential.instanceId,
        key: credential.key,
        agyMcpCreated,
      };
      const commit = async (entry: HarnessFile["harnesses"][number]) => {
        current.harnesses = [...current.harnesses.filter((item) => item.id !== entry.id), entry];
        await save();
      };
      for (const id of await deps.detect(deps.paths)) {
        // A step that has started is finished and recorded, so the removal finds what it wrote.
        if (signal.aborted) break;
        await commit(await configureOne(id, ctx, signal, commit));
      }
      console.log(`harness setup done (${current.harnesses.map((h) => `${h.id}:${h.state}`).join(" ") || "none found"})`);
    } finally {
      deps.signal.removeEventListener("abort", stopWithPlugin);
      running = false;
    }
  }

  async function removeOne(
    entry: HarnessFile["harnesses"][number],
    rec: HarnessFile,
    signal: AbortSignal,
  ): Promise<"removed" | "kept" | "failed"> {
    const { paths } = rec;
    const client = INSTALLER_CLIENT[entry.id];
    try {
      let outcome: Removal = "absent";
      let mcpFailed = false;
      if (entry.id === "claude") {
        outcome = await removeClaude(claudeSettingsFile(paths), entry.route, rec.keyDigest, deps.now());
      } else if (entry.id === "codex") {
        outcome = await removeCodex(codexConfigFile(paths), entry.route, rec.keyDigest, deps.now());
      } else if (entry.id === "omp") {
        const results: Removal[] = [];
        for (const file of await ompModelsFiles(paths)) results.push(await removeOmp(file, entry.route, rec.keyDigest, deps.now()));
        outcome = combine(results);
      } else {
        // The MCP removal stands alone: when it fails, the URL file and the hook are still removed.
        if (entry.mcpWritten) {
          try {
            outcome = await removeAgyMcp(agyMcpFile(paths), rec.keyDigest, entry.mcpCreated === true, deps.now());
          } catch {
            console.error("harness agy mcp entry not removed");
            mcpFailed = true;
          }
        }
        if ((await checkAgyUrl(agyUrlFile(paths), entry.route, rec.keyDigest)) === "changed") {
          // The installer's uninstall would delete a URL file the user edited, so it is not run.
          return mcpFailed ? "failed" : "kept";
        }
      }
      const hook = await deps.runInstaller({
        proxyOrigin: rec.proxyOrigin,
        args: ["--uninstall", "--client", client],
        paths,
        signal,
      });
      if (!hook.ok) {
        console.error(`harness ${entry.id} hook not removed (${hook.reason ?? "exit"} ${hook.exitCode ?? ""})`.trim());
        return "failed";
      }
      if (mcpFailed) return "failed";
      return outcome === "changed" ? "kept" : "removed";
    } catch {
      console.error(`harness ${entry.id} configuration not removed`);
      return "failed";
    }
  }

  async function doRemove(): Promise<void> {
    const rec = record ?? (await deps.store.readHarness());
    if (!rec) return;
    const report: RemovalView = [];
    // One deadline for the whole removal, so a stuck installer never keeps it running for long.
    const limit = new AbortController();
    const stop = () => limit.abort();
    const timer = setTimeout(stop, deps.removalDeadlineMs ?? REMOVAL_DEADLINE_MS);
    if (deps.signal.aborted) stop();
    else deps.signal.addEventListener("abort", stop, { once: true });
    try {
      await removeEntries(rec, limit.signal, report);
    } finally {
      clearTimeout(timer);
      deps.signal.removeEventListener("abort", stop);
    }
    // The plugin is stopping: the record and its marker stay, so the next start resumes the removal.
    if (deps.signal.aborted) return;
    // Queued with the saves, so a marker write that is still in flight cannot bring the record back.
    await drop();
    removal = report.length > 0 ? report : undefined;
    console.log(`harness removal done (${rec.harnesses.length} configured, ${report.length} not fully removed)`);
  }

  /**
   * Queues one removal behind the jobs already queued and counts it out when it has ended. The count drops
   * only then. A removal that is not wanted (`skip`) ends at once.
   */
  function runRemoval(skip: () => Promise<boolean> = async () => false): Promise<void> {
    return serial(async () => {
      if (await skip()) return;
      await doRemove();
    })
      .catch(() => {
        console.error("harness removal failed");
      })
      .finally(() => {
        removals -= 1;
      });
  }

  async function removeEntries(
    rec: HarnessFile,
    signal: AbortSignal,
    report: RemovalView,
  ): Promise<void> {
    for (const entry of rec.harnesses) {
      // A client the plugin could not write to has nothing to remove, except antigravity, whose installer may
      // have stopped half way.
      if (entry.state === "failed" && entry.id !== "agy") continue;
      const result = signal.aborted ? "failed" : await removeOne(entry, rec, signal);
      if (result !== "removed") report.push({ id: entry.id, result });
    }
  }

  return {
    /** Loads the record. A removal that an earlier run did not finish is resumed in the background. */
    async init(): Promise<void> {
      record = await deps.store.readHarness();
      if (!record) return;
      // A marker means a log out began. A record without a credential means the log out went through but the
      // cleanup did not finish. Both resume the removal.
      const pending = record.removalPending || (await deps.store.readCredential()) === null;
      if (!pending) return;
      resumedKeyId = record.keyId;
      removals += 1;
      void runRemoval();
    },

    /** The key id of the removal resumed by `init`, if any. */
    resumedRemovalKeyId(): string | undefined {
      return resumedKeyId;
    },

    /** Starts the one-time setup for a newly issued key. It never throws and does not block the login. */
    configure(credential: CredentialFile): void {
      const abort = new AbortController();
      setups.add(abort);
      void serial(() => doConfigure(credential, abort))
        .catch(() => {
          console.error("harness setup failed");
        })
        .finally(() => {
          setups.delete(abort);
        });
    },

    /**
     * Queues the removal of what the plugin added. The returned promise resolves once the "removal pending"
     * marker is on disk, so the caller can drop the credential at once; `done` resolves when the removal has
     * ended. It never rejects. `marked` is false when the marker could not be saved: with `requireMarker` the
     * removal is then not started, so the caller keeps the credential and the user can retry the log out.
     * A removal queues behind a setup or a removal that is already running.
     */
    async beginRemoval(options: { requireMarker?: boolean } = {}): Promise<{ done: Promise<void>; marked: boolean }> {
      removals += 1;
      // Setups that are queued or running stop at their next step, so the log out never waits for them. The
      // removal below is queued behind them and also removes what a stopped setup already wrote.
      for (const abort of setups) abort.abort();
      // The marker is saved at once, outside the queue. Every record write reads `removals`, so a setup commit
      // keeps the marker, and a setup cannot bring back a record the removal deleted, because the removal runs
      // after the setup has ended.
      const marker = save().then(
        () => true,
        () => {
          console.error("harness removal marker not saved");
          return false;
        },
      );
      const done = runRemoval(async () => !(await marker) && !!options.requireMarker);
      return { done, marked: await marker };
    },

    view(): HarnessView {
      const view: HarnessView = {};
      if (record) {
        view.setup = {
          configuredAt: record.configuredAt,
          ...(running ? { running: true } : {}),
          ...(record.error ? { error: record.error } : {}),
          harnesses: record.harnesses.map(({ id, state, error }) => ({
            id,
            state,
            ...(error ? { error } : {}),
          })),
        };
      }
      if (removal) view.removal = removal;
      if (removals > 0) view.removing = true;
      return view;
    },
  };
}

export type HarnessSetup = ReturnType<typeof createHarnessSetup>;
