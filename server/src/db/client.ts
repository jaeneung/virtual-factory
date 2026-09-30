import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Loaded via createRequire because bundlers/test runners (Vite) strip the prefix-only "node:sqlite" specifier.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncType };

export const DATA_DIR = process.env.VF_DATA_DIR ?? path.resolve(__dirname, "../../data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.VF_DB_PATH ?? path.join(DATA_DIR, "app.db");

// node:sqlite is experimental as of Node 22-24. It is used here (instead of
// better-sqlite3) specifically to avoid a native build step on Windows. See
// docs/ASSUMPTIONS.md for this trade-off.
export const db: DatabaseSyncType = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

export function runMigrations(): void {
  const schemaPath = path.resolve(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);
}

export function resetDatabase(): void {
  db.exec("PRAGMA foreign_keys = OFF;");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const t of tables) {
    db.exec(`DROP TABLE IF EXISTS "${t.name}";`);
  }
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations();
}

/** Convenience helper: run a function inside a transaction (BEGIN/COMMIT/ROLLBACK). */
export function withTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
