import { Router } from "express";
import { getOverview } from "../domain/overview.js";
import { getAllSourceStatuses } from "../domain/sources.js";
import { getOrderTrace } from "../domain/traceability.js";
import { checkIntegrity } from "../domain/integrity.js";
import { getReplaySession } from "../replay/replayEngine.js";
import { db } from "../db/client.js";
import type { OverviewFilters } from "../domain/filters.js";

export const overviewRouter = Router();

function parseFilters(q: Record<string, unknown>): OverviewFilters {
  return {
    factoryId: q.factoryId ? String(q.factoryId) : undefined,
    lineId: q.lineId ? String(q.lineId) : undefined,
    equipmentId: q.equipmentId ? String(q.equipmentId) : undefined,
    productId: q.productId ? String(q.productId) : undefined,
    from: q.from ? String(q.from) : undefined,
    to: q.to ? String(q.to) : undefined,
  };
}

overviewRouter.get("/", (req, res) => {
  const filters = parseFilters(req.query as Record<string, unknown>);

  const mode = String(req.query.mode ?? "live");
  if (mode === "replay") {
    const sessionId = String(req.query.replaySessionId ?? "");
    const session = getReplaySession(sessionId);
    if (!session) return res.status(400).json({ error: "unknown or missing replaySessionId for replay mode" });
    filters.asOf = session.cursor_ts;
    filters.from = filters.from ?? session.range_from;
  } else if (mode === "simulation") {
    return res.status(400).json({ error: "use /api/simulation/:runId/overview for simulation mode" });
  }

  res.json(getOverview(filters));
});

overviewRouter.get("/sources", (_req, res) => {
  res.json(getAllSourceStatuses());
});

overviewRouter.get("/orders/:id/trace", (req, res) => {
  const trace = getOrderTrace(req.params.id);
  if (!trace) return res.status(404).json({ error: "order not found" });
  res.json(trace);
});

overviewRouter.get("/integrity", (_req, res) => {
  res.json(checkIntegrity());
});

overviewRouter.get("/dimensions", (_req, res) => {
  const q = (sql: string) => db.prepare(sql).all();
  res.json({
    factories: q("SELECT id, name FROM factories ORDER BY id"),
    lines: q("SELECT id, name, factory_id FROM lines ORDER BY id"),
    equipment: q("SELECT id, name, line_id, factory_id FROM equipment ORDER BY id"),
    products: q("SELECT id, name FROM products ORDER BY id"),
    orders: q("SELECT id, product_id, quantity, due_date, status FROM orders ORDER BY due_date"),
    dataRange: db.prepare("SELECT MIN(source_ts) as min, MAX(source_ts) as max FROM production_records").get(),
  });
});

overviewRouter.get("/sensor-trend", (req, res) => {
  const equipmentId = String(req.query.equipmentId ?? "");
  const metric = String(req.query.metric ?? "");
  const asOf = req.query.asOf ? String(req.query.asOf) : "9999-12-31T00:00:00Z";
  const rows = db
    .prepare("SELECT value, source_ts FROM sensor_readings WHERE equipment_id = ? AND metric = ? AND source_ts <= ? ORDER BY source_ts DESC LIMIT 72")
    .all(equipmentId, metric, asOf)
    .reverse();
  res.json(rows);
});
