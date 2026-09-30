import { db } from "../db/client.js";
import { nowIso } from "../util/time.js";

export type SourceMode = "LIVE" | "REPLAY" | "SIMULATION";
export type HealthStatus = "healthy" | "stale" | "failed" | "unknown";

export interface SourceStatus {
  id: string;
  label: string;
  mode: SourceMode;
  connectionStatus: "connected" | "disconnected" | "not_configured";
  lastSuccessfulIngestionAt: string | null;
  latestSourceTimestamp: string | null;
  refreshIntervalSec: number | null;
  lagSeconds: number | null;
  health: HealthStatus;
}

const STALE_MULTIPLIER = 3; // if lag exceeds 3x the poll interval, mark stale

function computeHealth(lastSuccessAt: string | null, refreshIntervalSec: number | null, hasError: boolean): { health: HealthStatus; lagSeconds: number | null } {
  if (hasError) return { health: "failed", lagSeconds: null };
  if (!lastSuccessAt) return { health: "unknown", lagSeconds: null };
  const lagSeconds = Math.floor((Date.now() - new Date(lastSuccessAt).getTime()) / 1000);
  if (refreshIntervalSec && lagSeconds > refreshIntervalSec * STALE_MULTIPLIER) {
    return { health: "stale", lagSeconds };
  }
  return { health: "healthy", lagSeconds };
}

export function getFileUploadSourceStatus(): SourceStatus {
  const row = db
    .prepare(`SELECT MAX(uploaded_at) as last, COUNT(*) as c FROM import_batches WHERE source_type = 'file' AND status = 'committed'`)
    .get() as { last: string | null; c: number };
  const { health, lagSeconds } = computeHealth(row.last, null, false);
  return {
    id: "file-uploads",
    label: "File uploads",
    mode: "LIVE",
    connectionStatus: row.c > 0 ? "connected" : "not_configured",
    lastSuccessfulIngestionAt: row.last,
    latestSourceTimestamp: row.last,
    refreshIntervalSec: null,
    lagSeconds,
    health: row.c > 0 ? "healthy" : "unknown",
  };
}

export function getConnectorSourceStatuses(): SourceStatus[] {
  const rows = db.prepare(`SELECT * FROM connectors`).all() as {
    id: string;
    name: string;
    status: string;
    poll_interval_sec: number;
    last_success_at: string | null;
    last_source_ts: string | null;
    last_error: string | null;
  }[];
  return rows.map((c) => {
    const hasError = c.status === "failed";
    const { health, lagSeconds } = computeHealth(c.last_success_at, c.poll_interval_sec, hasError);
    return {
      id: c.id,
      label: c.name,
      mode: "LIVE",
      connectionStatus: c.status === "running" ? "connected" : c.status === "failed" ? "disconnected" : "not_configured",
      lastSuccessfulIngestionAt: c.last_success_at,
      latestSourceTimestamp: c.last_source_ts,
      refreshIntervalSec: c.poll_interval_sec,
      lagSeconds,
      health,
    };
  });
}

export function getAllSourceStatuses(): SourceStatus[] {
  return [getFileUploadSourceStatus(), ...getConnectorSourceStatuses()];
}
