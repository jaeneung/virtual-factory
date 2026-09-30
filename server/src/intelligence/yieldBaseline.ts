import { db } from "../db/client.js";
import { OverviewFilters, buildWhere } from "../domain/filters.js";

/**
 * RULE-BASED BASELINE, not a trained model. Flags a lot "at risk" when its observed
 * inspection defect rate is materially worse than the product's overall historical defect
 * rate. This is a simple heuristic threshold, useful as a first-pass signal, not a
 * statistically validated quality-prediction model.
 */
export interface LotRisk {
  lotId: string;
  productId: string;
  inspectedQty: number;
  defectQty: number;
  defectRate: number;
  productBaselineDefectRate: number;
  riskLevel: "normal" | "at_risk";
}

const AT_RISK_RELATIVE_MULTIPLIER = 1.5;
const AT_RISK_ABSOLUTE_FLOOR = 0.05;

export function getAtRiskLots(filters: OverviewFilters): LotRisk[] {
  const baselineByProduct = new Map<string, number>();
  const baselineRows = db
    .prepare(
      `SELECT product_id, SUM(defect_qty) as d, SUM(inspected_qty) as i FROM inspections GROUP BY product_id`
    )
    .all() as { product_id: string; d: number; i: number }[];
  for (const r of baselineRows) {
    baselineByProduct.set(r.product_id, r.i > 0 ? r.d / r.i : 0);
  }

  const where = buildWhere(filters, "i.inspected_ts", { product_id: "i.product_id" });
  const lotRows = db
    .prepare(
      `SELECT lot_id, product_id, SUM(inspected_qty) as inspected, SUM(defect_qty) as defects
       FROM inspections i WHERE ${where.clause} GROUP BY lot_id, product_id`
    )
    .all(...where.params) as { lot_id: string; product_id: string; inspected: number; defects: number }[];

  return lotRows
    .map((r) => {
      const rate = r.inspected > 0 ? r.defects / r.inspected : 0;
      const baseline = baselineByProduct.get(r.product_id) ?? 0;
      const threshold = Math.max(baseline * AT_RISK_RELATIVE_MULTIPLIER, AT_RISK_ABSOLUTE_FLOOR);
      return {
        lotId: r.lot_id,
        productId: r.product_id,
        inspectedQty: r.inspected,
        defectQty: r.defects,
        defectRate: round(rate),
        productBaselineDefectRate: round(baseline),
        riskLevel: (rate > threshold ? "at_risk" : "normal") as "normal" | "at_risk",
      };
    })
    .filter((r) => r.riskLevel === "at_risk")
    .sort((a, b) => b.defectRate - a.defectRate);
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
