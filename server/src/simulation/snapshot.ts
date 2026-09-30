import { db } from "../db/client.js";
import { currentStock } from "../domain/inventory.js";
import { getCostConfigValue } from "../domain/cost.js";
import { RouteStep, BomLine, EquipmentDef, VirtualOrder } from "./engine.js";

/** Deliveries already past their expected date but not yet received have an unknown arrival. The simulation makes this explicit assumption: they arrive this many days after the snapshot (documented in docs/ASSUMPTIONS.md). */
export const OVERDUE_DELIVERY_ASSUMED_DAYS = 2;

export interface FactorySnapshot {
  snapshotTs: Date;
  orders: VirtualOrder[];
  routesByProduct: Map<string, RouteStep[]>;
  bomByProduct: Map<string, BomLine[]>;
  equipmentList: EquipmentDef[];
  materialOpeningStock: Map<string, number>;
  materialDeliveries: Map<string, { ts: Date; qty: number }[]>;
  costConfig: { laborRatePerHour: number; overtimeMultiplier: number };
}

/** Reads the current LIVE state as of `snapshotTs` to seed a simulation run. Nothing here
 *  mutates source tables — it's a read-only snapshot copied into the simulation's own
 *  in-memory/sim_* representation. */
export function buildFactorySnapshot(snapshotTs: Date): FactorySnapshot {
  const asOf = snapshotTs.toISOString();

  const orderRows = db.prepare(`SELECT id, product_id, quantity, due_date, priority FROM orders WHERE status = 'open'`).all() as {
    id: string;
    product_id: string;
    quantity: number;
    due_date: string;
    priority: number;
  }[];
  const orders: VirtualOrder[] = orderRows.map((o) => ({
    orderId: o.id,
    productId: o.product_id,
    quantity: o.quantity,
    dueDate: new Date(o.due_date),
    priority: o.priority,
  }));

  const routeRows = db
    .prepare(`SELECT product_id, step_no, equipment_type, standard_cycle_time_sec, expected_yield_pct FROM process_routes`)
    .all() as { product_id: string; step_no: number; equipment_type: string; standard_cycle_time_sec: number; expected_yield_pct: number | null }[];
  const routesByProduct = new Map<string, RouteStep[]>();
  for (const r of routeRows) {
    const list = routesByProduct.get(r.product_id) ?? [];
    list.push({ stepNo: r.step_no, equipmentType: r.equipment_type, cycleTimeSec: r.standard_cycle_time_sec, expectedYieldPct: r.expected_yield_pct });
    routesByProduct.set(r.product_id, list);
  }

  const bomRows = db
    .prepare(`SELECT b.product_id, b.material_id, b.qty_per_unit, m.unit_cost FROM bom b JOIN materials m ON m.id = b.material_id`)
    .all() as { product_id: string; material_id: string; qty_per_unit: number; unit_cost: number | null }[];
  const bomByProduct = new Map<string, BomLine[]>();
  for (const b of bomRows) {
    const list = bomByProduct.get(b.product_id) ?? [];
    list.push({ materialId: b.material_id, qtyPerUnit: b.qty_per_unit, unitCost: b.unit_cost });
    bomByProduct.set(b.product_id, list);
  }

  const equipmentRows = db.prepare(`SELECT id, name, equipment_type, rate_per_hour_cost, available_hours_per_day FROM equipment`).all() as {
    id: string;
    name: string;
    equipment_type: string;
    rate_per_hour_cost: number | null;
    available_hours_per_day: number;
  }[];
  const equipmentList: EquipmentDef[] = equipmentRows.map((e) => ({
    id: e.id,
    name: e.name,
    equipmentType: e.equipment_type,
    ratePerHourCost: e.rate_per_hour_cost,
    availableHoursPerDay: e.available_hours_per_day,
  }));

  const materialIds = db.prepare(`SELECT id FROM materials`).all() as { id: string }[];
  const materialOpeningStock = new Map<string, number>();
  const materialDeliveries = new Map<string, { ts: Date; qty: number }[]>();
  for (const m of materialIds) {
    materialOpeningStock.set(m.id, currentStock(m.id, asOf));
    const deliveries = db
      .prepare(
        `SELECT expected_qty, expected_date FROM supplier_deliveries
         WHERE material_id = ? AND actual_date IS NULL AND status != 'cancelled'`
      )
      .all(m.id) as unknown as { expected_qty: number; expected_date: string }[];
    materialDeliveries.set(
      m.id,
      deliveries.map((d) => ({
        ts: d.expected_date > asOf ? new Date(d.expected_date) : new Date(snapshotTs.getTime() + OVERDUE_DELIVERY_ASSUMED_DAYS * 86_400_000),
        qty: d.expected_qty,
      }))
    );
  }

  return {
    snapshotTs,
    orders,
    routesByProduct,
    bomByProduct,
    equipmentList,
    materialOpeningStock,
    materialDeliveries,
    costConfig: {
      laborRatePerHour: getCostConfigValue("labor_rate_per_hour"),
      overtimeMultiplier: getCostConfigValue("overtime_multiplier"),
    },
  };
}
