/** All internal timestamps are ISO-8601 UTC strings (e.g. 2026-01-15T08:30:00.000Z). */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isValidIsoDate(value: string): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

export function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
