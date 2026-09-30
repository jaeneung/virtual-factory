export type FieldType = "string" | "number" | "date" | "enum" | "boolean";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  enumValues?: string[];
  refTable?: string;
  refColumn?: string;
  unit?: string;
  defaultValue?: string | number | boolean;
}

export type KeyPolicy = "upsert" | "insert-if-new";

export interface CategoryDef {
  key: string;
  label: string;
  table: string;
  fields: FieldDef[];
  naturalKey: string[];
  keyPolicy: KeyPolicy;
  description: string;
  /** For event-like categories: which field's value is copied into the table's source_ts column. */
  deriveSourceTsFrom?: string;
}

const REF = (table: string, column = "id") => ({ refTable: table, refColumn: column });

export const CATEGORIES: Record<string, CategoryDef> = {
  factories: {
    key: "factories",
    label: "Factories",
    table: "factories",
    naturalKey: ["id"],
    keyPolicy: "upsert",
    description: "Physical factory sites.",
    fields: [
      { key: "id", label: "Factory ID", type: "string", required: true },
      { key: "name", label: "Name", type: "string", required: true },
      { key: "timezone", label: "IANA timezone", type: "string", required: false, defaultValue: "UTC" },
    ],
  },
  lines: {
    key: "lines",
    label: "Production Lines",
    table: "lines",
    naturalKey: ["id"],
    keyPolicy: "upsert",
    description: "Production lines within a factory.",
    fields: [
      { key: "id", label: "Line ID", type: "string", required: true },
      { key: "factory_id", label: "Factory ID", type: "string", required: true, ...REF("factories") },
      { key: "name", label: "Name", type: "string", required: true },
    ],
  },
  equipment: {
    key: "equipment",
    label: "Equipment",
    table: "equipment",
    naturalKey: ["id"],
    keyPolicy: "upsert",
    description: "Machines/equipment and their capabilities.",
    fields: [
      { key: "id", label: "Equipment ID", type: "string", required: true },
      { key: "factory_id", label: "Factory ID", type: "string", required: true, ...REF("factories") },
      { key: "line_id", label: "Line ID", type: "string", required: false, ...REF("lines") },
      { key: "name", label: "Name", type: "string", required: true },
      { key: "equipment_type", label: "Equipment type / capability", type: "string", required: true },
      { key: "nominal_cycle_time_sec", label: "Nominal cycle time", type: "number", required: false, unit: "seconds" },
      { key: "rate_per_hour_cost", label: "Operating cost rate", type: "number", required: false, unit: "USD/hour" },
      { key: "available_hours_per_day", label: "Available hours/day", type: "number", required: false, unit: "hours", defaultValue: 16 },
    ],
  },
  products: {
    key: "products",
    label: "Products",
    table: "products",
    naturalKey: ["id"],
    keyPolicy: "upsert",
    description: "Finished products / parts.",
    fields: [
      { key: "id", label: "Product ID", type: "string", required: true },
      { key: "name", label: "Name", type: "string", required: true },
      { key: "sku", label: "SKU", type: "string", required: false },
      { key: "unit", label: "Unit of measure", type: "string", required: false, defaultValue: "ea" },
    ],
  },
  process_routes: {
    key: "process_routes",
    label: "Process Routes",
    table: "process_routes",
    naturalKey: ["product_id", "step_no"],
    keyPolicy: "upsert",
    description: "Ordered process steps a product goes through, and the equipment capability each step needs.",
    fields: [
      { key: "id", label: "Route step ID", type: "string", required: true },
      { key: "product_id", label: "Product ID", type: "string", required: true, ...REF("products") },
      { key: "step_no", label: "Step number", type: "number", required: true },
      { key: "step_name", label: "Step name", type: "string", required: true },
      { key: "equipment_type", label: "Required equipment type", type: "string", required: true },
      { key: "standard_cycle_time_sec", label: "Standard cycle time", type: "number", required: true, unit: "seconds" },
      { key: "expected_yield_pct", label: "Expected yield", type: "number", required: false, unit: "%" },
    ],
  },
  materials: {
    key: "materials",
    label: "Materials",
    table: "materials",
    naturalKey: ["id"],
    keyPolicy: "upsert",
    description: "Raw materials / components used in BOMs.",
    fields: [
      { key: "id", label: "Material ID", type: "string", required: true },
      { key: "name", label: "Name", type: "string", required: true },
      { key: "unit", label: "Unit of measure", type: "string", required: false, defaultValue: "ea" },
      { key: "unit_cost", label: "Unit cost", type: "number", required: false, unit: "USD/unit" },
    ],
  },
  bom: {
    key: "bom",
    label: "Bill of Materials",
    table: "bom",
    naturalKey: ["product_id", "material_id"],
    keyPolicy: "upsert",
    description: "Materials consumed per unit of product.",
    fields: [
      { key: "id", label: "BOM line ID", type: "string", required: true },
      { key: "product_id", label: "Product ID", type: "string", required: true, ...REF("products") },
      { key: "material_id", label: "Material ID", type: "string", required: true, ...REF("materials") },
      { key: "qty_per_unit", label: "Qty per unit", type: "number", required: true },
    ],
  },
  suppliers: {
    key: "suppliers",
    label: "Suppliers",
    table: "suppliers",
    naturalKey: ["id"],
    keyPolicy: "upsert",
    description: "Material suppliers.",
    fields: [
      { key: "id", label: "Supplier ID", type: "string", required: true },
      { key: "name", label: "Name", type: "string", required: true },
      { key: "default_lead_time_days", label: "Default lead time", type: "number", required: false, unit: "days" },
    ],
  },
  orders: {
    key: "orders",
    label: "Orders",
    table: "orders",
    naturalKey: ["id"],
    keyPolicy: "upsert",
    description: "Customer/production orders with due dates.",
    fields: [
      { key: "id", label: "Order ID", type: "string", required: true },
      { key: "factory_id", label: "Factory ID", type: "string", required: true, ...REF("factories") },
      { key: "product_id", label: "Product ID", type: "string", required: true, ...REF("products") },
      { key: "quantity", label: "Quantity", type: "number", required: true },
      { key: "due_date", label: "Due date (UTC ISO)", type: "date", required: true },
      { key: "priority", label: "Priority (1=highest)", type: "number", required: false, defaultValue: 3 },
      { key: "status", label: "Status", type: "string", required: false, defaultValue: "open" },
    ],
  },
  stock_movements: {
    key: "stock_movements",
    label: "Stock Movements",
    table: "stock_movements",
    naturalKey: ["id"],
    keyPolicy: "insert-if-new",
    description: "Inventory receipts, consumption, and adjustments.",
    fields: [
      { key: "id", label: "Movement ID", type: "string", required: true },
      { key: "material_id", label: "Material ID", type: "string", required: true, ...REF("materials") },
      { key: "factory_id", label: "Factory ID", type: "string", required: true, ...REF("factories") },
      { key: "movement_type", label: "Movement type", type: "enum", required: true, enumValues: ["receipt", "consumption", "adjustment"] },
      { key: "qty", label: "Quantity", type: "number", required: true },
      { key: "movement_ts", label: "Movement timestamp (UTC ISO)", type: "date", required: true },
      { key: "source_ref", label: "Source reference", type: "string", required: false },
    ],
  },
  supplier_deliveries: {
    key: "supplier_deliveries",
    label: "Supplier Delivery Schedules",
    table: "supplier_deliveries",
    naturalKey: ["id"],
    keyPolicy: "upsert",
    description: "Expected and actual supplier deliveries.",
    fields: [
      { key: "id", label: "Delivery ID", type: "string", required: true },
      { key: "supplier_id", label: "Supplier ID", type: "string", required: true, ...REF("suppliers") },
      { key: "material_id", label: "Material ID", type: "string", required: true, ...REF("materials") },
      { key: "expected_qty", label: "Expected quantity", type: "number", required: true },
      { key: "expected_date", label: "Expected date (UTC ISO)", type: "date", required: true },
      { key: "actual_qty", label: "Actual quantity", type: "number", required: false },
      { key: "actual_date", label: "Actual date (UTC ISO)", type: "date", required: false },
      { key: "status", label: "Status", type: "enum", required: false, enumValues: ["pending", "in_transit", "delivered", "delayed", "cancelled"], defaultValue: "pending" },
    ],
  },
  production_records: {
    key: "production_records",
    label: "Production Records",
    table: "production_records",
    naturalKey: ["id"],
    keyPolicy: "insert-if-new",
    deriveSourceTsFrom: "end_ts",
    description: "Actual production output by lot/step.",
    fields: [
      { key: "id", label: "Record ID", type: "string", required: true },
      { key: "order_id", label: "Order ID", type: "string", required: false, ...REF("orders") },
      { key: "product_id", label: "Product ID", type: "string", required: true, ...REF("products") },
      { key: "equipment_id", label: "Equipment ID", type: "string", required: true, ...REF("equipment") },
      { key: "lot_id", label: "Lot ID", type: "string", required: true },
      { key: "step_no", label: "Step number", type: "number", required: true },
      { key: "good_qty", label: "Good quantity", type: "number", required: true },
      { key: "defect_qty", label: "Defect quantity", type: "number", required: false, defaultValue: 0 },
      { key: "start_ts", label: "Start timestamp (UTC ISO)", type: "date", required: true },
      { key: "end_ts", label: "End timestamp (UTC ISO)", type: "date", required: true },
    ],
  },
  inspections: {
    key: "inspections",
    label: "Inspection Results",
    table: "inspections",
    naturalKey: ["id"],
    keyPolicy: "insert-if-new",
    deriveSourceTsFrom: "inspected_ts",
    description: "Quality inspection outcomes by lot.",
    fields: [
      { key: "id", label: "Inspection ID", type: "string", required: true },
      { key: "lot_id", label: "Lot ID", type: "string", required: true },
      { key: "order_id", label: "Order ID", type: "string", required: false, ...REF("orders") },
      { key: "product_id", label: "Product ID", type: "string", required: true, ...REF("products") },
      { key: "inspected_qty", label: "Inspected quantity", type: "number", required: true },
      { key: "defect_qty", label: "Defect quantity", type: "number", required: false, defaultValue: 0 },
      { key: "defect_category", label: "Defect category", type: "string", required: false },
      { key: "result", label: "Result", type: "enum", required: true, enumValues: ["pass", "fail", "partial"] },
      { key: "inspected_ts", label: "Inspected timestamp (UTC ISO)", type: "date", required: true },
    ],
  },
  equipment_states: {
    key: "equipment_states",
    label: "Equipment States",
    table: "equipment_states",
    naturalKey: ["id"],
    keyPolicy: "insert-if-new",
    deriveSourceTsFrom: "start_ts",
    description: "Equipment running/stopped/maintenance state intervals.",
    fields: [
      { key: "id", label: "State record ID", type: "string", required: true },
      { key: "equipment_id", label: "Equipment ID", type: "string", required: true, ...REF("equipment") },
      { key: "state", label: "State", type: "enum", required: true, enumValues: ["running", "stopped", "maintenance", "unknown"] },
      { key: "planned", label: "Planned downtime?", type: "boolean", required: false, defaultValue: false },
      { key: "start_ts", label: "Start timestamp (UTC ISO)", type: "date", required: true },
      { key: "end_ts", label: "End timestamp (UTC ISO)", type: "date", required: false },
    ],
  },
  sensor_readings: {
    key: "sensor_readings",
    label: "Sensor Measurements",
    table: "sensor_readings",
    naturalKey: ["equipment_id", "metric", "source_ts"],
    keyPolicy: "insert-if-new",
    description: "Raw equipment sensor telemetry.",
    fields: [
      { key: "id", label: "Reading ID", type: "string", required: false },
      { key: "equipment_id", label: "Equipment ID", type: "string", required: true, ...REF("equipment") },
      { key: "metric", label: "Metric name", type: "string", required: true },
      { key: "value", label: "Value", type: "number", required: true },
      { key: "unit", label: "Unit", type: "string", required: false },
      { key: "source_ts", label: "Reading timestamp (UTC ISO)", type: "date", required: true },
    ],
  },
  shipments: {
    key: "shipments",
    label: "Shipments",
    table: "shipments",
    naturalKey: ["id"],
    keyPolicy: "insert-if-new",
    deriveSourceTsFrom: "ship_ts",
    description: "Finished-goods shipments against orders.",
    fields: [
      { key: "id", label: "Shipment ID", type: "string", required: true },
      { key: "order_id", label: "Order ID", type: "string", required: true, ...REF("orders") },
      { key: "shipped_qty", label: "Shipped quantity", type: "number", required: true },
      { key: "ship_ts", label: "Ship timestamp (UTC ISO)", type: "date", required: true },
      { key: "carrier", label: "Carrier", type: "string", required: false },
      { key: "status", label: "Status", type: "string", required: false, defaultValue: "shipped" },
    ],
  },
};

export function getCategory(key: string): CategoryDef {
  const cat = CATEGORIES[key];
  if (!cat) throw new Error(`Unknown category: ${key}`);
  return cat;
}

export const CATEGORY_KEYS = Object.keys(CATEGORIES);
