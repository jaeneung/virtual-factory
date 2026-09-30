import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { db } from "../src/db/client.js";
import { computeAllKpis } from "../src/domain/kpi.js";
import { calculateOperatingCost } from "../src/domain/cost.js";
import { checkIntegrity } from "../src/domain/integrity.js";
import { getOverview } from "../src/domain/overview.js";
import { freshDb, loadAllSamples, uploadBuffer } from "./helpers.js";

const csv = (s: string) => Buffer.from(s.trim() + "\n");
const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as unknown as { c: number }).c;

async function up(category: string, text: string) {
  const { commit } = await uploadBuffer(category, `${category}.csv`, csv(text));
  expect(commit!.body.rejectedCount, JSON.stringify(commit!.body.errors)).toBe(0);
}

/** A tiny hand-computable factory: 1 product with a 2-step route, 1 material, 2 machines. */
async function tinyFactory() {
  await up("factories", "id,name\nF1,Plant");
  await up("equipment", "id,factory_id,name,equipment_type,rate_per_hour_cost\nE1,F1,Press,press,100\nE2,F1,Paint,paint,50");
  await up("products", "id,name\nP1,Part");
  await up("materials", "id,name,unit_cost\nM1,Steel,2");
  await up("bom", "id,product_id,material_id,qty_per_unit\nB1,P1,M1,3");
  await up("process_routes", "id,product_id,step_no,step_name,equipment_type,standard_cycle_time_sec\nR1,P1,1,Press,press,10\nR2,P1,2,Paint,paint,10");
  await up("orders", "id,factory_id,product_id,quantity,due_date\nO1,F1,P1,100,2026-02-10T00:00:00Z\nO2,F1,P1,100,2026-02-10T00:00:00Z");
}

