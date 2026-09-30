import { db } from "../db/client.js";

export interface IntegrityIssue {
  check: string;
  severity: "error" | "warning";
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Read-only data-integrity report over source data. It detects (does not repair):
 * - negative inventory at any point in a material's stock ledger,
 * - overlapping production records on the same machine,
 * - shipped quantity exceeding what was produced (final step) for an order,
 * - inspected quantity exceeding what was produced in a lot's step.
 */
export function checkIntegrity(): { ok: boolean; issues: IntegrityIssue[] } {
  const issues: IntegrityIssue[] = [];

  const movements = db
    .prepare(`SELECT material_id, movement_type, qty, movement_ts, id FROM stock_movements ORDER BY material_id, movement_ts, id`)
    .all() as unknown as { material_id: string; movement_type: string; qty: number; movement_ts: string; id: string }[];
  const balance = new Map<string, number>();
  const reported = new Set<string>();
  for (const m of movements) {
    const next = (balance.get(m.material_id) ?? 0) + (m.movement_type === "consumption" ? -m.qty : m.qty);
    balance.set(m.material_id, next);
    if (next < -1e-9 && !reported.has(m.material_id)) {
      reported.add(m.material_id);
      issues.push({ check: "negative_inventory", severity: "error", message: `Stock for ${m.material_id} goes negative (${next.toFixed(2)}) at ${m.movement_ts}`, context: { movementId: m.id } });
    }
  }

  const prod = db
    .prepare(`SELECT id, equipment_id, start_ts, end_ts FROM production_records ORDER BY equipment_id, start_ts`)
    .all() as unknown as { id: string; equipment_id: string; start_ts: string; end_ts: string }[];
  let prev: (typeof prod)[number] | null = null;
  for (const r of prod) {
    if (prev && prev.equipment_id === r.equipment_id && r.start_ts < prev.end_ts) {
      issues.push({ check: "machine_overlap", severity: "error", message: `Production records ${prev.id} and ${r.id} overlap on ${r.equipment_id}`, context: { a: prev.id, b: r.id } });
    }
    prev = r;
  }

  const shipped = db
    .prepare(
      `SELECT s.order_id, SUM(s.shipped_qty) as shipped FROM shipments s GROUP BY s.order_id`
    )
    .all() as unknown as { order_id: string; shipped: number }[];
  for (const s of shipped) {
    const produced = db
      .prepare(
        `SELECT COALESCE(SUM(pr.good_qty),0) as good FROM production_records pr
         WHERE pr.order_id = ? AND pr.step_no = COALESCE((SELECT MAX(r.step_no) FROM process_routes r WHERE r.product_id = pr.product_id), pr.step_no)`
      )
      .get(s.order_id) as unknown as { good: number };
    if (s.shipped > produced.good + 1e-9) {
      issues.push({
        check: "shipped_exceeds_produced",
        severity: "warning",
        message: `Order ${s.order_id}: shipped ${s.shipped} > good units produced ${produced.good} in the records provided (production for earlier periods may be missing)`,
        context: { orderId: s.order_id },
      });
    }
  }

  const lots = db
    .prepare(
      `SELECT i.lot_id, SUM(i.inspected_qty) as inspected,
              (SELECT COALESCE(SUM(pr.good_qty + pr.defect_qty),0) FROM production_records pr WHERE pr.lot_id = i.lot_id) as produced
       FROM inspections i GROUP BY i.lot_id`
    )
    .all() as unknown as { lot_id: string; inspected: number; produced: number }[];
  for (const l of lots) {
    if (l.produced > 0 && l.inspected > l.produced + 1e-9) {
      issues.push({ check: "inspected_exceeds_produced", severity: "error", message: `Lot ${l.lot_id}: inspected ${l.inspected} > produced ${l.produced}`, context: { lotId: l.lot_id } });
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues };
}
