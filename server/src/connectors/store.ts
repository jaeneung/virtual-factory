import { db } from "../db/client.js";
import { newId } from "../util/id.js";
import { nowIso } from "../util/time.js";

export interface ConnectorRow {
  id: string;
  name: string;
  category: string;
  base_url: string;
  endpoint_path: string;
  auth_type: "none" | "api_key" | "bearer";
  secret_env_var: string | null;
  poll_interval_sec: number;
  allow_private_network: number;
  mapping_json: string | null;
  status: "stopped" | "running" | "failed";
  last_cursor: string | null;
  last_success_at: string | null;
  last_source_ts: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface CreateConnectorInput {
  name: string;
  category: string;
  baseUrl: string;
  endpointPath: string;
  authType: "none" | "api_key" | "bearer";
  secretEnvVar?: string;
  pollIntervalSec: number;
  allowPrivateNetwork: boolean;
  mapping: Record<string, string | null>;
}

export function listConnectors(): ConnectorRow[] {
  return db.prepare(`SELECT * FROM connectors ORDER BY created_at DESC`).all() as unknown as ConnectorRow[];
}

export function getConnector(id: string): ConnectorRow | null {
  return (db.prepare(`SELECT * FROM connectors WHERE id = ?`).get(id) as unknown as ConnectorRow) ?? null;
}

export function createConnector(input: CreateConnectorInput): ConnectorRow {
  const id = newId("conn");
  const now = nowIso();
  db.prepare(
    `INSERT INTO connectors (id, name, category, base_url, endpoint_path, auth_type, secret_env_var, poll_interval_sec, allow_private_network, mapping_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?)`
  ).run(
    id,
    input.name,
    input.category,
    input.baseUrl,
    input.endpointPath,
    input.authType,
    input.secretEnvVar ?? null,
    input.pollIntervalSec,
    input.allowPrivateNetwork ? 1 : 0,
    JSON.stringify(input.mapping),
    now,
    now
  );
  return getConnector(id)!;
}

export function deleteConnector(id: string): void {
  db.prepare(`DELETE FROM connectors WHERE id = ?`).run(id);
}

export function markRunning(id: string): void {
  db.prepare(`UPDATE connectors SET status='running', updated_at=? WHERE id=?`).run(nowIso(), id);
}

export function markStopped(id: string): void {
  db.prepare(`UPDATE connectors SET status='stopped', updated_at=? WHERE id=?`).run(nowIso(), id);
}

export function recordPollSuccess(id: string, nextCursor: string, latestSourceTs: string | null): void {
  db.prepare(
    `UPDATE connectors SET status='running', last_cursor=?, last_success_at=?, last_source_ts=COALESCE(?, last_source_ts),
     last_error=NULL, last_error_at=NULL, consecutive_failures=0, updated_at=? WHERE id=?`
  ).run(nextCursor, nowIso(), latestSourceTs, nowIso(), id);
}

export function recordPollFailure(id: string, message: string): void {
  db.prepare(
    `UPDATE connectors SET status='failed', last_error=?, last_error_at=?, consecutive_failures=consecutive_failures+1, updated_at=? WHERE id=?`
  ).run(message, nowIso(), nowIso(), id);
}

/** Resolves the connector's secret from a server-side environment variable — never stored
 *  in the DB, never sent to the browser, never logged. */
export function resolveSecret(connector: ConnectorRow): string | null {
  if (!connector.secret_env_var) return null;
  return process.env[connector.secret_env_var] ?? null;
}
