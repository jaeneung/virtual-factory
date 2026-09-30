# Virtual Factory — manufacturing decision-support system

Upload manufacturing data (or connect a read-only REST API) to build an operational model of a factory, watch an integrated overview, replay history, and simulate response options for delayed material, machine outages and quality problems. The default example is an automotive brake-parts plant: 1 factory, 3 products, 3 machines, 2 suppliers.

Node.js + TypeScript. Server: Express + built-in `node:sqlite`. Web: React + Vite. No external services or paid APIs.

## Requirements

Node.js 22.5+ (developed on 24) and npm. `node:sqlite` is used to avoid native builds on Windows; it is still marked experimental by Node and prints a warning at start-up.

## Run locally

```bash
npm install
npm run build          # builds server (dist/) and web (web/dist)
npm start              # http://127.0.0.1:4000  (API + UI + built-in mock API)
```

Set `PORT` / `HOST` to change the listen address (default `127.0.0.1:4000`). Data lives in `server/data/app.db` (override with `VF_DATA_DIR` or `VF_DB_PATH`); delete it to start empty.

Development with hot reload: `npm run dev:server` (API on `PORT`, default 4000) and `npm run dev:web` (UI on 5173, proxying `/api` to `VF_API_PORT`, default 4000).

## Workflow with the sample data

1. **Upload data** tab → choose a category → pick a file from `sample-data/` → *Preview file* → check the field mapping → *Validate* → *Confirm and import*. Import in this order (later files reference earlier ones): `factories, lines, equipment, products, materials, bom, suppliers, process_routes, orders, stock_movements, supplier_deliveries, production_records, inspections, equipment_states, sensor_readings, shipments`. `orders.xlsx` (XLSX) duplicates `orders.csv`; `sensor_readings.json` demonstrates JSON. Re-uploading is safe: event data (production, inspections, stock movements, states, sensors, shipments) is de-duplicated, master data and orders are updated in place.
2. **Overview (LIVE)** shows production, quality, equipment, supply chain, delivery, cost, traceability (click an order id), source freshness, and filters.
3. **API connectors** → *Set up demo connectors* → *Start* each. They poll the built-in mock API every 5–10 s; the overview refreshes automatically (SSE change notifications + refetch). Emit new mock events with `POST /mock-api/admin/emit` (see `docs/MOCK_API_CONTRACT.md`) and watch the numbers move.
4. **Replay**: create a session over the history range, then play / pause / change speed / reset.
5. **Simulation**: pick one of four scenarios and a seed → compare *keep current plan / alternate equipment / overtime / resequence* → apply an option to the virtual plan (once per run).

The sample data is anchored around 2026-09-21. The Simulation page therefore defaults its *snapshot time* to the latest data timestamp; clear it to simulate from "now".

Regenerate the sample files with `npm run generate-sample-data` (deterministic).

## Real API connections

A connector = base URL + endpoint path + auth type + **name of a server-side environment variable** + field mapping + poll interval.

1. Export the secret in the environment of the server process, never in the UI or a file in the repo:
   ```bash
   # bash / PowerShell ($env:MES_API_TOKEN = "...")
   export MES_API_TOKEN="…"
   npm start
   ```
2. API connectors tab → *Add a connector*: `Auth = Bearer token` (sent as `Authorization: Bearer …`) or `API key` (sent as `x-api-key`), *Secret env var name* = `MES_API_TOKEN`.
3. Fill the mapping (internal field → response field) from **your API documentation or from the *Test* response preview** — nothing is assumed about your response shape. Current contract: a JSON object `{ "events": [ … ], "nextCursor": <value> }`, queried as `GET <base><path>?since=<cursor>&limit=50`. If your API differs (different pagination or wrapper), a small adapter in `server/src/connectors/ingest.ts` is required — this is not verified against any real system.
4. Only `http`/`https` are allowed. Loopback, private, link-local and metadata addresses are refused unless *allow private-network host* is ticked for that connector; every redirect hop is re-checked. Only GET requests are ever sent.

## Tests and checks

```bash
npm run typecheck      # server + web
npm test               # 63 server tests (vitest)
npm run build
```

## Optional browser E2E

Drives the real UI (upload wizard with errors and manual mapping, order trace, live update from the mock API, replay play/pause/reset, simulation compare/apply). Start the app on an **empty** database with `MOCK_API_AUTO_EMIT=false`, then:

```bash
npm i --no-save playwright-core
CHROME_PATH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" BASE=http://127.0.0.1:4000 node e2e/run.mjs
```

## Layout

`server/src/ingestion` (parse, map, validate, persist) · `connectors` (HTTP client, SSRF guard, polling) · `mockApi` · `domain` (KPIs, cost, overview, traceability, integrity) · `simulation` · `replay` · `intelligence` (rule-based baselines) · `realtime` (SSE) · `routes` · `web/src` (UI) · `sample-data/` · `docs/`.

See `docs/DATA_DICTIONARY.md`, `docs/MOCK_API_CONTRACT.md`, `docs/ASSUMPTIONS.md`.
