import { db } from "../db/client.js";
import { OverviewFilters, buildWhere, FINAL_STEP_CLAUSE } from "./filters.js";
import { computeAllKpis } from "./kpi.js";
import { calculateOperatingCost } from "./cost.js";
import { getAtRiskLots } from "../intelligence/yieldBaseline.js";
import { getEquipmentAnomalies } from "../intelligence/anomalyBaseline.js";
import { currentStock } from "./inventory.js";
import { nowIso } from "../util/time.js";

const SHORTAGE_LOOKAHEAD_DAYS = 14;
const THROUGHPUT_LOOKBACK_DAYS = 14;

function daysFromNow(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------- Production

function productionPanel(filters: OverviewFilters) {
  const where = buildWhere(filters, "pr.source_ts", {
    factory_id: "e.factory_id",
    line_id: "e.line_id",
    equipment_id: "pr.equipment_id",
    product_id: "pr.product_id",
  });
  const actual = db
    .prepare(
      `SELECT COALESCE(SUM(pr.good_qty),0) as good, COALESCE(SUM(pr.defect_qty),0) as defect, COUNT(DISTINCT pr.lot_id) as lots
       FROM production_records pr JOIN equipment e ON e.id = pr.equipment_id WHERE ${where.clause} AND ${FINAL_STEP_CLAUSE}`
    )
    .get(...where.params) as { good: number; defect: number; lots: number };

  const orderWhere = buildWhere(filters, "o.due_date", { factory_id: "o.factory_id", product_id: "o.product_id" });
  const orderRows = db.prepare(`SELECT COUNT(*) as c FROM orders o WHERE ${orderWhere.clause}`).get() as { c: number };
  const planned = db
    .prepare(`SELECT COALESCE(SUM(o.quantity),0) as q FROM orders o WHERE ${orderWhere.clause}`)
    .get(...orderWhere.params) as { q: number };

  const asOfTs = filters.asOf ?? nowIso();
  const activeJobsWhere = buildWhere(filters, null, { factory_id: "e.factory_id", equipment_id: "es.equipment_id" });
  const activeJobs = db
    .prepare(
      `SELECT es.equipment_id, e.name as equipment_name, es.start_ts FROM equipment_states es
       JOIN equipment e ON e.id = es.equipment_id
       WHERE es.source_ts = (SELECT MAX(x.source_ts) FROM equipment_states x WHERE x.equipment_id = es.equipment_id AND x.source_ts <= ?)
         AND es.state = 'running' AND es.end_ts IS NULL AND ${activeJobsWhere.clause}`
    )
    .all(asOfTs, ...activeJobsWhere.params) as unknown as { equipment_id: string; equipment_name: string; start_ts: string }[];

  return {
    plannedOutputUnits: planned.q,
    plannedOutputBasis:
      orderRows.c > 0
        ? "sum of order quantities with due_date in the selected window (no separate production schedule was uploaded)"
        : "no orders in the selected window to derive a plan from",
    actualGoodUnits: actual.good,
    actualDefectUnits: actual.defect,
    lotsProduced: actual.lots,
    activeJobs: activeJobs.map((j) => ({ equipmentId: j.equipment_id, equipmentName: j.equipment_name, runningSince: j.start_ts })),
  };
}

// ---------------------------------------------------------------- Quality

function qualityPanel(filters: OverviewFilters) {
  const where = buildWhere(filters, "i.inspected_ts", { product_id: "i.product_id" });
  const totals = db
    .prepare(`SELECT COALESCE(SUM(defect_qty),0) as d, COALESCE(SUM(inspected_qty),0) as i FROM inspections i WHERE ${where.clause}`)
    .get(...where.params) as { d: number; i: number };
  const categories = db
    .prepare(
      `SELECT COALESCE(defect_category,'uncategorized') as category, SUM(defect_qty) as qty
       FROM inspections i WHERE ${where.clause} AND defect_qty > 0 GROUP BY category ORDER BY qty DESC LIMIT 10`
    )
    .all(...where.params) as { category: string; qty: number }[];

  return {
    defectRate: totals.i > 0 ? round(totals.d / totals.i) : null,
    defectRateAvailable: totals.i > 0,
    defectCategories: categories,
    atRiskLots: getAtRiskLots(filters),
  };
}

// ---------------------------------------------------------------- Equipment

function equipmentPanel(filters: OverviewFilters) {
  const asOf = filters.asOf ?? nowIso();
  const equipWhere = buildWhere(filters, null, { factory_id: "factory_id", line_id: "line_id" });
  const equipmentRows = db.prepare(`SELECT id, name, equipment_type FROM equipment WHERE ${equipWhere.clause}`).all(...equipWhere.params) as {
    id: string;
    name: string;
    equipment_type: string;
  }[];

  const counts: Record<"running" | "stopped" | "maintenance" | "unknown", number> = {
    running: 0,
    stopped: 0,
    maintenance: 0,
    unknown: 0,
  };
  const details: { equipmentId: string; name: string; state: string; asOf: string }[] = [];

  for (const eq of equipmentRows) {
    const latest = db
      .prepare(
        `SELECT state, end_ts FROM equipment_states WHERE equipment_id = ? AND source_ts <= ? ORDER BY source_ts DESC LIMIT 1`
      )
            .get(eq.id, asOf) as unknown as { state: string; end_ts: string | null } | undefined;
    // A state whose interval already ended before asOf, with nothing newer, is a data gap: report unknown rather than assuming it continues.
    const covered = latest && (latest.end_ts === null || latest.end_ts >= asOf);
    const state = (covered ? latest!.state : "unknown") as "running" | "stopped" | "maintenance" | "unknown";
    counts[state]++;
    details.push({ equipmentId: eq.id, name: eq.name, state, asOf });
  }

  return {
    counts,
    details,
    anomalies: getEquipmentAnomalies(filters.equipmentId),
  };
}

// ---------------------------------------------------------------- Supply chain

interface MaterialPosition {
  materialId: string;
  materialName: string;
  currentStock: number;
  projectedDemand: number;
  incomingBeforeNeed: number;
  shortageQty: number;
}

function supplyChainPanel(filters: OverviewFilters) {
  const asOf = filters.asOf ?? nowIso();
  const lookaheadEnd = daysFromNow(SHORTAGE_LOOKAHEAD_DAYS, new Date(asOf));

  const materials = db.prepare(`SELECT id, name FROM materials`).all() as { id: string; name: string }[];
  const positions: MaterialPosition[] = [];

  for (const mat of materials) {
    const stock = currentStock(mat.id, asOf);
    const demandRow = db
      .prepare(
        `SELECT COALESCE(SUM(b.qty_per_unit * o.quantity),0) as demand
         FROM orders o JOIN bom b ON b.product_id = o.product_id
         WHERE b.material_id = ? AND o.status = 'open' AND o.due_date <= ?`
      )
      .get(mat.id, lookaheadEnd) as { demand: number };
    const incomingRow = db
      .prepare(
        `SELECT COALESCE(SUM(expected_qty),0) as incoming FROM supplier_deliveries
         WHERE material_id = ? AND expected_date <= ? AND status != 'cancelled' AND actual_date IS NULL`
      )
      .get(mat.id, lookaheadEnd) as { incoming: number };

    const shortage = Math.max(0, demandRow.demand - stock - incomingRow.incoming);
    if (demandRow.demand > 0 || stock < 0) {
      positions.push({
        materialId: mat.id,
        materialName: mat.name,
        currentStock: stock,
        projectedDemand: demandRow.demand,
        incomingBeforeNeed: incomingRow.incoming,
        shortageQty: round(shortage),
      });
    }
  }

  const delayedReceipts = db
    .prepare(
      `SELECT sd.*, s.name as supplier_name, m.name as material_name FROM supplier_deliveries sd
       JOIN suppliers s ON s.id = sd.supplier_id JOIN materials m ON m.id = sd.material_id
       WHERE sd.actual_date IS NULL AND sd.expected_date < ? AND sd.status != 'cancelled'`
    )
    .all(asOf) as Record<string, unknown>[];

  const shortMaterialIds = positions.filter((p) => p.shortageQty > 0).map((p) => p.materialId);
  let affectedOrders: Record<string, unknown>[] = [];
  if (shortMaterialIds.length > 0) {
    const placeholders = shortMaterialIds.map(() => "?").join(",");
    affectedOrders = db
      .prepare(
        `SELECT DISTINCT o.id, o.product_id, o.quantity, o.due_date FROM orders o
         JOIN bom b ON b.product_id = o.product_id
         WHERE b.material_id IN (${placeholders}) AND o.status = 'open'`
      )
      .all(...shortMaterialIds) as Record<string, unknown>[];
  }

  return {
    materialShortages: positions.filter((p) => p.shortageQty > 0),
    delayedReceipts,
    affectedOrders,
    shortageLookaheadDays: SHORTAGE_LOOKAHEAD_DAYS,
  };
}

// ---------------------------------------------------------------- Delivery

function deliveryPanel(filters: OverviewFilters) {
  const asOf = filters.asOf ?? nowIso();
  const orderWhere = buildWhere({ ...filters, from: undefined, to: undefined }, null, {
    factory_id: "o.factory_id",
    product_id: "o.product_id",
  });
  const openOrders = db
    .prepare(`SELECT o.* FROM orders o WHERE o.status = 'open' AND ${orderWhere.clause}`)
    .all(...orderWhere.params) as { id: string; product_id: string; quantity: number; due_date: string; priority: number }[];

  const shortageMaterialIds = new Set(supplyChainPanel(filters).materialShortages.map((m) => m.materialId));
  const results = openOrders.map((o) => {
    const shipped = db
      .prepare(`SELECT COALESCE(SUM(shipped_qty),0) as q FROM shipments WHERE order_id = ?`)
      .get(o.id) as { q: number };
    const remaining = Math.max(0, o.quantity - shipped.q);

    const lookback = daysFromNow(-THROUGHPUT_LOOKBACK_DAYS, new Date(asOf));
    const throughput = db
      .prepare(
        `SELECT COALESCE(SUM(pr.good_qty),0) as good FROM production_records pr WHERE pr.product_id = ? AND pr.source_ts BETWEEN ? AND ? AND ${FINAL_STEP_CLAUSE}`
      )
      .get(o.product_id, lookback, asOf) as { good: number };
    const dailyRate = throughput.good / THROUGHPUT_LOOKBACK_DAYS;

    const usesShortMaterial = db
      .prepare(`SELECT 1 FROM bom WHERE product_id = ? AND material_id IN (${Array.from(shortageMaterialIds).map(() => "?").join(",") || "NULL"})`)
      .get(o.product_id, ...Array.from(shortageMaterialIds)) as unknown;

    let projectedShipDate: string | null = null;
    let reason = "";
    if (remaining <= 0) {
      projectedShipDate = asOf;
      reason = "already fully produced/shipped";
    } else if (dailyRate > 0) {
      const days = remaining / dailyRate;
      projectedShipDate = daysFromNow(days, new Date(asOf));
      reason = `estimated from trailing ${THROUGHPUT_LOOKBACK_DAYS}-day production rate for this product`;
    } else {
      reason = "no recent production throughput data for this product to project a completion date";
    }

    const atRisk = Boolean(usesShortMaterial) || (projectedShipDate !== null && projectedShipDate > o.due_date);

    return {
      orderId: o.id,
      productId: o.product_id,
      dueDate: o.due_date,
      priority: o.priority,
      remainingQty: remaining,
      projectedShipDate,
      projectedBasis: reason,
      atRisk,
      atRiskDueToMaterialShortage: Boolean(usesShortMaterial),
    };
  });

  return {
    openOrderCount: openOrders.length,
    atRiskOrders: results.filter((r) => r.atRisk),
    allOrders: results,
  };
}

// ---------------------------------------------------------------- Costs

function costsPanel(filters: OverviewFilters) {
  return calculateOperatingCost(filters);
}

// ---------------------------------------------------------------- Relationships (summary)

function relationshipsPanel(filters: OverviewFilters) {
  const where = buildWhere(filters, "pr.source_ts", {
    factory_id: "e.factory_id",
    equipment_id: "pr.equipment_id",
    product_id: "pr.product_id",
  });
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT pr.order_id) as orders, COUNT(DISTINCT pr.equipment_id) as equipment, COUNT(DISTINCT pr.lot_id) as lots
       FROM production_records pr JOIN equipment e ON e.id = pr.equipment_id WHERE ${where.clause}`
    )
    .get(...where.params) as { orders: number; equipment: number; lots: number };
  const inspCount = db.prepare(`SELECT COUNT(*) as c FROM inspections`).get() as { c: number };
  const shipCount = db.prepare(`SELECT COUNT(*) as c FROM shipments`).get() as { c: number };
  const materialCount = db.prepare(`SELECT COUNT(DISTINCT material_id) as c FROM bom`).get() as { c: number };

  return {
    ordersInvolved: row.orders,
    equipmentInvolved: row.equipment,
    lotsInvolved: row.lots,
    materialsInvolved: materialCount.c,
    inspectionsTotal: inspCount.c,
    shipmentsTotal: shipCount.c,
    note: "Use the order detail view to trace one order end-to-end through materials, production, inspections, equipment, and shipment.",
  };
}

// ---------------------------------------------------------------- Aggregate

export function getOverview(filters: OverviewFilters) {
  return {
    mode: filters.asOf ? "replay" : "live",
    asOf: filters.asOf ?? nowIso(),
    filters,
    kpis: computeAllKpis(filters),
    production: productionPanel(filters),
    quality: qualityPanel(filters),
    equipment: equipmentPanel(filters),
    supplyChain: supplyChainPanel(filters),
    delivery: deliveryPanel(filters),
    costs: costsPanel(filters),
    relationships: relationshipsPanel(filters),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
