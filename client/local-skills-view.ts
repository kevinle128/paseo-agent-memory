import {
  LocalInventoryRow,
  localSkillNameError,
  relativeSkillPathError,
  type LocalInventoryRow as InventoryRow,
} from "../shared/inventory";

/** A row is shown only when the inventory schema and the path allowlist accept it. */
export function isSafeInventoryRow(row: unknown): row is InventoryRow {
  const parsed = LocalInventoryRow.safeParse(row);
  if (!parsed.success) return false;
  if (localSkillNameError(parsed.data.name)) return false;
  if (relativeSkillPathError(parsed.data.relative_path)) return false;
  return true;
}

export interface InventoryDisplayRow {
  name: string;
  harnessLabel: string;
  sourceLabel: string;
  rootKind: string;
  relativePath: string;
  hashPrefix: string;
  reportedAtMs: number;
}

/** The fields the Local skills section prints. Unsafe rows are omitted. */
export function displayInventoryRows(
  rows: unknown,
  labels: {
    harness: (id: InventoryRow["harness"]) => string;
    source: (source: InventoryRow["source"]) => string;
  },
): InventoryDisplayRow[] {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter(isSafeInventoryRow).map((row) => ({
    name: row.name,
    harnessLabel: labels.harness(row.harness),
    sourceLabel: labels.source(row.source),
    rootKind: row.root_kind,
    relativePath: row.relative_path,
    hashPrefix: row.content_hash.slice(0, 12),
    reportedAtMs: row.reported_at_ms,
  }));
}

/** One line per visible row, used by the screen and by the view test. */
export function renderInventoryText(
  rows: readonly InventoryRow[],
  labels: {
    harness: (id: InventoryRow["harness"]) => string;
    source: (source: InventoryRow["source"]) => string;
  },
): string {
  return displayInventoryRows(rows, labels)
    .map((row) =>
      [
        row.name,
        row.harnessLabel,
        row.sourceLabel,
        row.rootKind,
        row.relativePath,
        row.hashPrefix,
        String(row.reportedAtMs),
      ].join("\t"),
    )
    .join("\n");
}
