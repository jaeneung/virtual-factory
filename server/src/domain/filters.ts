export interface OverviewFilters {
  factoryId?: string;
  lineId?: string;
  equipmentId?: string;
  productId?: string;
  from?: string;
  to?: string;
  /** Upper time bound imposed by REPLAY mode's playback cursor. Never set in LIVE mode. */
  asOf?: string;
}

export interface WhereClause {
  clause: string;
  params: (string | number)[];
}

/** Builds a `WHERE ... ` fragment (without the WHERE keyword) for a timestamp column plus optional dimension columns. */
export function buildWhere(
  filters: OverviewFilters,
  tsColumn: string | null,
  dims: Partial<Record<"factory_id" | "line_id" | "equipment_id" | "product_id", string>>
): WhereClause {
  const conds: string[] = [];
  const params: (string | number)[] = [];

  if (tsColumn) {
    if (filters.from) {
      conds.push(`${tsColumn} >= ?`);
      params.push(filters.from);
    }
    const upperBound = filters.asOf && (!filters.to || filters.to > filters.asOf) ? filters.asOf : filters.to;
    if (upperBound) {
      conds.push(`${tsColumn} <= ?`);
      params.push(upperBound);
    }
  }

  if (filters.factoryId && dims.factory_id) {
    conds.push(`${dims.factory_id} = ?`);
    params.push(filters.factoryId);
  }
  if (filters.lineId && dims.line_id) {
    conds.push(`${dims.line_id} = ?`);
    params.push(filters.lineId);
  }
  if (filters.equipmentId && dims.equipment_id) {
    conds.push(`${dims.equipment_id} = ?`);
    params.push(filters.equipmentId);
  }
  if (filters.productId && dims.product_id) {
    conds.push(`${dims.product_id} = ?`);
    params.push(filters.productId);
  }

  return { clause: conds.length ? conds.join(" AND ") : "1=1", params };
}

/** Restricts production_records (aliased `pr`) to the product's final route step, so finished-good output is not double-counted across intermediate steps. Products without a route fall back to counting every record. */
export const FINAL_STEP_CLAUSE = `pr.step_no = COALESCE((SELECT MAX(r.step_no) FROM process_routes r WHERE r.product_id = pr.product_id), pr.step_no)`;

/** Restricts to the first route step, where BOM material is consumed. */
export const FIRST_STEP_CLAUSE = `pr.step_no = COALESCE((SELECT MIN(r.step_no) FROM process_routes r WHERE r.product_id = pr.product_id), pr.step_no)`;