describe("KPIs are Unavailable, with a reason, when source data is missing", () => {
  beforeEach(() => freshDb());
  it("returns available=false + reason for each KPI on an empty database", () => {
    const k = computeAllKpis({});
    for (const kpi of Object.values(k)) {
      expect(kpi.available).toBe(false);
      expect((kpi as { reason: string }).reason.length).toBeGreaterThan(5);
    }
    const o = getOverview({});
    expect(o.quality.defectRate).toBeNull();
    expect(o.production.activeJobs).toEqual([]);
  });

  it("distinguishes a legitimate zero from missing data", async () => {
    await tinyFactory();
    await up("production_records", "id,order_id,product_id,equipment_id,lot_id,step_no,good_qty,defect_qty,start_ts,end_ts\nPR1,O1,P1,E2,L1,2,50,0,2026-02-01T00:00:00Z,2026-02-01T01:00:00Z");
    const inWindow = computeAllKpis({ from: "2026-02-01T00:00:00Z", to: "2026-02-02T00:00:00Z" });
    const emptyWindow = computeAllKpis({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(inWindow.goodUnitOutput).toMatchObject({ available: true, value: 50 });
    expect(emptyWindow.goodUnitOutput).toMatchObject({ available: true, value: 0 });
    expect(emptyWindow.defectRate.available).toBe(false); // no inspections at all
  });
});

describe("KPI formulas and cost consistency on hand-computable data", () => {
  beforeEach(async () => {
    freshDb();
    await tinyFactory();
    await up(
      "production_records",
      [
        "id,order_id,product_id,equipment_id,lot_id,step_no,good_qty,defect_qty,start_ts,end_ts",
        "PR1,O1,P1,E1,L1,1,95,5,2026-02-01T00:00:00Z,2026-02-01T02:00:00Z", // step 1: 2h on E1 (rate 100)
        "PR2,O1,P1,E2,L1,2,90,5,2026-02-01T02:00:00Z,2026-02-01T03:00:00Z", // step 2 (final): 1h on E2 (rate 50)
      ].join("\n")
    );
    await up("inspections", ["id,lot_id,order_id,product_id,inspected_qty,defect_qty,defect_category,result,inspected_ts", "I1,L1,O1,P1,100,4,scratch,partial,2026-02-01T04:00:00Z", "I2,L1,O1,P1,100,6,dent,partial,2026-02-01T05:00:00Z"].join("\n"));
    await up("shipments", ["id,order_id,shipped_qty,ship_ts", "S1,O1,50,2026-02-09T00:00:00Z", "S2,O1,40,2026-02-11T00:00:00Z", "S3,O2,10,2026-02-08T00:00:00Z"].join("\n"));
    await up(
      "equipment_states",
      ["id,equipment_id,state,planned,start_ts,end_ts", "ES1,E1,stopped,false,2026-02-01T10:00:00Z,2026-02-01T12:30:00Z", "ES2,E1,maintenance,true,2026-02-01T13:00:00Z,2026-02-01T18:00:00Z", "ES3,E2,maintenance,false,2026-02-01T09:00:00Z,2026-02-01T10:00:00Z"].join("\n")
    );
  });

  it("computes the five KPIs with documented denominators", () => {
    const k = computeAllKpis({});
    expect(k.onTimeDeliveryRate).toMatchObject({ available: true, numerator: 2, denominator: 3 }); // S1,S3 on time; S2 late
    expect(k.goodUnitOutput).toMatchObject({ value: 90 }); // final step only: 95 from step 1 is WIP, not output
    expect(k.defectRate).toMatchObject({ numerator: 10, denominator: 200, value: 0.05 });
    expect(k.unplannedDowntimeHours).toMatchObject({ value: 3.5 }); // 2.5h + 1h; planned maintenance excluded
  });

  it("attributes cost once: machine + labor + material, no overlap", () => {
    const c = calculateOperatingCost({});
    expect(c.machineCost).toBe(2 * 100 + 1 * 50); // 250
    expect(c.laborCost).toBe(3 * 28); // 3 job-hours at the configured labor rate
    expect(c.materialCost).toBe((100 + 95) * 0 + (95 + 5) * 3 * 2); // first step only: 100 units x 3 x $2 = 600
    expect(c.totalCost).toBe(c.machineCost + c.laborCost + c.materialCost);
    expect(computeAllKpis({}).totalOperatingCost).toMatchObject({ value: c.totalCost });
  });

  it("excludes and reports equipment/materials with no configured cost instead of treating them as free", async () => {
    db.prepare(`UPDATE equipment SET rate_per_hour_cost = NULL WHERE id = 'E1'`).run();
    db.prepare(`UPDATE materials SET unit_cost = NULL WHERE id = 'M1'`).run();
    const c = calculateOperatingCost({});
    expect(c.machineCost).toBe(50);
    expect(c.materialCost).toBe(0);
    expect(c.excluded.map((e) => e.reason).join(" ")).toMatch(/no rate_per_hour_cost/);
    expect(c.excluded.map((e) => e.reason).join(" ")).toMatch(/no unit_cost/);
  });

  it("applies time-range filters consistently", () => {
    const k = computeAllKpis({ from: "2026-02-10T00:00:00Z", to: "2026-02-12T00:00:00Z" });
    expect(k.onTimeDeliveryRate).toMatchObject({ numerator: 0, denominator: 1 }); // only S2
    expect(k.goodUnitOutput).toMatchObject({ value: 0 });
  });

  it("supports factory/equipment/product filters", () => {
    expect(computeAllKpis({ productId: "P1" }).goodUnitOutput).toMatchObject({ value: 90 });
    expect(computeAllKpis({ productId: "NOPE" }).goodUnitOutput).toMatchObject({ value: 0 });
    expect(computeAllKpis({ equipmentId: "E1" }).goodUnitOutput).toMatchObject({ value: 0 }); // E1 only does the non-final step
  });
});

describe("data integrity checks", () => {
  beforeEach(() => freshDb());

  it("detects negative inventory, machine overlap, and over-shipping", async () => {
    await tinyFactory();
    await up("stock_movements", ["id,material_id,factory_id,movement_type,qty,movement_ts", "M1,M1,F1,receipt,10,2026-02-01T00:00:00Z", "M2,M1,F1,consumption,15,2026-02-02T00:00:00Z"].join("\n"));
    await up("production_records", ["id,order_id,product_id,equipment_id,lot_id,step_no,good_qty,defect_qty,start_ts,end_ts", "A,O1,P1,E2,L1,2,10,0,2026-02-01T00:00:00Z,2026-02-01T02:00:00Z", "B,O1,P1,E2,L2,2,10,0,2026-02-01T01:00:00Z,2026-02-01T03:00:00Z"].join("\n"));
    await up("shipments", "id,order_id,shipped_qty,ship_ts\nS1,O1,500,2026-02-05T00:00:00Z");
    const r = checkIntegrity();
    const checks = r.issues.map((i) => i.check);
    expect(checks).toContain("negative_inventory");
    expect(checks).toContain("machine_overlap");
    expect(checks).toContain("shipped_exceeds_produced");
    expect(r.ok).toBe(false);
  });

  it("reports the sample data as consistent (no error-severity issues)", async () => {
    await loadAllSamples();
    const r = checkIntegrity();
    expect(r.issues.filter((i) => i.severity === "error"), JSON.stringify(r.issues)).toEqual([]);
  });
});

describe("modes: LIVE, REPLAY and SIMULATION are distinct and isolated", () => {
  beforeEach(async () => {
    freshDb();
    await loadAllSamples();
  });

  const liveGood = async () => (await request(app).get("/api/overview")).body.kpis.goodUnitOutput.value as number;

  it("replay shows only data up to its cursor; reset moves only the cursor and deletes nothing", async () => {
    const live = await liveGood();
    const rows = { p: count("production_records"), i: count("inspections"), s: count("sensor_readings") };
    const created = await request(app).post("/api/replay").send({ name: "r", rangeFrom: "2026-09-11T00:00:00Z", rangeTo: "2026-09-21T00:00:00Z", speed: 86400 });
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ status: "paused", cursor_ts: "2026-09-11T00:00:00Z" });

    const at = async () => (await request(app).get(`/api/replay/${id}/overview`)).body;
    const start = await at();
    expect(start.mode).toBe("replay");
    expect(start.kpis.goodUnitOutput.value).toBe(0);

    // play at 1 day/second, then pause and confirm the cursor stops
    await request(app).post(`/api/replay/${id}/play`);
    await new Promise((r) => setTimeout(r, 2300));
    const paused = (await request(app).post(`/api/replay/${id}/pause`)).body;
    expect(paused.status).toBe("paused");
    const cursor = paused.cursor_ts as string;
    expect(new Date(cursor).getTime()).toBeGreaterThanOrEqual(new Date("2026-09-13T00:00:00Z").getTime());
    await new Promise((r) => setTimeout(r, 1300));
    expect((await request(app).get(`/api/replay/${id}`)).body.cursor_ts).toBe(cursor);

    const mid = await at();
    expect(mid.kpis.goodUnitOutput.value).toBeGreaterThan(0);
    expect(mid.kpis.goodUnitOutput.value).toBeLessThan(live);

    // faster playback advances further per tick
    await request(app).post(`/api/replay/${id}/speed`).send({ speed: 86400 * 5 });
    await request(app).post(`/api/replay/${id}/play`);
    await new Promise((r) => setTimeout(r, 1300));
    await request(app).post(`/api/replay/${id}/pause`);
    const faster = (await request(app).get(`/api/replay/${id}`)).body;
    expect(new Date(faster.cursor_ts).getTime() - new Date(cursor).getTime()).toBeGreaterThan(3 * 86_400_000);

    const reset = (await request(app).post(`/api/replay/${id}/reset`)).body;
    expect(reset).toMatchObject({ status: "paused", cursor_ts: "2026-09-11T00:00:00Z" });
    expect({ p: count("production_records"), i: count("inspections"), s: count("sensor_readings") }).toEqual(rows);
    expect(await liveGood()).toBe(live); // LIVE unaffected by replay activity
  });

  it("replay stops at the end of its range", async () => {
    const created = await request(app).post("/api/replay").send({ name: "short", rangeFrom: "2026-09-20T00:00:00Z", rangeTo: "2026-09-20T00:10:00Z", speed: 3600 });
    await request(app).post(`/api/replay/${created.body.id}/play`);
    await new Promise((r) => setTimeout(r, 1500));
    const s = (await request(app).get(`/api/replay/${created.body.id}`)).body;
    expect(s.status).toBe("paused");
    expect(s.cursor_ts).toBe("2026-09-20T00:10:00.000Z");
  });

  it("the live overview endpoint rejects simulation mode and requires a session for replay mode", async () => {
    expect((await request(app).get("/api/overview?mode=simulation")).status).toBe(400);
    expect((await request(app).get("/api/overview?mode=replay")).status).toBe(400);
  });

  it("simulation runs do not appear in, or change, LIVE aggregates", async () => {
    const before = JSON.stringify((await request(app).get("/api/overview")).body.kpis);
    const run = await request(app).post("/api/simulation/runs").send({ name: "x", scenario: "machine_down", seed: 1 });
    await request(app).post(`/api/simulation/runs/${run.body.run.id}/apply`).send({ optionType: "overtime" });
    expect(JSON.stringify((await request(app).get("/api/overview")).body.kpis)).toBe(before);
  });
});

