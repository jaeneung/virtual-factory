import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { db } from "../src/db/client.js";
import { getRun } from "../src/simulation/simRepo.js";
import { evaluateOption, buildSnapshotForRun } from "../src/simulation/compare.js";
import { buildScenario } from "../src/simulation/scenarios.js";
import { mulberry32 } from "../src/util/rng.js";
import { freshDb, loadAllSamples } from "./helpers.js";

const SNAPSHOT = "2026-09-24T00:00:00.000Z";
const SCENARIOS = ["normal", "delayed_material", "machine_down", "quality_urgent"] as const;
const OPTIONS = ["keep_current_plan", "alt_equipment", "overtime", "resequence"] as const;

type Row = Record<string, unknown>;
const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as unknown as Row[];

async function createRun(scenario: string, seed = 7) {
  const res = await request(app).post("/api/simulation/runs").send({ name: `t-${scenario}`, scenario, seed, snapshotTs: SNAPSHOT });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.run.id as string;
}

async function options(runId: string) {
  const res = await request(app).get(`/api/simulation/runs/${runId}/options`);
  expect(res.status).toBe(200);
  return res.body.options as {
    type: string;
    feasibility: string;
    kpis: Record<string, number>;
    additionalCostVsBaseline: number;
    orderOutcomes: { orderId: string; plannedShipDate: string | null; lateDays: number; finalGoodQty: number; requestedQty: number; feasible: boolean }[];
  }[];
}

const liveSnapshot = () =>
  JSON.stringify(
    ["orders", "production_records", "inspections", "stock_movements", "shipments", "equipment_states", "sensor_readings", "supplier_deliveries"].map((t) => [
      t,
      all(`SELECT * FROM ${t} ORDER BY id`),
    ])
  );

beforeAll(async () => {
  freshDb();
  await loadAllSamples();
});

describe("scenarios and response options", () => {
  it("evaluates all four options for each of the four scenarios against identical orders", async () => {
    for (const scenario of SCENARIOS) {
      const runId = await createRun(scenario);
      const opts = await options(runId);
      expect(opts.map((o) => o.type)).toEqual([...OPTIONS]);
      const orderSets = opts.map((o) => o.orderOutcomes.map((x) => x.orderId).sort().join(","));
      expect(new Set(orderSets).size, `${scenario}: every option must see the same orders`).toBe(1);
      for (const o of opts) {
        expect(o.kpis.goodUnitOutput).toBeGreaterThanOrEqual(0);
        expect(o.kpis.totalCost).toBeGreaterThan(0);
        expect(["feasible", "infeasible"]).toContain(o.feasibility);
      }
    }
  });

  it("is reproducible for the same seed and snapshot, and the urgent-order scenario depends on the seed", async () => {
    const a = await options(await createRun("quality_urgent", 11));
    const b = await options(await createRun("quality_urgent", 11));
    const strip = (x: typeof a) => JSON.stringify(x.map((o) => [o.kpis, o.orderOutcomes.map((r) => [r.finalGoodQty, r.plannedShipDate, r.lateDays])]));
    expect(strip(a)).toBe(strip(b));
    const c = await options(await createRun("quality_urgent", 12));
    expect(strip(c)).not.toBe(strip(a));
  });

  it("scenarios change outcomes relative to normal operations (no hard-coded favorable results)", async () => {
    const normal = (await options(await createRun("normal")))[0];
    const down = (await options(await createRun("machine_down")))[0];
    const delayed = (await options(await createRun("delayed_material")))[0];
    const urgent = (await options(await createRun("quality_urgent")))[0];

    const ship = (o: typeof normal, id: string) => new Date(o.orderOutcomes.find((x) => x.orderId === id)!.plannedShipDate!).getTime();
    expect(ship(down, "ORD-1001")).toBeGreaterThan(ship(normal, "ORD-1001"));
    const laterOrders = delayed.orderOutcomes.filter((o) => ship(delayed, o.orderId) > ship(normal, o.orderId));
    expect(laterOrders.length).toBeGreaterThan(0);
    expect(urgent.kpis.shortageUnits).toBeGreaterThan(normal.kpis.shortageUnits);
    expect(urgent.orderOutcomes.some((o) => o.orderId.startsWith("URGENT-"))).toBe(true);
    expect(down.kpis.totalLateDays).toBeGreaterThanOrEqual(normal.kpis.totalLateDays);
  });

  it("does not fabricate a benefit from alternate equipment when no machine is down, and reports trade-offs when one is", async () => {
    const normal = await options(await createRun("normal"));
    expect(JSON.stringify(normal[1].kpis)).toBe(JSON.stringify(normal[0].kpis));

    const down = await options(await createRun("machine_down"));
    const keep = down[0];
    const alt = down[1];
    // Substitution has a documented cycle-time/yield penalty and extra cost; the comparison must expose that honestly.
    expect(alt.additionalCostVsBaseline).toBe(Math.round((alt.kpis.totalCost - keep.kpis.totalCost) * 100) / 100);
    expect(alt.kpis.goodUnitOutput).toBeLessThanOrEqual(keep.kpis.goodUnitOutput);
  });

  it("overtime adds only a premium cost, resequencing adds none, and neither changes yield", async () => {
    const opts = await options(await createRun("normal"));
    const [keep, , overtime, reseq] = opts;
    expect(overtime.kpis.overtimePremium).toBeGreaterThan(0);
    expect(overtime.additionalCostVsBaseline).toBeGreaterThan(0);
    expect(reseq.additionalCostVsBaseline).toBe(0);
    expect(overtime.kpis.goodUnitOutput).toBe(keep.kpis.goodUnitOutput);
  });
});

