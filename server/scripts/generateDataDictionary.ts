import fs from "node:fs";
import path from "node:path";
import { CATEGORIES } from "../src/ingestion/categories.js";

const lines: string[] = [];
lines.push("# Data dictionary", "");
lines.push("Generated from `server/src/ingestion/categories.ts` by `npx tsx scripts/generateDataDictionary.ts` — the code is the source of truth.", "");
lines.push("## Conventions", "");
lines.push("- **Timestamps** must be ISO-8601. Values with an offset (`2026-03-01T09:00:00+09:00`) are converted to UTC; a datetime **without** an offset is rejected (\"add Z or +09:00\") because guessing a time zone silently shifts data; a date-only value (`2026-03-01`) means 00:00 UTC. All storage and API output is UTC; the factory timezone (`factories.timezone`) is descriptive only.");
lines.push("- **Units** are documented per field (seconds, hours, USD, %). Nothing is converted automatically: provide values in the documented unit.");
lines.push("- **Required** fields must be present and non-empty; optional fields fall back to the listed default or NULL (never to a fabricated value).");
lines.push("- **References** (`→ table`) must already exist; a row pointing at a missing record is rejected with a message naming the table to import first.");
lines.push("- **Key policy**: `upsert` = re-uploading the same key updates the record (master data, orders, deliveries). `insert-if-new` = immutable event/fact records; a repeated key is reported as a *duplicate* and left untouched, so re-uploads never double count.");
lines.push("- Limits: 20 MB per file, 100,000 rows per file. CSV needs a header row; JSON is an array of objects (or `{ \"records\": [...] }`); XLSX uses the first sheet, header in row 1.");
lines.push("- Source column names may differ from the internal names: map them in the upload wizard. The sample files use the internal names 1:1.", "");
lines.push("## Sample files (`sample-data/`)", "");
lines.push("| File | Category | Content |", "|---|---|---|");
const files: Record<string, string> = {
  factories: "factories.csv", lines: "lines.csv", equipment: "equipment.csv", products: "products.csv", process_routes: "process_routes.csv", materials: "materials.csv",
  bom: "bom.csv", suppliers: "suppliers.csv", orders: "orders.csv / orders.xlsx", stock_movements: "stock_movements.csv", supplier_deliveries: "supplier_deliveries.csv",
  production_records: "production_records.csv", inspections: "inspections.csv", equipment_states: "equipment_states.csv", sensor_readings: "sensor_readings.json", shipments: "shipments.csv",
};
for (const c of Object.values(CATEGORIES)) lines.push(`| ${files[c.key]} | \`${c.key}\` | ${c.description} |`);
lines.push("", "The sample set is synthetic (fixed seed, dates anchored around 2026-09-21): 1 factory, 2 lines, 3 machines, 3 products, 4 materials, 2 suppliers, 8 orders, 10 days of production/inspection history, 4 days of hourly sensor data. It deliberately contains a quality incident (caliper welding), an unplanned stoppage (stamping press), a sensor anomaly (welding robot vibration), an overdue supplier delivery, and overdue/at-risk orders.", "");
for (const c of Object.values(CATEGORIES)) {
  lines.push(`## ${c.label} — \`${c.key}\``, "", c.description, "");
  lines.push(`Natural key: \`${c.naturalKey.join(", ")}\` · policy: \`${c.keyPolicy}\``, "");
  lines.push("| Field | Meaning | Type | Required | Unit / default / reference |", "|---|---|---|---|---|");
  for (const f of c.fields) {
    const extra = [f.unit ? `unit: ${f.unit}` : "", f.defaultValue !== undefined ? `default: ${f.defaultValue}` : "", f.refTable ? `→ ${f.refTable}` : "", f.enumValues ? `values: ${f.enumValues.join(", ")}` : ""].filter(Boolean).join("; ");
    lines.push(`| \`${f.key}\` | ${f.label} | ${f.type} | ${f.required ? "yes" : "no"} | ${extra} |`);
  }
  lines.push("");
}
fs.writeFileSync(path.resolve("../docs/DATA_DICTIONARY.md"), lines.join("\n"));
console.log("written");
