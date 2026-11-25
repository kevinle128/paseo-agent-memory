import { z } from "zod";
import { HarnessId } from "./harness";

/**
 * Letters (with combining marks), digits, one ASCII space, and `.` `_` `-`.
 * The same allowlist Core uses so a home directory, an encoded `..`, or a
 * control character cannot be stored or shown.
 */
const RELATIVE_SEGMENT = /^[\p{L}\p{M}\p{N} ._-]+$/u;

/** `cloud_install` is not emitted: a scan only reports folders it walked. */
export const InventorySource = z.enum(["user", "project", "third_party_plugin"]);
export type InventorySource = z.infer<typeof InventorySource>;

/**
 * Return a reason when `value` is not one folder name. Any first word is
 * allowed here; a path has a tighter check.
 */
export function localSkillNameError(value: string): string | null {
  if (value.length < 1 || value.length > 128) return "name must be 1-128 characters";
  if (value === "." || value === ".." || value.includes("%") || value.includes("\uFF0E")) {
    return "name must be a single folder name";
  }
  if (/[\p{C}]/u.test(value) || !RELATIVE_SEGMENT.test(value)) return "name must be a single folder name";
  return null;
}

/** Return a reason when `value` is not a relative path under a named root. */
export function relativeSkillPathError(value: string): string | null {
  if (value.length < 1 || value.length > 512) return "relative_path must be 1-512 characters";
  if (value.includes("\0") || value.includes("\\")) return "relative_path must not contain a backslash or a null";
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) {
    return "relative_path must be relative";
  }
  if (/[\p{C}]/u.test(value) || value.includes("\uFF0E")) {
    return "relative_path must not contain a control, format, or fullwidth dot";
  }
  if (value.includes("%")) return "relative_path must not contain percent-encoding";
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return "relative_path must not contain '..' or an empty segment";
  }
  const head = parts[0].normalize("NFKC").toLowerCase();
  if (head === "users" || head === "home") return "relative_path must not use a home prefix";
  for (const part of parts) {
    if (!RELATIVE_SEGMENT.test(part)) return "relative_path must use letters, digits, spaces, and ._- only";
  }
  return null;
}

export const LocalInventoryItem = z
  .object({
    harness: HarnessId,
    source: InventorySource,
    name: z.string(),
    root_kind: z.string().regex(/^[a-z0-9_]{1,64}$/),
    relative_path: z.string(),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type LocalInventoryItem = z.infer<typeof LocalInventoryItem>;

export const LocalInventoryRow = LocalInventoryItem.extend({
  inventory_id: z.number(),
  machine_id: z.string(),
  reported_at_ms: z.number().refine((ms) => !Number.isNaN(new Date(ms).getTime())),
  present: z.number(),
}).strict();
export type LocalInventoryRow = z.infer<typeof LocalInventoryRow>;

export const InventoryErrorCode = z.enum([
  "auth_failed",
  "network",
  "server_unavailable",
  "bad_response",
]);
export type InventoryErrorCode = z.infer<typeof InventoryErrorCode>;

export const LocalInventoryView = z.discriminatedUnion("state", [
  z.object({ state: z.literal("signed_out") }),
  z.object({
    state: z.literal("connected"),
    scanning: z.boolean(),
    items: z.array(LocalInventoryRow),
    syncedAt: z.string().optional(),
    error: InventoryErrorCode.optional(),
  }),
]);
export type LocalInventoryView = z.infer<typeof LocalInventoryView>;
