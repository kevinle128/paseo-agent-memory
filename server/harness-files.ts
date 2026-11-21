import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, readlink, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { MCP_PATH, MCP_SERVER_NAME } from "../shared/constants";
import { MCP_KEY_HEADER, mcpHeaders } from "../shared/mcp-entry";
import type { HarnessErrorCode } from "../shared/harness";

/** A failure with a fixed code. The message never carries file content, because a file holds the key. */
export class SetupFailure extends Error {
  constructor(readonly code: HarnessErrorCode) {
    super(`harness setup failed (${code})`);
    this.name = "SetupFailure";
  }
}

/** removed: the plugin's entries are gone. absent: there were none. changed: the user changed an entry, so it stays. */
export type Removal = "removed" | "absent" | "changed";

export const PROVIDER_NAME = "team-proxy";

/**
 * A SHA-256 digest of the key. The record keeps it, so a removal can recognise the entries the plugin wrote
 * without the key itself being kept after the log out.
 */
export const keyDigest = (key: string): string => createHash("sha256").update(key).digest("hex");

const isKey = (value: unknown, digest: string): boolean => typeof value === "string" && keyDigest(value) === digest;

// ---------------------------------------------------------------------------------------------------
// File access

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The installer's backup name, `<file>.agent-memory-backup-<time>`; an older backup is never overwritten. */
export async function backupFile(file: string, now: number): Promise<string> {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (let n = 0; n < 100; n++) {
    const dest = `${file}.agent-memory-backup-${stamp}${n ? `-${n}` : ""}`;
    try {
      await copyFile(file, dest, constants.COPYFILE_EXCL);
      return dest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("no free backup name");
}

/**
 * The file a path really names: a chain of symbolic links is followed to its last name, also when that name
 * does not exist. A write or a delete on this path never turns the link into a regular file.
 */
async function resolveTarget(file: string): Promise<string> {
  let current = file;
  for (let hops = 0; hops < 40; hops++) {
    let link: string;
    try {
      link = await readlink(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EINVAL" || code === "ENOENT" || code === "ENOTDIR") return current;
      throw error;
    }
    current = resolve(dirname(current), link);
  }
  throw new Error("too many symbolic links");
}

/**
 * Writes through a temporary file in the same directory, so a crash never leaves a half-written file.
 * A symlink is resolved first, because a rename over the link would replace the link itself. The file keeps
 * its mode; a new file gets 0600 because it holds a key.
 */
async function writeAtomic(file: string, content: string, ownerOnly = false): Promise<void> {
  const target = await resolveTarget(file);
  let mode = 0o600;
  try {
    mode = (await stat(target)).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (ownerOnly) mode = 0o600;
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(target)}.agent-memory-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", mode);
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  // Best effort: makes the rename durable. Some platforms cannot open a directory.
  try {
    const dirHandle = await open(dir, "r");
    await dirHandle.sync().catch(() => undefined);
    await dirHandle.close();
  } catch {
    // Not needed for correctness.
  }
}

/**
 * Backs the file up, then replaces it (`after: null` deletes it). Every change to a user file goes here.
 * A removal deletes its backup once the write is done, because the backup still holds the key. A file that
 * was changed or created by the plugin's setup keeps its backup: it holds the user's own earlier content.
 */
async function writeChanged(
  file: string,
  before: string | null,
  after: string | null,
  now: number,
  removal = false,
  ownerOnly = false,
) {
  if (before === after) return;
  const backup = before !== null ? await backupFile(file, now) : null;
  try {
    if (after === null) await rm(await resolveTarget(file), { force: true });
    else await writeAtomic(file, after, ownerOnly);
  } catch (error) {
    // The backup holds the key, and a failed removal gives it no use.
    if (removal && backup) await rm(backup, { force: true }).catch(() => undefined);
    throw error;
  }
  if (removal && backup) await rm(backup, { force: true });
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SetupFailure) throw error;
    throw new SetupFailure("write_failed");
  }
}

// ---------------------------------------------------------------------------------------------------
// Claude Code: env in the user settings file

function parseSettings(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SetupFailure("settings_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupFailure("settings_invalid");
  }
  return value as Record<string, unknown>;
}

/**
 * Whether `url` points at the Agent-Memory proxy: the plugin's own origin, or another address of the
 * same proxy host (for example its plain-HTTP port) that uses the same client route segment.
 */
function onProxyOrigin(url: unknown, route: string): boolean {
  if (typeof url !== "string") return false;
  try {
    const found = new URL(url);
    const ours = new URL(route);
    if (found.origin === ours.origin) return true;
    const segment = ours.pathname.split("/")[1];
    return found.hostname === ours.hostname && segment !== "" && found.pathname.split("/")[1] === segment;
  } catch {
    return false;
  }
}

const CLAUDE_URL = "ANTHROPIC_BASE_URL";
const CLAUDE_TOKEN = "ANTHROPIC_AUTH_TOKEN";

export function claudeApply(text: string | null, route: string, key: string): string {
  const settings = text === null || text.trim() === "" ? {} : parseSettings(text);
  const env = settings.env ?? {};
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new SetupFailure("settings_invalid");
  // A base URL on another host is the user's own provider; one on the proxy is old Agent-Memory setup and is replaced.
  const existing = (env as Record<string, unknown>)[CLAUDE_URL];
  if (existing !== undefined && existing !== "" && !onProxyOrigin(existing, route)) {
    throw new SetupFailure("own_provider");
  }
  settings.env = { ...(env as Record<string, unknown>), [CLAUDE_URL]: route, [CLAUDE_TOKEN]: key };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function claudeRemove(
  text: string,
  route: string,
  digest: string,
): { text: string; result: Removal } {
  const settings = parseSettings(text);
  const env = settings.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return { text, result: "absent" };
  const entries = env as Record<string, unknown>;
  let removed = false;
  let changed = false;
  for (const [name, ours] of [
    [CLAUDE_URL, (value: unknown) => value === route],
    [CLAUDE_TOKEN, (value: unknown) => isKey(value, digest)],
  ] as const) {
    if (!(name in entries)) continue;
    if (ours(entries[name])) {
      delete entries[name];
      removed = true;
    } else {
      changed = true;
    }
  }
  if (!removed) return { text, result: changed ? "changed" : "absent" };
  if (Object.keys(entries).length === 0) delete settings.env;
  return { text: `${JSON.stringify(settings, null, 2)}\n`, result: changed ? "changed" : "removed" };
}

export async function applyClaude(file: string, route: string, key: string, now: number) {
  await guarded(async () => {
    const before = await readIfExists(file);
    await writeChanged(file, before, claudeApply(before, route, key), now);
  });
}

export async function removeClaude(
  file: string,
  route: string,
  digest: string,
  now: number,
): Promise<Removal> {
  return guarded(async () => {
    const before = await readIfExists(file);
    if (before === null) return "absent";
    const { text, result } = claudeRemove(before, route, digest);
    await writeChanged(file, before, text, now, true);
    return result;
  });
}

// ---------------------------------------------------------------------------------------------------
// Codex: model_provider and [model_providers.team-proxy] in config.toml

const EOL = /\r?\n/;
const isTableLine = (line: string) => /^\s*\[/.test(line);
const isModelProvider = (line: string) => /^\s*model_provider\s*=/.test(line);

function tableName(line: string): string | null {
  const match = /^\s*\[(?!\[)\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
  return match ? match[1].replace(/\s*\.\s*/g, ".").replace(/["']/g, "") : null;
}

const OURS = `model_providers.${PROVIDER_NAME}`;
const isOursName = (name: string | null) => name === OURS || !!name?.startsWith(`${OURS}.`);

interface Split {
  lines: string[];
  eol: string;
  finalNewline: boolean;
}

function split(text: string): Split {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(EOL);
  const finalNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

const joinLines = (lines: string[], eol: string, finalNewline: boolean) =>
  lines.length === 0 ? "" : lines.join(eol) + (finalNewline ? eol : "");

/** Ranges [start, end) of our provider table and its sub-tables. */
function ourTables(lines: string[]): Array<{ start: number; end: number; main: boolean }> {
  const found: Array<{ start: number; end: number; main: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isTableLine(lines[i])) continue;
    const name = tableName(lines[i]);
    if (!isOursName(name)) continue;
    let end = i + 1;
    while (end < lines.length && !isTableLine(lines[end])) end++;
    found.push({ start: i, end, main: name === OURS });
  }
  return found;
}

function providerBlock(route: string, key: string): string[] {
  return [
    `[${OURS}]`,
    'name = "TDAI team-proxy"',
    'wire_api = "responses"',
    `base_url = ${JSON.stringify(route)}`,
    `experimental_bearer_token = ${JSON.stringify(key)}`,
    "request_max_retries = 2",
    "stream_max_retries = 3",
    "stream_idle_timeout_ms = 120000",
  ];
}

export function codexApply(text: string | null, route: string, key: string): string {
  const parts = split(text ?? "");
  const firstTable = parts.lines.findIndex(isTableLine);
  const topEnd = firstTable === -1 ? parts.lines.length : firstTable;
  // With a top-level `profile`, Codex reads model_provider from the profile, so a top-level line would do nothing.
  if (parts.lines.slice(0, topEnd).some((line) => /^\s*profile\s*=/.test(line))) {
    throw new SetupFailure("codex_profile");
  }
  const topLines = parts.lines.slice(0, topEnd);
  // An inline or dotted `model_providers` cannot be edited line by line, so it is refused.
  if (
    topLines.some((line) => /^\s*model_providers\s*[.=]/.test(line)) ||
    parts.lines.some((line) => isTableLine(line) && tableName(line) === "model_providers")
  ) {
    throw new SetupFailure("toml_unsupported");
  }
  const selected = topLines.find(isModelProvider);
  if (selected && /=\s*["']([^"']*)["']/.exec(selected)?.[1] !== PROVIDER_NAME) {
    throw new SetupFailure("own_provider");
  }
  const top = topLines.filter((line) => !isModelProvider(line));
  let rest = parts.lines.slice(topEnd);
  const tables = ourTables(rest);
  for (const table of tables.filter((item) => item.main)) {
    if (!onProxyOrigin(tableValue(rest.slice(table.start, table.end), "base_url"), route)) {
      throw new SetupFailure("own_provider");
    }
  }
  const dropped = new Set<number>();
  for (const table of tables) for (let i = table.start; i < table.end; i++) dropped.add(i);
  rest = rest.filter((_, index) => !dropped.has(index));
  if (tables.length > 0) while (rest.length > 0 && rest[rest.length - 1].trim() === "") rest.pop();
  const body = [`model_provider = ${JSON.stringify(PROVIDER_NAME)}`, ...top, ...rest];
  const gap = body[body.length - 1].trim() !== "" ? [""] : [];
  return joinLines([...body, ...gap, ...providerBlock(route, key)], parts.eol, true);
}

function tableValue(lines: string[], name: string): string | undefined {
  for (const line of lines) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*(?:#.*)?$`).exec(line);
    if (!match) continue;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function codexRemove(
  text: string,
  route: string,
  digest: string,
): { text: string; result: Removal } {
  const parts = split(text);
  const { lines } = parts;
  const tables = ourTables(lines);
  let changed = false;
  let removed = false;
  const dropped = new Set<number>();
  for (const table of tables) {
    const body = lines.slice(table.start, table.end);
    const holdsOurs =
      table.main &&
      tables.length === 1 &&
      tableValue(body, "base_url") === route &&
      isKey(tableValue(body, "experimental_bearer_token"), digest);
    if (!holdsOurs) {
      changed = true;
      continue;
    }
    removed = true;
    for (let i = table.start; i < table.end; i++) dropped.add(i);
    // The plugin added the block after one blank line.
    if (table.start > 0 && lines[table.start - 1].trim() === "") dropped.add(table.start - 1);
  }
  // An edited provider keeps the line that selects it.
  if (!changed) {
    const firstTable = lines.findIndex(isTableLine);
    const topEnd = firstTable === -1 ? lines.length : firstTable;
    for (let i = 0; i < topEnd; i++) {
      if (!isModelProvider(lines[i])) continue;
      if (/=\s*["']([^"']*)["']/.exec(lines[i])?.[1] === PROVIDER_NAME) {
        dropped.add(i);
        removed = true;
      }
    }
  }
  if (!removed) return { text, result: changed ? "changed" : "absent" };
  const kept = lines.filter((_, index) => !dropped.has(index));
  return {
    text: joinLines(kept, parts.eol, parts.finalNewline),
    result: changed ? "changed" : "removed",
  };
}

export async function applyCodex(file: string, route: string, key: string, now: number) {
  await guarded(async () => {
    const before = await readIfExists(file);
    await writeChanged(file, before, codexApply(before, route, key), now);
  });
}

export async function removeCodex(
  file: string,
  route: string,
  digest: string,
  now: number,
): Promise<Removal> {
  return guarded(async () => {
    const before = await readIfExists(file);
    if (before === null) return "absent";
    const { text, result } = codexRemove(before, route, digest);
    await writeChanged(file, before, text, now, true);
    return result;
  });
}

// ---------------------------------------------------------------------------------------------------
// omp: a marked provider region in models.yml

export interface OmpProvider {
  name: string;
  api: "anthropic-messages" | "openai-responses" | "openai-completions";
  baseUrl: string;
  models: string[];
}

const OMP_BEGIN = "  # >>> paseo-agent-memory providers (managed)";
const OMP_END = "  # <<< paseo-agent-memory providers";
const PROVIDERS_KEY = /^providers:\s*(#.*)?$/;

function ompRegion(providers: OmpProvider[], key: string): string[] {
  const lines = [OMP_BEGIN];
  for (const provider of providers) {
    lines.push(
      `  ${provider.name}:`,
      `    baseUrl: ${JSON.stringify(provider.baseUrl)}`,
      `    apiKey: ${JSON.stringify(key)}`,
      `    api: ${provider.api}`,
      "    compat:",
      "      supportsPromptCacheKey: true",
      "    models:",
    );
    for (const id of provider.models) {
      lines.push(`      - id: ${JSON.stringify(id)}`, `        name: ${JSON.stringify(id)}`);
    }
  }
  lines.push(OMP_END);
  return lines;
}

function stripOmpRegion(lines: string[]): { lines: string[]; region: string[] | null } {
  const begin = lines.indexOf(OMP_BEGIN);
  const end = lines.indexOf(OMP_END);
  if (begin === -1 && end === -1) return { lines, region: null };
  if (begin === -1 || end === -1 || end < begin) throw new SetupFailure("models_invalid");
  return {
    lines: [...lines.slice(0, begin), ...lines.slice(end + 1)],
    region: lines.slice(begin, end + 1),
  };
}

const OMP_PROVIDER_NAMES = ["memory-anthropic", "memory-responses", "memory-chat"];

/** The region is written with two-space children, so the user's own children must use two spaces and other names. */
function checkOmpChildren(lines: string[], at: number): void {
  let first = true;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (first && indent !== "  ") throw new SetupFailure("models_invalid");
    first = false;
    if (indent !== "  ") continue;
    const name = /^ {2}(["']?)([^"':\s]+)\1\s*:/.exec(line)?.[2];
    if (name && OMP_PROVIDER_NAMES.includes(name)) throw new SetupFailure("models_invalid");
  }
}

export function ompApply(text: string | null, providers: OmpProvider[], key: string): string {
  // The edit reads LF only, as the installer's does.
  if (text !== null && text.includes("\r")) throw new SetupFailure("models_invalid");
  const region = ompRegion(providers, key);
  const parts = split(text ?? "");
  const { lines } = stripOmpRegion(parts.lines);
  const at = lines.findIndex((line) => PROVIDERS_KEY.test(line));
  if (at === -1) {
    if (lines.some((line) => /^providers:/.test(line))) throw new SetupFailure("models_invalid");
    return joinLines([...lines, "providers:", ...region], parts.eol, true);
  }
  checkOmpChildren(lines, at);
  return joinLines(
    [...lines.slice(0, at + 1), ...region, ...lines.slice(at + 1)],
    parts.eol,
    true,
  );
}

function jsonString(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `text: null` means nothing is left in the file, so the caller deletes it. */
export function ompRemove(
  text: string,
  route: string,
  digest: string,
): { text: string | null; result: Removal } {
  const parts = split(text);
  const { lines, region } = stripOmpRegion(parts.lines);
  if (!region) return { text, result: "absent" };
  const ours = region.every((line) => {
    const value = /^\s*(apiKey|baseUrl):\s*(.*)$/.exec(line);
    if (!value) return true;
    return value[1] === "apiKey" ? isKey(jsonString(value[2]), digest) : value[2].startsWith(`"${route}`);
  });
  if (!ours) return { text, result: "changed" };
  // A `providers:` key that only held our region is left empty, so it goes with it.
  const at = lines.findIndex((line) => PROVIDERS_KEY.test(line));
  const hollow =
    at !== -1 && lines.slice(at + 1).every((line) => line.trim() === "" || !/^\s/.test(line));
  const kept = hollow ? lines.filter((_, index) => index !== at) : lines;
  if (kept.every((line) => line.trim() === "")) return { text: null, result: "removed" };
  return { text: joinLines(kept, parts.eol, parts.finalNewline), result: "removed" };
}

export async function applyOmp(file: string, providers: OmpProvider[], key: string, now: number) {
  await guarded(async () => {
    const before = await readIfExists(file);
    await writeChanged(file, before, ompApply(before, providers, key), now);
  });
}

export async function removeOmp(
  file: string,
  route: string,
  digest: string,
  now: number,
): Promise<Removal> {
  return guarded(async () => {
    const before = await readIfExists(file);
    if (before === null) return "absent";
    const out = ompRemove(before, route, digest);
    await writeChanged(file, before, out.text, now, true);
    return out.result;
  });
}

// ---------------------------------------------------------------------------------------------------
// Antigravity: the gateway URL file that the installer writes

/** The content of the URL file: the proxy route of the client, then the key. */
export const agyGatewayUrl = (route: string, key: string): string => `${route}/${key}`;

export async function checkAgyUrl(
  file: string,
  route: string,
  digest: string,
): Promise<"ours" | "absent" | "changed"> {
  return guarded(async () => {
    const text = await readIfExists(file);
    if (text === null) return "absent";
    const value = text.trim();
    const prefix = agyGatewayUrl(route, "");
    return value.startsWith(prefix) && isKey(value.slice(prefix.length), digest) ? "ours" : "changed";
  });
}

// ---------------------------------------------------------------------------------------------------
// Antigravity: the MCP server in the global mcp_config.json (the file `agy mcp add` writes)

function parseMcpConfig(text: string | null): { config: Record<string, unknown>; servers: Record<string, unknown> } {
  const config = text === null || text.trim() === "" ? {} : parseSettings(text);
  const servers = config.mcpServers ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new SetupFailure("settings_invalid");
  }
  return { config, servers: servers as Record<string, unknown> };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The address of an entry when it is a URL; `null` for anything else. */
function entryUrl(entry: unknown): URL | null {
  if (!isRecord(entry) || typeof entry.serverUrl !== "string") return null;
  try {
    return new URL(entry.serverUrl);
  } catch {
    return null;
  }
}

/**
 * Adds the `agent-memory` server with its two headers and keeps every other entry and key. An entry of
 * that name is replaced only when it points at the MCP path of the same Panel; any other entry belongs to
 * the user and is never touched. When the plugin updates its own entry it keeps the fields it does not
 * write: other headers, unknown fields and `disabled`.
 */
export function agyMcpApply(text: string | null, url: string, instanceId: string, key: string): string {
  const { config, servers } = parseMcpConfig(text);
  const existing = servers[MCP_SERVER_NAME];
  let previous: Record<string, unknown> = {};
  if (existing !== undefined) {
    const found = entryUrl(existing);
    if (!found || found.pathname !== MCP_PATH || found.origin !== new URL(url).origin) {
      throw new SetupFailure("own_provider");
    }
    previous = existing as Record<string, unknown>;
  }
  const oldHeaders = isRecord(previous.headers) ? previous.headers : {};
  config.mcpServers = {
    ...servers,
    [MCP_SERVER_NAME]: {
      ...previous,
      disabled: typeof previous.disabled === "boolean" ? previous.disabled : false,
      headers: { ...oldHeaders, ...mcpHeaders(instanceId, key) },
      serverUrl: url,
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Removes only the entry that carries this key. A file that the plugin created is reported for deletion
 * (`text: null`) once nothing else is left in it; a file that existed before always stays.
 */
export function agyMcpRemove(
  text: string,
  digest: string,
  created: boolean,
): { text: string | null; result: Removal } {
  const { config, servers } = parseMcpConfig(text);
  const entry = servers[MCP_SERVER_NAME];
  if (entry === undefined) return { text, result: "absent" };
  const found = entryUrl(entry);
  const headers = isRecord(entry) ? entry.headers : undefined;
  if (!found || found.pathname !== MCP_PATH || !isRecord(headers) || !isKey(headers[MCP_KEY_HEADER], digest)) {
    return { text, result: "changed" };
  }
  delete servers[MCP_SERVER_NAME];
  config.mcpServers = servers;
  if (created && Object.keys(servers).length === 0) {
    delete config.mcpServers;
    if (Object.keys(config).length === 0) return { text: null, result: "removed" };
  }
  return { text: `${JSON.stringify(config, null, 2)}\n`, result: "removed" };
}

/** The file holds the key, so a file that was open to the group or others is closed to the owner only. */
export async function applyAgyMcp(file: string, url: string, instanceId: string, key: string, now: number) {
  await guarded(async () => {
    const before = await readIfExists(file);
    const after = agyMcpApply(before, url, instanceId, key);
    if (before === after) {
      const target = await resolveTarget(file);
      if (((await stat(target)).mode & 0o777) !== 0o600) await chmod(target, 0o600);
      return;
    }
    await writeChanged(file, before, after, now, false, true);
  });
}

export async function removeAgyMcp(file: string, digest: string, created: boolean, now: number): Promise<Removal> {
  return guarded(async () => {
    const before = await readIfExists(file);
    if (before === null) return "absent";
    const out = agyMcpRemove(before, digest, created);
    await writeChanged(file, before, out.text, now, true);
    return out.result;
  });
}