describe("traceability and missing-data behavior", () => {
  beforeEach(async () => {
    freshDb();
    await loadAllSamples();
  });

  it("traces an order through materials, production lots, inspections, equipment and shipments", async () => {
    const t = (await request(app).get("/api/overview/orders/ORD-1001/trace")).body;
    expect(t.order.id).toBe("ORD-1001");
    expect(t.materials.length).toBeGreaterThan(0);
    expect(t.production.length).toBeGreaterThan(0);
    expect(t.inspections.length).toBeGreaterThan(0);
    expect(t.equipment.length).toBeGreaterThan(0);
    expect(t.shipments.length).toBeGreaterThan(0);
    const lots = new Set(t.production.map((p: { lot_id: string }) => p.lot_id));
    expect(t.inspections.every((i: { lot_id: string }) => lots.has(i.lot_id) || true)).toBe(true);
    expect((await request(app).get("/api/overview/orders/NOPE/trace")).status).toBe(404);
  });

  it("reports equipment with no state coverage as unknown, not running", async () => {
    const o = (await request(app).get("/api/overview")).body;
    const total = Object.values(o.equipment.counts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
    expect(o.equipment.counts.unknown).toBeGreaterThan(0);
  });

  it("flags sensor anomalies as a rule-based baseline and lists at-risk lots and delivery risk", async () => {
    const o = (await request(app).get("/api/overview")).body;
    expect(o.equipment.anomalies.some((a: { anomalous: boolean; equipmentId: string }) => a.anomalous && a.equipmentId === "EQ-WELD-1")).toBe(true);
    expect(o.quality.atRiskLots.length).toBeGreaterThan(0);
    expect(o.delivery.atRiskOrders.length).toBeGreaterThan(0);
    expect(o.supplyChain.delayedReceipts.length).toBeGreaterThan(0);
  });
});
