import { db } from "../db/client.js";

/** Current on-hand stock for a material as of `asOf`, from the stock_movements ledger. */
export function currentStock(materialId: string, asOf: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE movement_type WHEN 'consumption' THEN -qty ELSE qty END),0) as stock
       FROM stock_movements WHERE material_id = ? AND movement_ts <= ?`
    )
    .get(materialId, asOf) as { stock: number };
  return row.stock;
}
