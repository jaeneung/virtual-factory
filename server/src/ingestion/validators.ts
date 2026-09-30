import { db } from "../db/client.js";
import { CategoryDef, FieldDef } from "./categories.js";
import { isValidIsoDate, toIso } from "../util/time.js";

export type FieldMapping = Record<string, string | null>; // internal field key -> source header (or null if unmapped)

export interface RowError {
  field: string | null;
  message: string;
}

export interface ValidatedRow {
  rowNo: number;
  data: Record<string, unknown>;
}

export interface InvalidRow {
  rowNo: number;
  raw: Record<string, unknown>;
  errors: RowError[];
}

export interface ValidationResult {
  valid: ValidatedRow[];
  invalid: InvalidRow[];
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n", ""].includes(s)) return false;
  return undefined;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function fetchReferenceSets(category: CategoryDef, rows: Record<string, unknown>[]): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const field of category.fields) {
    if (!field.refTable) continue;
    const col = field.refColumn ?? "id";
    const cacheKey = `${field.refTable}.${col}`;
    if (sets.has(cacheKey)) continue;
    const values = new Set<string>();
    for (const row of rows) {
      const v = row[field.key];
      if (!isEmpty(v)) values.add(String(v).trim());
    }
    if (values.size === 0) {
      sets.set(cacheKey, new Set());
      continue;
    }
    const placeholders = Array.from(values).map(() => "?").join(",");
    const found = db
      .prepare(`SELECT ${col} as v FROM ${field.refTable} WHERE ${col} IN (${placeholders})`)
      .all(...Array.from(values)) as { v: string }[];
    sets.set(cacheKey, new Set(found.map((f) => String(f.v))));
  }
  return sets;
}

/** Applies the source->internal field mapping to raw parsed rows. */
export function applyMapping(rows: Record<string, unknown>[], mapping: FieldMapping): Record<string, unknown>[] {
  return rows.map((row) => {
    const mapped: Record<string, unknown> = {};
    for (const [internalKey, sourceHeader] of Object.entries(mapping)) {
      if (!sourceHeader) continue;
      mapped[internalKey] = row[sourceHeader];
    }
    return mapped;
  });
}

function validateField(field: FieldDef, rawValue: unknown, refSets: Map<string, Set<string>>): { value: unknown; error?: string } {
  if (isEmpty(rawValue)) {
    if (field.required) return { value: undefined, error: `${field.label} is required.` };
    const def = field.defaultValue;
    return { value: typeof def === "boolean" ? (def ? 1 : 0) : (def ?? null) };
  }

  switch (field.type) {
    case "string": {
      return { value: String(rawValue).trim() };
    }
    case "number": {
      const n = typeof rawValue === "number" ? rawValue : Number(String(rawValue).trim());
      if (Number.isNaN(n)) return { value: undefined, error: `${field.label} must be a number (got "${rawValue}").` };
      return { value: n };
    }
    case "boolean": {
      const b = coerceBoolean(rawValue);
      if (b === undefined) return { value: undefined, error: `${field.label} must be a boolean (got "${rawValue}").` };
      return { value: b ? 1 : 0 };
    }
    case "date": {
      const dateVal = rawValue instanceof Date ? rawValue : String(rawValue).trim();
      const isoCandidate = rawValue instanceof Date ? rawValue.toISOString() : String(dateVal);
      if (!isValidIsoDate(isoCandidate)) {
        return { value: undefined, error: `${field.label} must be a valid date/time (got "${rawValue}"). Use ISO-8601, e.g. 2026-01-15T08:00:00Z.` };
      }
      // JS would parse an offset-less datetime as server-local time and silently shift it, so require an explicit zone.
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(isoCandidate);
      const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(isoCandidate);
      if (!(rawValue instanceof Date) && !isDateOnly && !hasOffset) {
        return { value: undefined, error: `${field.label} has no time zone (got "${rawValue}"). Add an explicit offset such as Z (UTC) or +09:00, e.g. 2026-01-15T08:00:00Z.` };
      }
      return { value: toIso(isoCandidate) };
    }
    case "enum": {
      const s = String(rawValue).trim().toLowerCase();
      const match = field.enumValues?.find((v) => v.toLowerCase() === s);
      if (!match) {
        return { value: undefined, error: `${field.label} must be one of: ${field.enumValues?.join(", ")} (got "${rawValue}").` };
      }
      return { value: match };
    }
    default:
      return { value: rawValue };
  }
}

export function validateRows(category: CategoryDef, mappedRows: Record<string, unknown>[]): ValidationResult {
  const refSets = fetchReferenceSets(category, mappedRows);
  const valid: ValidatedRow[] = [];
  const invalid: InvalidRow[] = [];

  mappedRows.forEach((raw, idx) => {
    const rowNo = idx + 1;
    const errors: RowError[] = [];
    const data: Record<string, unknown> = {};

    for (const field of category.fields) {
      const { value, error } = validateField(field, raw[field.key], refSets);
      if (error) {
        errors.push({ field: field.key, message: error });
        continue;
      }
      data[field.key] = value;

      if (field.refTable && !isEmpty(value)) {
        const col = field.refColumn ?? "id";
        const set = refSets.get(`${field.refTable}.${col}`);
        if (!set?.has(String(value))) {
          errors.push({
            field: field.key,
            message: `${field.label} "${value}" does not reference an existing ${field.refTable} record. Import ${field.refTable} first or fix this value.`,
          });
        }
      }
    }

    if (errors.length > 0) {
      invalid.push({ rowNo, raw, errors });
    } else {
      valid.push({ rowNo, data });
    }
  });

  return { valid, invalid };
}
