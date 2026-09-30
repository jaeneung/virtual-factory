import { db } from "../db/client.js";

/**
 * RULE-BASED BASELINE, not a trained model. Flags the most recent sensor reading for a
 * given (equipment, metric) as anomalous when it deviates from the trailing readings'
 * mean by more than Z_THRESHOLD standard deviations. This is a simple statistical
 * threshold, not an ML anomaly detector, and is not validated against real factory faults.
 */
export interface SensorAnomaly {
  equipmentId: string;
  metric: string;
  latestValue: number;
  latestSourceTs: string;
  trailingMean: number;
  trailingStdDev: number;
  zScore: number | null;
  anomalous: boolean;
}

const Z_THRESHOLD = 3;
const TRAILING_WINDOW = 30;

export function getEquipmentAnomalies(equipmentId?: string): SensorAnomaly[] {
  const pairs = db
    .prepare(
      equipmentId
        ? `SELECT DISTINCT equipment_id, metric FROM sensor_readings WHERE equipment_id = ?`
        : `SELECT DISTINCT equipment_id, metric FROM sensor_readings`
    )
    .all(...(equipmentId ? [equipmentId] : [])) as { equipment_id: string; metric: string }[];

  const results: SensorAnomaly[] = [];
  for (const p of pairs) {
    const readings = db
      .prepare(
        `SELECT value, source_ts FROM sensor_readings WHERE equipment_id = ? AND metric = ? ORDER BY source_ts DESC LIMIT ?`
      )
      .all(p.equipment_id, p.metric, TRAILING_WINDOW + 1) as { value: number; source_ts: string }[];
    if (readings.length < 5) continue; // not enough history for a meaningful baseline

    const [latest, ...trailing] = readings;
    const mean = trailing.reduce((s, r) => s + r.value, 0) / trailing.length;
    const variance = trailing.reduce((s, r) => s + (r.value - mean) ** 2, 0) / trailing.length;
    const stdDev = Math.sqrt(variance);
    const z = stdDev > 0 ? (latest.value - mean) / stdDev : null;
    results.push({
      equipmentId: p.equipment_id,
      metric: p.metric,
      latestValue: latest.value,
      latestSourceTs: latest.source_ts,
      trailingMean: round(mean),
      trailingStdDev: round(stdDev),
      zScore: z === null ? null : round(z),
      anomalous: z !== null && Math.abs(z) > Z_THRESHOLD,
    });
  }
  return results;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