describe("virtual plan invariants", () => {
  it("has no overlapping jobs per machine, sequential steps per order, and consistent quantities", async () => {
    for (const scenario of SCENARIOS) {
      const runId = await createRun(scenario);
      for (const opt of ["overtime", "resequence", "alt_equipment"]) {
        await request(app).post(`/api/simulation/runs/${runId}/apply`).send({ optionType: opt });
        const jobs = all(`SELECT * FROM sim_jobs WHERE run_id = ? ORDER BY equipment_id, planned_start`, runId) as {
          order_id: string; step_no: number; equipment_id: string; planned_start: string; planned_end: string; qty: number; good_qty: number; defect_qty: number;
        }[];
        expect(jobs.length).toBeGreaterThan(0);
        for (let i = 1; i < jobs.length; i++) {
          if (jobs[i].equipment_id === jobs[i - 1].equipment_id) {
            expect(jobs[i].planned_start >= jobs[i - 1].planned_end, `${scenario}/${opt}: overlap on ${jobs[i].equipment_id}`).toBe(true);
          }
        }
        for (const j of jobs) {
          expect(j.good_qty + j.defect_qty).toBe(j.qty);
          expect(j.planned_end > j.planned_start).toBe(true);
        }
        const byOrder = new Map<string, typeof jobs>();
        for (const j of jobs) byOrder.set(j.order_id, [...(byOrder.get(j.order_id) ?? []), j]);
        for (const list of byOrder.values()) {
          list.sort((a, b) => a.step_no - b.step_no);
          for (let i = 1; i < list.length; i++) {
            expect(list[i].planned_start >= list[i - 1].planned_end).toBe(true);
            expect(list[i].qty, `${scenario}/${opt} order ${list[i].order_id} step ${list[i].step_no}`).toBe(list[i - 1].good_qty);
          }
        }
      }
    }
  });

  it("never plans consumption beyond stock plus deliveries received by then (no negative inventory), and shipments reconcile with production", async () => {
    for (const scenario of SCENARIOS) {
      const runId = await createRun(scenario);
      await request(app).post(`/api/simulation/runs/${runId}/apply`).send({ optionType: "overtime" });
      const snap = buildSnapshotForRun(getRun(runId)!);
      const events = all(`SELECT material_id, qty_delta, ts FROM sim_inventory_events WHERE run_id = ? ORDER BY ts`, runId) as { material_id: string; qty_delta: number; ts: string }[];
      const cfg = buildScenario(scenario, snap, runId, mulberry32(7));
      for (const mat of new Set(events.map((e) => e.material_id))) {
        const delayMs = cfg.type === "delayed_material" && cfg.delayedMaterialId === mat ? (cfg.delayDays ?? 0) * 86_400_000 : 0;
        let consumed = 0;
        for (const e of events.filter((x) => x.material_id === mat)) {
          consumed += -e.qty_delta;
          const t = new Date(e.ts).getTime();
          const received = (snap.materialDeliveries.get(mat) ?? []).filter((d) => d.ts.getTime() + delayMs <= t).reduce((s, d) => s + d.qty, 0);
          expect(consumed, `${scenario}: ${mat} over-consumed`).toBeLessThanOrEqual((snap.materialOpeningStock.get(mat) ?? 0) + received + 1e-6);
        }
      }
      const shipments = all(`SELECT order_id, shipped_qty FROM sim_shipments WHERE run_id = ?`, runId) as { order_id: string; shipped_qty: number }[];
      for (const s of shipments) {
        const last = all(`SELECT good_qty FROM sim_jobs WHERE run_id = ? AND order_id = ? ORDER BY step_no DESC LIMIT 1`, runId, s.order_id) as { good_qty: number }[];
        expect(s.shipped_qty).toBe(last[0].good_qty);
      }
    }
  });

  it("applies an option only to the virtual plan: history recorded, second apply rejected, original data untouched", async () => {
    const runId = await createRun("machine_down");
    const before = liveSnapshot();
    const dueBefore = all(`SELECT order_id, due_date FROM sim_orders WHERE run_id = ? ORDER BY order_id`, runId);

    const first = await request(app).post(`/api/simulation/runs/${runId}/apply`).send({ optionType: "overtime" });
    expect(first.status).toBe(200);
    const again = await request(app).post(`/api/simulation/runs/${runId}/apply`).send({ optionType: "overtime" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already applied/);

    const history = all(`SELECT option_type FROM sim_option_history WHERE run_id = ?`, runId);
    expect(history).toHaveLength(1);
    expect(all(`SELECT order_id, due_date FROM sim_orders WHERE run_id = ? ORDER BY order_id`, runId)).toEqual(dueBefore);
    expect(liveSnapshot()).toBe(before);

    const badOption = await request(app).post(`/api/simulation/runs/${runId}/apply`).send({ optionType: "wish" });
    expect(badOption.status).toBe(400);
  });

  it("stores simulated state separately from source records and never mutates them", async () => {
    const before = liveSnapshot();
    const runId = await createRun("quality_urgent");
    await request(app).post(`/api/simulation/runs/${runId}/apply`).send({ optionType: "resequence" });
    expect(liveSnapshot()).toBe(before);
    expect((all(`SELECT COUNT(*) c FROM orders WHERE id LIKE 'URGENT-%'`)[0] as { c: number }).c).toBe(0);
    expect((all(`SELECT COUNT(*) c FROM sim_orders WHERE order_id LIKE 'URGENT-%'`)[0] as { c: number }).c).toBeGreaterThan(0);
  });

  it("evaluateOption is a pure function of run state (repeat calls agree)", async () => {
    const runId = await createRun("delayed_material");
    const run = getRun(runId)!;
    expect(JSON.stringify(evaluateOption(run, "overtime").kpis)).toBe(JSON.stringify(evaluateOption(run, "overtime").kpis));
  });
});
