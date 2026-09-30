import { db, withTransaction } from "../db/client.js";
import { newId } from "../util/id.js";
import { nowIso } from "../util/time.js";
import { ScheduleResult, VirtualOrder } from "./engine.js";

export interface SimulationRunRow {
  id: string;
  name: string;
  scenario: string;
  seed: number;
  snapshot_ts: string;
  status: string;
  created_at: string;
}

export function createRun(name: string, scenario: string, seed: number, snapshotTs: Date, orders: VirtualOrder[], presetId?: string): SimulationRunRow {
  const id = presetId ?? newId("run");
  const now = nowIso();
  withTransaction(() => {
    db.prepare(`INSERT INTO simulation_runs (id, name, scenario, seed, snapshot_ts, status, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?)`).run(
      id,
      name,
      scenario,
      seed,
      snapshotTs.toISOString(),
      now
    );
    for (const o of orders) {
      db.prepare(
        `INSERT INTO sim_orders (run_id, order_id, product_id, quantity, due_date, priority, planned_ship_date, status)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'open')`
      ).run(id, o.orderId, o.productId, o.quantity, o.dueDate.toISOString(), o.priority);
    }
  });
  return getRun(id)!;
}

export function getRun(id: string): SimulationRunRow | null {
  return (db.prepare(`SELECT * FROM simulation_runs WHERE id = ?`).get(id) as unknown as SimulationRunRow) ?? null;
}

export function listRuns(): SimulationRunRow[] {
  return db.prepare(`SELECT * FROM simulation_runs ORDER BY created_at DESC`).all() as unknown as SimulationRunRow[];
}

/** Replaces the run's persisted "current virtual plan" (sim_jobs/sim_inventory_events/
 *  sim_shipments) with the result of applying `optionType`. This is the only place that
 *  mutates the plan tables — original source tables and other runs are untouched. */
export function applyPlanToRun(runId: string, optionType: string, result: ScheduleResult): void {
  withTransaction(() => {
    db.prepare(`DELETE FROM sim_jobs WHERE run_id = ?`).run(runId);
    db.prepare(`DELETE FROM sim_inventory_events WHERE run_id = ?`).run(runId);
    db.prepare(`DELETE FROM sim_shipments WHERE run_id = ?`).run(runId);

    for (const j of result.jobs) {
      db.prepare(
        `INSERT INTO sim_jobs (id, run_id, order_id, step_no, equipment_id, planned_start, planned_end, qty, good_qty, defect_qty, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`
      ).run(newId("job"), runId, j.orderId, j.stepNo, j.equipmentId, j.plannedStart.toISOString(), j.plannedEnd.toISOString(), j.qty, j.goodQty, j.defectQty);
    }
    for (const e of result.inventoryEvents) {
      db.prepare(`INSERT INTO sim_inventory_events (id, run_id, material_id, qty_delta, ts, reason) VALUES (?, ?, ?, ?, ?, ?)`).run(
        newId("simv"),
        runId,
        e.materialId,
        e.qtyDelta,
        e.ts.toISOString(),
        e.reason
      );
    }
    for (const s of result.shipments) {
      db.prepare(`INSERT INTO sim_shipments (id, run_id, order_id, shipped_qty, ship_ts) VALUES (?, ?, ?, ?, ?)`).run(
        newId("simship"),
        runId,
        s.orderId,
        s.shippedQty,
        s.shipTs.toISOString()
      );
      db.prepare(`UPDATE sim_orders SET planned_ship_date = ?, status = 'shipped' WHERE run_id = ? AND order_id = ?`).run(
        s.shipTs.toISOString(),
        runId,
        s.orderId
      );
    }
    db.prepare(`UPDATE simulation_runs SET status = 'complete' WHERE id = ?`).run(runId);
  });
}

export function recordOptionHistory(runId: string, optionType: string, params: unknown): { ok: true } | { ok: false; reason: string } {
  const existing = db.prepare(`SELECT 1 FROM sim_option_history WHERE run_id = ? AND option_type = ?`).get(runId, optionType);
  if (existing) return { ok: false, reason: `option "${optionType}" was already applied to this run` };
  db.prepare(`INSERT INTO sim_option_history (id, run_id, option_type, params_json, applied_at) VALUES (?, ?, ?, ?, ?)`).run(
    newId("hist"),
    runId,
    optionType,
    JSON.stringify(params ?? {}),
    nowIso()
  );
  return { ok: true };
}

export function getOptionHistory(runId: string): unknown[] {
  return db.prepare(`SELECT * FROM sim_option_history WHERE run_id = ? ORDER BY applied_at`).all(runId);
}

export function saveResult(runId: string, optionType: string, result: ScheduleResult): void {
  db.prepare(
    `INSERT INTO sim_results (id, run_id, option_type, kpis_json, feasibility, binding_constraints_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, option_type) DO UPDATE SET kpis_json = excluded.kpis_json, feasibility = excluded.feasibility, binding_constraints_json = excluded.binding_constraints_json`
  ).run(newId("res"), runId, optionType, JSON.stringify({ kpis: result.kpis, orderOutcomes: result.orderOutcomes }), result.feasibility, JSON.stringify(result.bindingConstraints), nowIso());
}

export function getResults(runId: string): { option_type: string; kpis_json: string; feasibility: string; binding_constraints_json: string }[] {
  return db.prepare(`SELECT * FROM sim_results WHERE run_id = ?`).all(runId) as {
    option_type: string;
    kpis_json: string;
    feasibility: string;
    binding_constraints_json: string;
  }[];
}

export function getCurrentPlan(runId: string) {
  const jobs = db.prepare(`SELECT * FROM sim_jobs WHERE run_id = ? ORDER BY planned_start`).all(runId);
  const shipments = db.prepare(`SELECT * FROM sim_shipments WHERE run_id = ? ORDER BY ship_ts`).all(runId);
  const orders = db.prepare(`SELECT * FROM sim_orders WHERE run_id = ?`).all(runId);
  const appliedOptions = getOptionHistory(runId);
  return { jobs, shipments, orders, appliedOptions };
}
