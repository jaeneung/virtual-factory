import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { app } from "../src/app.js";
import { db } from "../src/db/client.js";
import { stopAllConnectors, startConnector } from "../src/connectors/pollingScheduler.js";
import { clientCount } from "../src/realtime/sseHub.js";
import { freshDb, loadAllSamples } from "./helpers.js";

let server: http.Server;
let host: string;

beforeAll(async () => {
  freshDb();
  await loadAllSamples();
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  await request(`http://${host}`).post("/mock-api/admin/reset");
});

afterAll(async () => {
  stopAllConnectors();
  await new Promise((r) => server.close(r));
});

const api = () => request(`http://${host}`);
const overview = async () => (await api().get("/api/overview")).body;
const goodUnits = async () => (await overview()).kpis.goodUnitOutput.value as number;

async function connectors() {
  const res = await api().post("/api/connectors/demo-setup").set("Host", host).send({ pollIntervalSec: 1 });
  expect(res.status).toBe(201);
  const byName = (prefix: string) => (res.body.connectors as { id: string; name: string }[]).find((c) => c.name.startsWith(prefix))!;
  return { eq: byName("Mock equipment"), prod: byName("Mock production"), sensor: byName("Mock sensor") };
}

const emitProduction = (okQty: number) =>
  api().post("/mock-api/admin/emit").send({ category: "production", payload: { workOrder: "ORD-1004", part: "PROD-BRAKE-PAD", machine: "EQ-PAINT-1", opStep: 2, okQty, ngQty: 0 } });

describe("mock API -> connector -> overview", () => {
  it("ingests the initial snapshot from all three auth modes, then reflects changed mock data in the overview", async () => {
    const c = await connectors();
    const before = await goodUnits();

    for (const conn of [c.eq, c.prod, c.sensor]) {
      const r = await api().post(`/api/connectors/${conn.id}/poll-now`);
      expect(r.body.result.ok, JSON.stringify(r.body)).toBe(true);
      expect(r.body.result.inserted).toBeGreaterThan(0);
    }
    const afterSnapshot = await goodUnits();
    expect(afterSnapshot).toBeGreaterThan(before);

    await emitProduction(777);
    expect(await goodUnits()).toBe(afterSnapshot); // nothing changes until the connector collects
    await api().post(`/api/connectors/${c.prod.id}/poll-now`);
    expect(await goodUnits()).toBe(afterSnapshot + 777);

    // repeated polling with no new data must not double count
    await api().post(`/api/connectors/${c.prod.id}/poll-now`);
    await api().post(`/api/connectors/${c.prod.id}/poll-now`);
    expect(await goodUnits()).toBe(afterSnapshot + 777);
  });

  it("updates the overview automatically within the configured refresh interval and pushes an SSE change notification", async () => {
    const { prod } = await connectors();
    const events: string[] = [];
    const sseReq = http.get(`http://${host}/api/stream?topics=overview`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => events.push(chunk));
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(clientCount()).toBe(1);

    const base = await goodUnits();
    db.prepare(`UPDATE connectors SET poll_interval_sec = 1 WHERE id = ?`).run(prod.id);
    startConnector(prod.id);
    await new Promise((r) => setTimeout(r, 300));
    await emitProduction(321);

    const started = Date.now();
    let seen = base;
    while (Date.now() - started < 4000 && seen !== base + 321) {
      await new Promise((r) => setTimeout(r, 150));
      seen = await goodUnits();
    }
    expect(seen).toBe(base + 321);
    expect(Date.now() - started).toBeLessThan(3500); // within ~interval + request time
    expect(events.join("")).toContain("event: change");

    sseReq.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(clientCount()).toBe(0); // closing the stream leaves no subscription behind
    stopAllConnectors();
  });

  it("keeps the last valid values, flags the source as failed/stale (never zero/healthy), and recovers", async () => {
    const { prod } = await connectors();
    const good = await goodUnits();
    await api().post(`/api/connectors/${prod.id}/poll-now`);
    const beforeFail = (await api().get("/api/overview/sources")).body.find((s: { id: string }) => s.id === prod.id);
    expect(beforeFail.health).toBe("healthy");

    await api().post("/mock-api/admin/force").send({ endpoint: "production", status: 500, times: 4 });
    const failed = await api().post(`/api/connectors/${prod.id}/poll-now`);
    expect(failed.body.result.ok).toBe(false);

    const afterFail = (await api().get("/api/overview/sources")).body.find((s: { id: string }) => s.id === prod.id);
    expect(afterFail.health).toBe("failed");
    expect(afterFail.lastSuccessfulIngestionAt).toBe(beforeFail.lastSuccessfulIngestionAt);
    expect(await goodUnits()).toBe(good); // retained, not zeroed

    await emitProduction(50);
    const recovered = await api().post(`/api/connectors/${prod.id}/poll-now`);
    expect(recovered.body.result.ok).toBe(true);
    const afterRecovery = (await api().get("/api/overview/sources")).body.find((s: { id: string }) => s.id === prod.id);
    expect(afterRecovery.health).toBe("healthy");
    expect(await goodUnits()).toBe(good + 50);
  });

  it("surfaces a 429 from the mock API and recovers after honoring Retry-After", async () => {
    const { sensor } = await connectors();
    await api().post("/mock-api/admin/force").send({ endpoint: "sensor", status: 429, times: 1 });
    const t0 = Date.now();
    const r = await api().post(`/api/connectors/${sensor.id}/poll-now`);
    expect(r.body.result.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1800); // mock sends Retry-After: 2
  });

  it("reports malformed responses as failures without corrupting data", async () => {
    const { eq } = await connectors();
    const rows = (db.prepare(`SELECT COUNT(*) c FROM equipment_states`).get() as unknown as { c: number }).c;
    await api().post("/mock-api/admin/force").send({ endpoint: "equipment", status: "malformed", times: 4 });
    const r = await api().post(`/api/connectors/${eq.id}/poll-now`);
    expect(r.body.result.ok).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) c FROM equipment_states`).get() as unknown as { c: number }).c).toBe(rows);
  });

  it("fails cleanly on wrong credentials (401) and the connection test previews the response", async () => {
    const res = await api().post("/api/connectors").send({
      name: "bad-auth",
      category: "production_records",
      baseUrl: `http://${host}/mock-api`,
      endpointPath: "/secure/production-events",
      authType: "api_key",
      secretEnvVar: "VF_NO_SUCH_VAR",
      allowPrivateNetwork: true,
      mapping: {},
    });
    const t = await api().post(`/api/connectors/${res.body.id}/test`);
    expect(t.body).toMatchObject({ ok: false, status: 401 });

    const { prod } = await connectors();
    const ok = await api().post(`/api/connectors/${prod.id}/test`);
    expect(ok.body.ok, JSON.stringify(ok.body)).toBe(true);
    expect(Array.isArray(ok.body.body.events)).toBe(true);
  });

  it("refuses to create/poll connectors against private hosts unless explicitly allowed", async () => {
    const res = await api().post("/api/connectors").send({
      name: "private-not-allowed",
      category: "sensor_readings",
      baseUrl: `http://${host}/mock-api`,
      endpointPath: "/public/equipment-events",
      authType: "none",
      allowPrivateNetwork: false,
      mapping: {},
    });
    const t = await api().post(`/api/connectors/${res.body.id}/test`);
    expect(t.body.ok).toBe(false);
    expect(t.body.error).toMatch(/private/i);
  });
});
