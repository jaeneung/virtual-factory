import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { db } from "../src/db/client.js";
import { freshDb, uploadBuffer, uploadSample, loadAllSamples } from "./helpers.js";

const csv = (s: string) => Buffer.from(s.trim() + "\n");

async function seedBase() {
  await uploadSample("factories", "factories.csv");
  await uploadSample("products", "products.csv");
}

describe("file upload ingestion", () => {
  beforeEach(() => freshDb());

  it("imports every sample file (CSV, XLSX, JSON) with zero rejected rows", async () => {
    await loadAllSamples();
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as unknown as { c: number }).c;
    expect(count("factories")).toBe(1);
    expect(count("equipment")).toBe(3);
    expect(count("products")).toBe(3);
    expect(count("suppliers")).toBe(2);
    expect(count("orders")).toBe(8);
    expect(count("sensor_readings")).toBe(576);
  });

  it("previews with a suggested mapping and supports renamed source headers via explicit mapping", async () => {
    const buf = csv("Plant Code,Plant Name,Tz\nFAC-9,Other Plant,UTC");
    const preview = await request(app).post("/api/upload/preview").field("category", "factories").attach("file", buf, "f.csv");
    expect(preview.status).toBe(200);
    expect(preview.body.headers).toEqual(["Plant Code", "Plant Name", "Tz"]);
    expect(preview.body.suggestedMapping.id).toBeNull();

    const { commit } = await uploadBuffer("factories", "f.csv", buf, { id: "Plant Code", name: "Plant Name", timezone: "Tz" });
    expect(commit!.body.insertedCount).toBe(1);
    expect(db.prepare(`SELECT name FROM factories WHERE id='FAC-9'`).get()).toMatchObject({ name: "Other Plant" });
  });

  it("rejects invalid rows with actionable messages: required, reference, date, enum, number", async () => {
    await seedBase();
    const bad = csv(
      [
        "id,order_id,product_id,equipment_id,lot_id,step_no,good_qty,defect_qty,start_ts,end_ts",
        "P1,,PROD-ROTOR,EQ-NOPE,LOT1,1,10,0,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z", // unknown equipment
        "P2,,PROD-ROTOR,EQ-X,LOT2,1,abc,0,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z", // bad number
        "P3,,PROD-ROTOR,EQ-X,LOT3,1,10,0,not-a-date,2026-01-01T01:00:00Z", // bad date
        ",,PROD-ROTOR,EQ-X,LOT4,1,10,0,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z", // missing id
      ].join("\n")
    );
    const { commit } = await uploadBuffer("production_records", "p.csv", bad);
    expect(commit!.body.insertedCount).toBe(0);
    expect(commit!.body.rejectedCount).toBe(4);
    const msgs = commit!.body.errors.map((e: { message: string }) => e.message).join(" | ");
    expect(msgs).toMatch(/does not reference an existing equipment/);
    expect(msgs).toMatch(/must be a number/);
    expect(msgs).toMatch(/valid date/);
    expect(msgs).toMatch(/is required/);
    expect(db.prepare(`SELECT COUNT(*) c FROM production_records`).get()).toMatchObject({ c: 0 });
  });

  it("rejects bad enum values and imports only the valid rows of a mixed file", async () => {
    await seedBase();
    await uploadBuffer("materials", "m.csv", csv("id,name\nMAT-X,Thing"));
    const mixed = csv(
      [
        "id,material_id,factory_id,movement_type,qty,movement_ts",
        "M1,MAT-X,FAC-1,receipt,5,2026-01-01T00:00:00Z",
        "M2,MAT-X,FAC-1,teleport,5,2026-01-01T00:00:00Z",
      ].join("\n")
    );
    const { commit } = await uploadBuffer("stock_movements", "s.csv", mixed);
    expect(commit!.body.insertedCount).toBe(1);
    expect(commit!.body.rejectedCount).toBe(1);
    expect(commit!.body.errors[0].message).toMatch(/must be one of: receipt, consumption, adjustment/);
  });

  it("requires an explicit time zone on datetimes (date-only is UTC midnight)", async () => {
    await seedBase();
    await uploadBuffer("materials", "m.csv", csv("id,name\nMAT-X,Thing"));
    const rows = [
      "id,material_id,factory_id,movement_type,qty,movement_ts",
      "A,MAT-X,FAC-1,receipt,1,2026-03-01T09:00:00",
      "B,MAT-X,FAC-1,receipt,1,2026-03-01 09:00:00",
      "C,MAT-X,FAC-1,receipt,1,2026-03-01",
    ];
    const { commit } = await uploadBuffer("stock_movements", "s.csv", csv(rows.join("\n")));
    expect(commit!.body.insertedCount).toBe(1);
    expect(commit!.body.rejectedCount).toBe(2);
    expect(commit!.body.errors[0].message).toMatch(/no time zone/);
    expect(db.prepare(`SELECT movement_ts t FROM stock_movements WHERE id='C'`).get()).toMatchObject({ t: "2026-03-01T00:00:00.000Z" });
  });

  it("normalizes timestamps with offsets to UTC", async () => {
    await seedBase();
    await uploadBuffer("materials", "m.csv", csv("id,name\nMAT-X,Thing"));
    await uploadBuffer("stock_movements", "s.csv", csv("id,material_id,factory_id,movement_type,qty,movement_ts\nM1,MAT-X,FAC-1,receipt,5,2026-03-01T09:00:00+09:00"));
    expect(db.prepare(`SELECT movement_ts t FROM stock_movements WHERE id='M1'`).get()).toMatchObject({ t: "2026-03-01T00:00:00.000Z" });
  });

  it("does not duplicate event data on re-upload, and updates master data instead", async () => {
    await loadAllSamples();
    const before = (db.prepare(`SELECT COUNT(*) c FROM production_records`).get() as unknown as { c: number }).c;
    const again = await uploadSample("production_records", "production_records.csv");
    expect(again.commit!.body.insertedCount).toBe(0);
    expect(again.commit!.body.duplicateCount).toBe(before);
    expect((db.prepare(`SELECT COUNT(*) c FROM production_records`).get() as unknown as { c: number }).c).toBe(before);

    const sensorAgain = await uploadSample("sensor_readings", "sensor_readings.json");
    expect(sensorAgain.commit!.body.duplicateCount).toBe(576);

    const ordersAgain = await uploadSample("orders", "orders.csv");
    expect(ordersAgain.commit!.body.updatedCount).toBe(8);
    expect((db.prepare(`SELECT COUNT(*) c FROM orders`).get() as unknown as { c: number }).c).toBe(8);
  });

  it("rejects unsupported file types and malformed JSON", async () => {
    const txt = await request(app).post("/api/upload/preview").field("category", "factories").attach("file", Buffer.from("x"), "f.txt");
    expect(txt.status).toBe(400);
    expect(txt.body.error).toMatch(/Unsupported file type/);
    const badJson = await request(app).post("/api/upload/preview").field("category", "factories").attach("file", Buffer.from("{oops"), "f.json");
    expect(badJson.status).toBe(400);
    expect(badJson.body.error).toMatch(/Invalid JSON/);
  });

  it("enforces the row-count limit", async () => {
    const rows = ["id,name"];
    for (let i = 0; i < 100_001; i++) rows.push(`F${i},n`);
    const res = await request(app).post("/api/upload/preview").field("category", "factories").attach("file", Buffer.from(rows.join("\n")), "big.csv");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeding the limit/);
  });

  it("records an import batch report", async () => {
    const { commit } = await uploadBuffer("factories", "f.csv", csv("id,name\nFAC-1,A\nFAC-1,A dup in file"));
    expect(commit!.body.insertedCount).toBe(1);
    expect(commit!.body.updatedCount).toBe(1);
    const batch = await request(app).get(`/api/upload/batches/${commit!.body.batchId}`);
    expect(batch.body.batch).toMatchObject({ category: "factories", inserted_count: 1, updated_count: 1 });
  });
});
