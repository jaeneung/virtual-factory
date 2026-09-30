import { db } from "../db/client.js";
import { OverviewFilters, buildWhere, FINAL_STEP_CLAUSE } from "./filters.js";
import { calculateOperatingCost } from "./cost.js";
import { nowIso } from "../util/time.js";

export type KpiValue =
  | { available: true; value: number; unit: string; numerator: number; denominator: number; window: { from?: string; to?: string } }
  | { available: false; reason: string };

/**
 * KPI definitions (see docs/ASSUMPTIONS.md for full detail):
 * - On-time delivery rate: shipments in the window with ship_ts <= the order's due_date,
 *   divided by all shipments in the window. Denominator = shipments, not orders — an order
 *   with no shipment yet is not counted either way until it ships.
 * - Good-unit output: sum(good_qty) from production_records in the window/filters.
 * - Defect rate: sum(defect_qty) / sum(inspected_qty) from inspections in the window.
 * - Unplanned downtime: sum of equipment_states durations where state IN (stopped, maintenance)
 *   and planned = 0, in hours, within the window.
 * - Total operating cost: see cost.ts.
 * All timestamps are compared in UTC. "Unavailable" means the required source category has no
 * rows at all (not that the computed value happens to be zero).
 */

export function onTimeDeliveryRate(filters: OverviewFilters): KpiValue {
  const totalAny = db.prepare(`SELECT COUNT(*) as c FROM shipments`).get() as { c: number };
  if (totalAny.c === 0) return { available: false, reason: "no shipments imported" };

  const where = buildWhere(filters, "s.ship_ts", { factory_id: "o.factory_id", product_id: "o.product_id" });
  const rows = db
    .prepare(
      `SELECT s.ship_ts, o.due_date FROM shipments s JOIN orders o ON o.id = s.order_id WHERE ${where.clause}`
    )
    .all(...where.params) as { ship_ts: string; due_date: string }[];

  if (rows.length === 0) return { available: false, reason: "no shipments in the selected window/filters" };
  const onTime = rows.filter((r) => r.ship_ts <= r.due_date).length;
  return {
    available: true,
    value: round(onTime / rows.length),
    unit: "ratio",
    numerator: onTime,
    denominator: rows.length,
    window: { from: filters.from, to: filters.to },
  };
}

export function goodUnitOutput(filters: OverviewFilters): KpiValue {
  const totalAny = db.prepare(`SELECT COUNT(*) as c FROM production_records`).get() as { c: number };
  if (totalAny.c === 0) return { available: false, reason: "no production records imported" };

  const where = buildWhere(filters, "pr.source_ts", {
    factory_id: "e.factory_id",
    line_id: "e.line_id",
    equipment_id: "pr.equipment_id",
    product_id: "pr.product_id",
  });
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(pr.good_qty),0) as good FROM production_records pr JOIN equipment e ON e.id = pr.equipment_id WHERE ${where.clause} AND ${FINAL_STEP_CLAUSE}`
    )
    .get(...where.params) as { good: number };

  return {
    available: true,
    value: row.good,
    unit: "units",
    numerator: row.good,
    denominator: 1,
    window: { from: filters.from, to: filters.to },
  };
}

export function defectRate(filters: OverviewFilters): KpiValue {
  const totalAny = db.prepare(`SELECT COUNT(*) as c FROM inspections`).get() as { c: number };
  if (totalAny.c === 0) return { available: false, reason: "no inspection records imported" };

  const where = buildWhere(filters, "i.inspected_ts", { product_id: "i.product_id" });
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(i.defect_qty),0) as defects, COALESCE(SUM(i.inspected_qty),0) as inspected FROM inspections i WHERE ${where.clause}`
    )
    .get(...where.params) as { defects: number; inspected: number };

  if (row.inspected === 0) return { available: false, reason: "no inspections in the selected window/filters" };
  return {
    available: true,
    value: round(row.defects / row.inspected),
    unit: "ratio",
    numerator: row.defects,
    denominator: row.inspected,
    window: { from: filters.from, to: filters.to },
  };
}

export function unplannedDowntimeHours(filters: OverviewFilters): KpiValue {
  const totalAny = db.prepare(`SELECT COUNT(*) as c FROM equipment_states`).get() as { c: number };
  if (totalAny.c === 0) return { available: false, reason: "no equipment state records imported" };

  const where = buildWhere(filters, "es.source_ts", { factory_id: "e.factory_id", equipment_id: "es.equipment_id" });
  const rows = db
    .prepare(
      `SELECT es.start_ts, es.end_ts FROM equipment_states es JOIN equipment e ON e.id = es.equipment_id
       WHERE es.planned = 0 AND es.state IN ('stopped','maintenance') AND ${where.clause}`
    )
    .all(...where.params) as { start_ts: string; end_ts: string | null }[];

  if (rows.length === 0) return { available: false, reason: "no unplanned downtime intervals in the selected window/filters" };
  const now = nowIso();
  const hours = rows.reduce((sum, r) => sum + (new Date(r.end_ts ?? now).getTime() - new Date(r.start_ts).getTime()) / 3_600_000, 0);
  return {
    available: true,
    value: round(hours),
    unit: "hours",
    numerator: rows.length,
    denominator: 1,
    window: { from: filters.from, to: filters.to },
  };
}

export function totalOperatingCost(filters: OverviewFilters): KpiValue & { excluded?: { reason: string; context: string }[] } {
  const totalAny = db.prepare(`SELECT COUNT(*) as c FROM production_records`).get() as { c: number };
  if (totalAny.c === 0) return { available: false, reason: "no production records imported to calculate cost from" };
  const breakdown = calculateOperatingCost(filters);
  return {
    available: true,
    value: breakdown.totalCost,
    unit: "USD",
    numerator: breakdown.totalCost,
    denominator: 1,
    window: { from: filters.from, to: filters.to },
    excluded: breakdown.excluded,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function computeAllKpis(filters: OverviewFilters) {
  return {
    onTimeDeliveryRate: onTimeDeliveryRate(filters),
    goodUnitOutput: goodUnitOutput(filters),
    defectRate: defectRate(filters),
    unplannedDowntimeHours: unplannedDowntimeHours(filters),
    totalOperatingCost: totalOperatingCost(filters),
  };
}
