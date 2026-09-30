import { Router } from "express";
import { listConnectors, getConnector, createConnector, deleteConnector, resolveSecret, ConnectorRow, CreateConnectorInput } from "../connectors/store.js";
import { startConnector, stopConnector, isRunning } from "../connectors/pollingScheduler.js";
import { pollConnector } from "../connectors/ingest.js";
import { fetchJson } from "../connectors/httpConnector.js";
import { CATEGORY_KEYS } from "../ingestion/categories.js";

export const connectorsRouter = Router();

function sanitize(c: ConnectorRow) {
  // secret_env_var (a variable NAME, not the secret itself) is fine to show; the actual
  // secret value is never read into this object.
  return c;
}

connectorsRouter.get("/", (_req, res) => {
  res.json(listConnectors().map(sanitize).map((c) => ({ ...c, running: isRunning(c.id) })));
});

connectorsRouter.post("/", (req, res) => {
  try {
    const { name, category, baseUrl, endpointPath, authType, secretEnvVar, pollIntervalSec, allowPrivateNetwork, mapping } = req.body;
    if (!name || !category || !baseUrl || !endpointPath) {
      return res.status(400).json({ error: "name, category, baseUrl, endpointPath are required" });
    }
    if (!CATEGORY_KEYS.includes(category)) return res.status(400).json({ error: `unknown category: ${category}` });
    const connector = createConnector({
      name,
      category,
      baseUrl,
      endpointPath,
      authType: authType ?? "none",
      secretEnvVar,
      pollIntervalSec: Number(pollIntervalSec) || 30,
      allowPrivateNetwork: Boolean(allowPrivateNetwork),
      mapping: mapping ?? {},
    });
    res.status(201).json(connector);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

connectorsRouter.delete("/:id", (req, res) => {
  stopConnector(req.params.id);
  deleteConnector(req.params.id);
  res.status(204).end();
});

connectorsRouter.post("/:id/start", (req, res) => {
  try {
    startConnector(req.params.id);
    res.json(getConnector(req.params.id));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

connectorsRouter.post("/:id/stop", (req, res) => {
  stopConnector(req.params.id);
  res.json(getConnector(req.params.id));
});

connectorsRouter.post("/:id/poll-now", async (req, res) => {
  try {
    const result = await pollConnector(req.params.id);
    res.json({ connector: getConnector(req.params.id), result });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Connection test + response preview: does one live fetch against the configured/candidate
 *  URL without writing anything to the database. Used both for a saved connector (:id) and
 *  for testing settings before saving (body-only, no id). */
async function testFetch(req: Parameters<import("express").RequestHandler>[0], res: Parameters<import("express").RequestHandler>[1]) {
  const source = req.params.id ? getConnector(req.params.id) : null;
  const cfg = source ?? req.body;
  if (!cfg || (!cfg.base_url && !cfg.baseUrl)) return res.status(400).json({ error: "connector not found or no config supplied" });

  const baseUrl = cfg.base_url ?? cfg.baseUrl;
  const endpointPath = cfg.endpoint_path ?? cfg.endpointPath ?? "/";
  const authType = cfg.auth_type ?? cfg.authType ?? "none";
  const allowPrivateNetwork = Boolean(cfg.allow_private_network ?? cfg.allowPrivateNetwork);

  const headers: Record<string, string> = {};
  if (source) {
    const secret = resolveSecret(source);
    if (authType === "api_key" && secret) headers["x-api-key"] = secret;
    if (authType === "bearer" && secret) headers["authorization"] = `Bearer ${secret}`;
  } else if (cfg.testSecret) {
    if (authType === "api_key") headers["x-api-key"] = cfg.testSecret;
    if (authType === "bearer") headers["authorization"] = `Bearer ${cfg.testSecret}`;
  }

  const url = `${String(baseUrl).replace(/\/$/, "")}${endpointPath}?since=0&limit=5`;
  const result = await fetchJson(url, { headers, allowPrivateNetwork, timeoutMs: 5000, maxRetries: 0 });
  res.json(result);
}

connectorsRouter.post("/test", testFetch);
connectorsRouter.post("/:id/test", testFetch);

/** Creates (idempotently, by name) three connectors for the built-in mock API, one per auth mode. */
connectorsRouter.post("/demo-setup", (req, res) => {
  const host = req.get("host") ?? "127.0.0.1:5175";
  const baseUrl = `http://${host}/mock-api`;
  const pollIntervalSec = Number(req.body?.pollIntervalSec) || 10;
  const defs: Omit<CreateConnectorInput, "baseUrl" | "pollIntervalSec" | "allowPrivateNetwork">[] = [
    {
      name: "Mock equipment events (no auth)",
      category: "equipment_states",
      endpointPath: "/public/equipment-events",
      authType: "none",
      mapping: { id: "seq", equipment_id: "machineId", state: "status", planned: "plannedStop", start_ts: "intervalStart", end_ts: "intervalEnd" },
    },
    {
      name: "Mock production events (API key)",
      category: "production_records",
      endpointPath: "/secure/production-events",
      authType: "api_key",
      secretEnvVar: "MOCK_API_KEY",
      mapping: { id: "seq", order_id: "workOrder", product_id: "part", equipment_id: "machine", lot_id: "batch", step_no: "opStep", good_qty: "okQty", defect_qty: "ngQty", start_ts: "opStart", end_ts: "opEnd" },
    },
    {
      name: "Mock sensor events (Bearer token)",
      category: "sensor_readings",
      endpointPath: "/secure/sensor-events",
      authType: "bearer",
      secretEnvVar: "MOCK_API_BEARER_TOKEN",
      mapping: { id: "seq", equipment_id: "machineId", metric: "sensor", value: "reading", unit: "uom", source_ts: "eventTime" },
    },
  ];
  const existing = new Set(listConnectors().map((c) => c.name));
  const created = defs
    .filter((d) => !existing.has(d.name))
    .map((d) => createConnector({ ...d, baseUrl, pollIntervalSec, allowPrivateNetwork: true }));
  res.status(201).json({ created: created.length, connectors: listConnectors() });
});
