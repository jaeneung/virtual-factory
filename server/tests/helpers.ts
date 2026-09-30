import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { app } from "../src/app.js";
import { resetDatabase } from "../src/db/client.js";

export const SAMPLE_DIR = path.resolve(__dirname, "../../sample-data");

export const SAMPLE_ORDER: [string, string][] = [
  ["factories", "factories.csv"],
  ["lines", "lines.csv"],
  ["equipment", "equipment.csv"],
  ["products", "products.csv"],
  ["materials", "materials.csv"],
  ["bom", "bom.csv"],
  ["suppliers", "suppliers.csv"],
  ["process_routes", "process_routes.csv"],
  ["orders", "orders.xlsx"],
  ["stock_movements", "stock_movements.csv"],
  ["supplier_deliveries", "supplier_deliveries.csv"],
  ["production_records", "production_records.csv"],
  ["inspections", "inspections.csv"],
  ["equipment_states", "equipment_states.csv"],
  ["sensor_readings", "sensor_readings.json"],
  ["shipments", "shipments.csv"],
];

export async function uploadBuffer(category: string, filename: string, buf: Buffer, mappingOverride?: Record<string, string | null>) {
  const preview = await request(app).post("/api/upload/preview").field("category", category).attach("file", buf, filename);
  if (preview.status !== 200) return { preview, commit: null as null | request.Response };
  const commit = await request(app)
    .post("/api/upload/commit")
    .send({ category, previewToken: preview.body.previewToken, mapping: mappingOverride ?? preview.body.suggestedMapping, filename });
  return { preview, commit };
}

export async function uploadSample(category: string, filename: string) {
  return uploadBuffer(category, filename, fs.readFileSync(path.join(SAMPLE_DIR, filename)));
}

export async function loadAllSamples() {
  for (const [category, file] of SAMPLE_ORDER) {
    const { commit } = await uploadSample(category, file);
    if (!commit || commit.status !== 200 || commit.body.rejectedCount > 0) {
      throw new Error(`sample load failed for ${file}: ${JSON.stringify(commit?.body)}`);
    }
  }
}

export function freshDb() {
  resetDatabase();
}
