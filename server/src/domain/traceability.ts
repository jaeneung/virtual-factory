import { db } from "../db/client.js";

export function getOrderTrace(orderId: string) {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
  if (!order) return null;

  const bom = db
    .prepare(
      `SELECT b.material_id, m.name as material_name, b.qty_per_unit, m.unit_cost
       FROM bom b JOIN materials m ON m.id = b.material_id
       JOIN orders o ON o.product_id = b.product_id WHERE o.id = ?`
    )
    .all(orderId);

  const production = db
    .prepare(
      `SELECT pr.*, e.name as equipment_name FROM production_records pr
       JOIN equipment e ON e.id = pr.equipment_id WHERE pr.order_id = ? ORDER BY pr.start_ts`
    )
    .all(orderId);

  const lotIds = (production as { lot_id: string }[]).map((p) => p.lot_id);
  const inspections =
    lotIds.length > 0
      ? db
          .prepare(
            `SELECT * FROM inspections WHERE order_id = ? OR lot_id IN (${lotIds.map(() => "?").join(",")}) ORDER BY inspected_ts`
          )
          .all(orderId, ...lotIds)
      : db.prepare(`SELECT * FROM inspections WHERE order_id = ? ORDER BY inspected_ts`).all(orderId);

  const equipmentIds = Array.from(new Set((production as { equipment_id: string }[]).map((p) => p.equipment_id)));
  const equipment =
    equipmentIds.length > 0
      ? db.prepare(`SELECT * FROM equipment WHERE id IN (${equipmentIds.map(() => "?").join(",")})`).all(...equipmentIds)
      : [];

  const shipments = db.prepare(`SELECT * FROM shipments WHERE order_id = ? ORDER BY ship_ts`).all(orderId);

  return { order, materials: bom, production, inspections, equipment, shipments };
}
