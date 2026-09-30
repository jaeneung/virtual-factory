import { mulberry32 } from "../util/rng.js";
import { runSchedule, ScheduleResult, VirtualOrder } from "./engine.js";
import { buildFactorySnapshot, FactorySnapshot } from "./snapshot.js";
import { buildScenario, ScenarioType } from "./scenarios.js";
import { ALL_RESPONSE_OPTIONS } from "./responseOptions.js";
import { SimulationRunRow } from "./simRepo.js";
import { db } from "../db/client.js";

/** Rebuilds the snapshot used to evaluate a run's response options. Equipment/route/BOM/
 *  material-position data is re-derived from the DB as of the run's snapshot_ts (stable
 *  because file-upload ingestion never rewrites history); the order list is taken from the
 *  run's own frozen sim_orders so every option is compared against identical orders even if
 *  live orders have since changed. */
export function buildSnapshotForRun(run: SimulationRunRow): FactorySnapshot {
  const base = buildFactorySnapshot(new Date(run.snapshot_ts));
  const frozenOrders = db.prepare(`SELECT order_id, product_id, quantity, due_date, priority FROM sim_orders WHERE run_id = ?`).all(run.id) as {
    order_id: string;
    product_id: string;
    quantity: number;
    due_date: string;
    priority: number;
  }[];
  const orders: VirtualOrder[] = frozenOrders.map((o) => ({
    orderId: o.order_id,
    productId: o.product_id,
    quantity: o.quantity,
    dueDate: new Date(o.due_date),
    priority: o.priority,
  }));
  return { ...base, orders };
}

export function evaluateOption(run: SimulationRunRow, optionType: string): ScheduleResult {
  const snapshot = buildSnapshotForRun(run);
  const scenario = buildScenario(run.scenario as ScenarioType, snapshot, run.id, mulberry32(run.seed));
  const option = ALL_RESPONSE_OPTIONS.find((o) => o.type === optionType);
  if (!option) throw new Error(`unknown response option: ${optionType}`);
  return runSchedule({ ...snapshot, scenario, option, costConfig: snapshot.costConfig });
}

export function evaluateAllOptions(run: SimulationRunRow): Record<string, ScheduleResult> {
  const out: Record<string, ScheduleResult> = {};
  for (const opt of ALL_RESPONSE_OPTIONS) {
    out[opt.type] = evaluateOption(run, opt.type);
  }
  return out;
}
