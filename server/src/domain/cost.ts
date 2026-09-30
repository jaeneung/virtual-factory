import { db } from "../db/client.js";
import { OverviewFilters, buildWhere, FIRST_STEP_CLAUSE } from "./filters.js";

export interface CostBreakdown {
  machineCost: number;
  laborCost: number;
  materialCost: number;
  totalCost: number;
  excluded: { reason: string; context: string }[];
}

function getCostConfig(): Record<string, number> {
  const rows = db.prepare(`SELECT key, value FROM cost_config`).all() as { key: string; value: number }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * Calculable operating cost = machine run cost (duration * equipment.rate_per_hour_cost)
 * + labor cost (duration * labor_rate_per_hour, one operator assumed per running job)
 * + material cost (units produced * BOM qty_per_unit * material.unit_cost).
 * See docs/ASSUMPTIONS.md. Equipment/materials missing a configured rate are excluded and
 * listed, never silently treated as zero-cost or blocking the whole calculation.
 */
export function calculateOperatingCost(filters: OverviewFilters): CostBreakdown {
  const cfg = getCostConfig();
  const where = buildWhere(filters, "pr.source_ts", {
    factory_id: "e.factory_id",
    line_id: "e.line_id",
    equipment_id: "pr.equipment_id",
    product_id: "pr.product_id",
  });

  const rows = db
    .prepare(
      `SELECT pr.id, pr.equipment_id, pr.product_id, pr.good_qty, pr.defect_qty, pr.start_ts, pr.end_ts,
              e.rate_per_hour_cost, e.name as equipment_name
       FROM production_records pr
       JOIN equipment e ON e.id = pr.equipment_id
       WHERE ${where.clause}`
    )
    .all(...where.params) as {
    id: string;
    equipment_id: string;
    product_id: string;
    good_qty: number;
    defect_qty: number;
    start_ts: string;
    end_ts: string;
    rate_per_hour_cost: number | null;
    equipment_name: string;
  }[];

  let machineCost = 0;
  let laborCost = 0;
  const excluded: { reason: string; context: string }[] = [];
  const missingRateEquipment = new Set<string>();

  for (const r of rows) {
    const hours = (new Date(r.end_ts).getTime() - new Date(r.start_ts).getTime()) / 3_600_000;
    if (r.rate_per_hour_cost == null) {
      missingRateEquipment.add(r.equipment_name);
    } else {
      machineCost += hours * r.rate_per_hour_cost;
    }
    laborCost += hours * cfg.labor_rate_per_hour;
  }
  for (const name of missingRateEquipment) {
    excluded.push({ reason: "no rate_per_hour_cost configured for this equipment", context: name });
  }

  // Material cost: qty produced (good+defect, since material is consumed regardless of outcome) x BOM x unit cost.
  const materialRows = db
    .prepare(
      `SELECT pr.product_id, SUM(pr.good_qty + pr.defect_qty) as total_qty
       FROM production_records pr
       JOIN equipment e ON e.id = pr.equipment_id
       WHERE ${where.clause} AND ${FIRST_STEP_CLAUSE}
       GROUP BY pr.product_id`
    )
    .all(...where.params) as { product_id: string; total_qty: number }[];

  let materialCost = 0;
  const missingMaterialCost = new Set<string>();
  for (const mr of materialRows) {
    const bomRows = db
      .prepare(
        `SELECT b.qty_per_unit, m.unit_cost, m.name FROM bom b JOIN materials m ON m.id = b.material_id WHERE b.product_id = ?`
      )
      .all(mr.product_id) as { qty_per_unit: number; unit_cost: number | null; name: string }[];
    if (bomRows.length === 0) {
      excluded.push({ reason: "no BOM defined for this product", context: mr.product_id });
      continue;
    }
    for (const b of bomRows) {
      if (b.unit_cost == null) {
        missingMaterialCost.add(b.name);
        continue;
      }
      materialCost += mr.total_qty * b.qty_per_unit * b.unit_cost;
    }
  }
  for (const name of missingMaterialCost) {
    excluded.push({ reason: "no unit_cost configured for this material", context: name });
  }

  return {
    machineCost: round2(machineCost),
    laborCost: round2(laborCost),
    materialCost: round2(materialCost),
    totalCost: round2(machineCost + laborCost + materialCost),
    excluded,
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function getCostConfigValue(key: string): number {
  const row = db.prepare(`SELECT value FROM cost_config WHERE key = ?`).get(key) as { value: number } | undefined;
  if (!row) throw new Error(`Missing cost_config key: ${key}`);
  return row.value;
}
