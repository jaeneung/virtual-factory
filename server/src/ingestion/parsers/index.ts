import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_ROWS = 100_000;

export interface ParsedFile {
  headers: string[];
  rows: Record<string, unknown>[];
}

export class ParseError extends Error {}

function inferHeaders(rows: Record<string, unknown>[]): string[] {
  const set = new Set<string>();
  for (const row of rows.slice(0, 200)) {
    for (const k of Object.keys(row)) set.add(k);
  }
  return Array.from(set);
}

function parseCsvBuffer(buf: Buffer): ParsedFile {
  const records = parseCsv(buf, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, unknown>[];
  return { headers: inferHeaders(records), rows: records };
}

function parseJsonBuffer(buf: Buffer): ParsedFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf-8"));
  } catch (err) {
    throw new ParseError(`Invalid JSON: ${(err as Error).message}`);
  }
  const rows: Record<string, unknown>[] = Array.isArray(parsed)
    ? (parsed as Record<string, unknown>[])
    : Array.isArray((parsed as { records?: unknown }).records)
      ? ((parsed as { records: Record<string, unknown>[] }).records)
      : [];
  if (!Array.isArray(rows)) {
    throw new ParseError("JSON must be an array of records, or an object with a 'records' array.");
  }
  return { headers: inferHeaders(rows), rows };
}

function cellToValue(cell: ExcelJS.CellValue): unknown {
  if (cell && typeof cell === "object") {
    if (cell instanceof Date) return cell;
    if ("result" in cell) return (cell as { result: unknown }).result; // formula cell
    if ("text" in cell) return (cell as { text: unknown }).text; // rich text
  }
  return cell;
}

async function parseXlsxBuffer(buf: Buffer): Promise<ParsedFile> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new ParseError("Workbook has no sheets.");

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? "").trim();
  });

  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, unknown> = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (!header) return;
      const value = cellToValue(cell.value);
      if (value !== null && value !== undefined && value !== "") hasValue = true;
      record[header] = value;
    });
    if (hasValue) rows.push(record);
  });

  return { headers: headers.filter(Boolean), rows };
}

export async function parseFile(buf: Buffer, filename: string): Promise<ParsedFile> {
  if (buf.length > MAX_FILE_SIZE_BYTES) {
    throw new ParseError(`File exceeds maximum size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`);
  }
  const ext = filename.toLowerCase().split(".").pop();
  let parsed: ParsedFile;
  if (ext === "csv") parsed = parseCsvBuffer(buf);
  else if (ext === "json") parsed = parseJsonBuffer(buf);
  else if (ext === "xlsx") parsed = await parseXlsxBuffer(buf);
  else throw new ParseError(`Unsupported file type: .${ext ?? "unknown"}. Supported: .csv, .json, .xlsx`);

  if (parsed.rows.length > MAX_ROWS) {
    throw new ParseError(`File has ${parsed.rows.length} rows, exceeding the limit of ${MAX_ROWS}.`);
  }
  return parsed;
}
