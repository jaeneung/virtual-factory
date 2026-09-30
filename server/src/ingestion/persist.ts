import { db } from "../db/client.js";
import { nowIso } from "../util/time.js";
import { CategoryDef } from "./categories.js";
import { newId } from "../util/id.js";

export type ConflictMode = "insert-only" | "upsert" | "upsert-if-newer";
export type PersistOutcome = "inserted" | "updated" | "duplicate" | "ignored-older";

/**
 * Writes one validated row using the category's key policy.
 * - "insert-only": used for file uploads of event/fact data — a repeat of the same
 *   natural key is a duplicate and is left untouched (no silent overwrite of history).
 * - "upsert": used for file uploads of config/master data and orders — re-uploading
 *   updates the existing row.
 * - "upsert-if-newer": used for API-sourced event data — out-of-order or duplicate
 *   events (source timestamp <= what's stored) are ignored; genuinely newer updates win.
 * Also fills in the bookkeeping columns (created_at/updated_at for config-like tables,
 * source_ts/ingested_at for event-like tables) that callers don't set directly.
 */
export function persistRow(category: CategoryDef, data: Record<string, unknown>, mode: ConflictMode): PersistOutcome {
  const cols = [...category.fields.map((f) => f.key)];
  const values: Record<string, unknown> = { ...data };
  if (cols.includes("id") && (values.id === null || values.id === undefined)) values.id = newId(category.table);
  const now = nowIso();
  const isEventLike = category.keyPolicy === "insert-if-new";

  if (!isEventLike) {
    if (!cols.includes("created_at")) cols.push("created_at");
    if (!cols.includes("updated_at")) cols.push("updated_at");
    values.created_at = now;
    values.updated_at = now;
  } else {
    if (!cols.includes("ingested_at")) cols.push("ingested_at");
    values.ingested_at = now;
    if (category.deriveSourceTsFrom && !cols.includes("source_ts")) {
      cols.push("source_ts");
      values.source_ts = data[category.deriveSourceTsFrom];
    }
  }

  const conflictCols = category.naturalKey;
  const placeholders = cols.map(() => "?").join(",");
  const insertValues = cols.map((c) => (values[c] as string | number | null | undefined) ?? null);

  if (mode === "insert-only") {
    const info = db
      .prepare(`INSERT INTO ${category.table} (${cols.join(",")}) VALUES (${placeholders}) ON CONFLICT(${conflictCols.join(",")}) DO NOTHING`)
      .run(...insertValues);
    return Number(info.changes) > 0 ? "inserted" : "duplicate";
  }

  const existing = db
    .prepare(`SELECT * FROM ${category.table} WHERE ${conflictCols.map((k) => `${k}=?`).join(" AND ")}`)
    .get(...conflictCols.map((k) => values[k] as string)) as Record<string, unknown> | undefined;

  if (mode === "upsert-if-newer" && existing) {
    const tsCol = cols.includes("source_ts") ? "source_ts" : null;
    if (tsCol) {
      const existingTs = existing[tsCol] as string | undefined;
      const newTs = values[tsCol] as string | undefined;
      if (existingTs && newTs && String(newTs) <= String(existingTs)) {
        return "ignored-older";
      }
    }
  }

  const updateSet = cols
    .filter((c) => !conflictCols.includes(c) && c !== "created_at")
    .map((c) => `${c}=excluded.${c}`)
    .join(",");
  db.prepare(
    `INSERT INTO ${category.table} (${cols.join(",")}) VALUES (${placeholders}) ON CONFLICT(${conflictCols.join(",")}) DO UPDATE SET ${updateSet}`
  ).run(...insertValues);
  return existing ? "updated" : "inserted";
}
