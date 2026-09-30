import { Router, Request, Response, NextFunction } from "express";
import { getSince, emitEquipmentEvent, emitProductionEvent, emitSensorEvent, resetAll, EndpointKey } from "./generator.js";

export const mockApiRouter = Router();

const API_KEY = process.env.MOCK_API_KEY ?? "demo-api-key-12345";
const BEARER_TOKEN = process.env.MOCK_API_BEARER_TOKEN ?? "demo-bearer-token-67890";

interface ForceState {
  status: 429 | 500 | "malformed";
  remaining: number;
}
const forceState: Partial<Record<EndpointKey | "all", ForceState>> = {};

function maybeForce(endpoint: EndpointKey, res: Response): boolean {
  const state = forceState[endpoint] ?? forceState.all;
  if (!state || state.remaining <= 0) return false;
  state.remaining--;
  if (state.status === 429) {
    res.set("Retry-After", "2").status(429).json({ error: "rate limited (forced for testing)" });
  } else if (state.status === 500) {
    res.status(500).json({ error: "internal error (forced for testing)" });
  } else {
    res.status(200).set("Content-Type", "application/json").send("{not valid json,,,");
  }
  return true;
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "missing or invalid x-api-key header" });
  }
  next();
}

function requireBearer(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization") ?? "";
  if (auth !== `Bearer ${BEARER_TOKEN}`) {
    return res.status(401).json({ error: "missing or invalid Authorization bearer token" });
  }
  next();
}

function paginated(key: EndpointKey) {
  return (req: Request, res: Response) => {
    if (maybeForce(key, res)) return;
    const since = Number(req.query.since ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    res.json(getSince(key, Number.isFinite(since) ? since : 0, Number.isFinite(limit) ? limit : 50));
  };
}

// No authentication — demonstrates the "none" connector auth mode.
mockApiRouter.get("/public/equipment-events", paginated("equipment"));

// API-key authentication — demonstrates the "api_key" connector auth mode.
mockApiRouter.get("/secure/production-events", requireApiKey, paginated("production"));

// Bearer-token authentication — demonstrates the "bearer" connector auth mode.
mockApiRouter.get("/secure/sensor-events", requireBearer, paginated("sensor"));

mockApiRouter.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ---- Admin/test-only controls (not part of the "external API" surface a real connector
// would call; used to drive deterministic tests and manual demos of resiliency behavior).
mockApiRouter.post("/admin/emit", (req, res) => {
  const { category, payload } = req.body as { category: EndpointKey; payload?: Record<string, unknown> };
  const fn = { equipment: emitEquipmentEvent, production: emitProductionEvent, sensor: emitSensorEvent }[category];
  if (!fn) return res.status(400).json({ error: "category must be equipment|production|sensor" });
  res.json(fn(payload ?? {}));
});

mockApiRouter.post("/admin/force", (req, res) => {
  const { endpoint, status, times } = req.body as { endpoint?: EndpointKey | "all"; status: 429 | 500 | "malformed"; times?: number };
  forceState[endpoint ?? "all"] = { status, remaining: times ?? 1 };
  res.json({ ok: true, forceState });
});

mockApiRouter.post("/admin/reset", (_req, res) => {
  for (const k of Object.keys(forceState)) delete forceState[k as EndpointKey | "all"];
  resetAll();
  res.json({ ok: true });
});
