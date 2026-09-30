import { db, withTransaction } from "../db/client.js";
import { newId } from "../util/id.js";
import { nowIso } from "../util/time.js";
import { getCategory, CategoryDef } from "./categories.js";
import { parseFile, ParsedFile } from "./parsers/index.js";
import { applyMapping, validateRows, FieldMapping, ValidationResult } from "./validators.js";
import { broadcastOverviewChanged } from "../realtime/sseHub.js";
import { persistRow } from "./persist.js";

export interface PreviewResult {
  category: string;
  headers: string[];
  suggestedMapping: FieldMapping;
  sampleRows: Record<string, unknown>[];
  totalRows: number;
}

function suggestMapping(category: CategoryDef, headers: string[]): FieldMapping {
  const mapping: FieldMapping = {};
  const normalizedHeaders = headers.map((h) => ({ raw: h, norm: h.toLowerCase().replace(/[\s_-]/g, "") }));
  for (const field of category.fields) {
    const fieldNorm = field.key.toLowerCase().replace(/[\s_-]/g, "");
    const exact = normalizedHeaders.find((h) => h.norm === fieldNorm);
    mapping[field.key] = exact ? exact.raw : null;
  }
  return mapping;
}

const previewCache = new Map<string, ParsedFile>();

export async function previewUpload(categoryKey: string, filename: string, buffer: Buffer): Promise<PreviewResult & { previewToken: string }> {
  const category = getCategory(categoryKey);
  const parsed = await parseFile(buffer, filename);
  const previewToken = newId("preview");
  previewCache.set(previewToken, parsed);
  // Avoid unbounded memory growth from abandoned previews.
  setTimeout(() => previewCache.delete(previewToken), 30 * 60 * 1000).unref();

  return {
    previewToken,
    category: categoryKey,
    headers: parsed.headers,
    suggestedMapping: suggestMapping(category, parsed.headers),
    sampleRows: parsed.rows.slice(0, 20),
    totalRows: parsed.rows.length,
  };
}

export interface DryRunResult {
  category: string;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  invalidSample: ValidationResult["invalid"];
}

function getParsedOrThrow(previewToken: string): ParsedFile {
  const parsed = previewCache.get(previewToken);
  if (!parsed) throw new Error("Preview expired or not found. Please re-upload the file.");
  return parsed;
}

export function validateUpload(categoryKey: string, previewToken: string, mapping: FieldMapping): DryRunResult {
  const category = getCategory(categoryKey);
  const parsed = getParsedOrThrow(previewToken);
  const mapped = applyMapping(parsed.rows, mapping);
  const result = validateRows(category, mapped);
  return {
    category: categoryKey,
    totalRows: parsed.rows.length,
    validCount: result.valid.length,
    invalidCount: result.invalid.length,
    invalidSample: result.invalid.slice(0, 200),
  };
}

export interface CommitResult {
  batchId: string;
  insertedCount: number;
  updatedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  errors: { rowNo: number; field: string | null; message: string }[];
}

function writeRow(category: CategoryDef, data: Record<string, unknown>): "inserted" | "updated" | "duplicate" {
  const outcome = persistRow(category, data, category.keyPolicy === "insert-if-new" ? "insert-only" : "upsert");
  // "upsert" mode never returns ignored-older, so this narrowing is safe.
  return outcome as "inserted" | "updated" | "duplicate";
}

export function commitUpload(categoryKey: string, previewToken: string, mapping: FieldMapping, filename: string): CommitResult {
  const category = getCategory(categoryKey);
  const parsed = getParsedOrThrow(previewToken);
  const mapped = applyMapping(parsed.rows, mapping);
  const { valid, invalid } = validateRows(category, mapped);

  const batchId = newId("batch");

  const result = withTransaction<CommitResult>(() => {
    let inserted = 0;
    let updated = 0;
    let duplicate = 0;

    for (const row of valid) {
      const outcome = writeRow(category, row.data);
      if (outcome === "inserted") inserted++;
      else if (outcome === "updated") updated++;
      else duplicate++;
    }

    db.prepare(
      `INSERT INTO import_batches (id, category, source_type, filename, uploaded_at, status, inserted_count, updated_count, duplicate_count, rejected_count, mapping_json)
       VALUES (?, ?, 'file', ?, ?, 'committed', ?, ?, ?, ?, ?)`
    ).run(batchId, categoryKey, filename, nowIso(), inserted, updated, duplicate, invalid.length, JSON.stringify(mapping));

    for (const inv of invalid) {
      for (const err of inv.errors) {
        db.prepare(
          `INSERT INTO import_row_errors (id, batch_id, row_no, field, message, raw_json) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(newId("err"), batchId, inv.rowNo, err.field, err.message, JSON.stringify(inv.raw));
      }
    }

    return {
      batchId,
      insertedCount: inserted,
      updatedCount: updated,
      duplicateCount: duplicate,
      rejectedCount: invalid.length,
      errors: invalid.flatMap((inv) => inv.errors.map((e) => ({ rowNo: inv.rowNo, field: e.field, message: e.message }))),
    };
  });

  previewCache.delete(previewToken);
  broadcastOverviewChanged(`file upload committed: ${categoryKey}`);
  return result;
}

export function listImportBatches(): unknown[] {
  return db.prepare(`SELECT * FROM import_batches ORDER BY uploaded_at DESC LIMIT 100`).all();
}

export function getImportBatch(batchId: string): { batch: unknown; errors: unknown[] } | null {
  const batch = db.prepare(`SELECT * FROM import_batches WHERE id = ?`).get(batchId);
  if (!batch) return null;
  const errors = db.prepare(`SELECT * FROM import_row_errors WHERE batch_id = ? LIMIT 500`).all(batchId);
  return { batch, errors };
}
