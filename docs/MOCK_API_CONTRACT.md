# Mock factory API contract

The built-in mock API (`server/src/mockApi`) stands in for a real MES/ERP when no credentials or specifications are available. It is served by the same process under `/mock-api`. **It is a fixture, not a model of any real system** — a real API needs its own field mapping, and possibly an adapter if its pagination differs (see README).

The connector treats it exactly like an external API: server-side HTTP GET, auth headers from environment variables, SSRF guard (the demo connectors tick *allow private network* because the mock API is on loopback).

## Endpoints (all GET, JSON)

| Endpoint | Auth | Stream / category |
|---|---|---|
| `/mock-api/public/equipment-events` | none | equipment state intervals → `equipment_states` |
| `/mock-api/secure/production-events` | header `x-api-key: <MOCK_API_KEY>` | production results → `production_records` |
| `/mock-api/secure/sensor-events` | header `Authorization: Bearer <MOCK_API_BEARER_TOKEN>` | sensor readings → `sensor_readings` |
| `/mock-api/health` | none | liveness |

Demo values (not secrets): `MOCK_API_KEY=demo-api-key-12345`, `MOCK_API_BEARER_TOKEN=demo-bearer-token-67890`; the server sets these defaults if the variables are unset. Wrong or missing credentials → `401 {"error": …}`.

### Query and response

`GET <endpoint>?since=<cursor>&limit=<n>` (`since` default 0, `limit` default 50, max 200)

```json
{ "events": [ { "seq": 41, "eventTime": "2026-09-24T01:20:11.123Z", "...": "stream-specific fields" } ],
  "nextCursor": 41, "hasMore": false }
```

`seq` is a per-stream, strictly increasing integer. `nextCursor` is the last returned `seq` (or the request's `since` when nothing is new). The connector persists it and sends it as `since` on the next poll (incremental collection). `hasMore` indicates that more events exist beyond `limit`; the next poll continues from `nextCursor`.

### Stream event fields

| Stream | Fields (source names) |
|---|---|
| equipment | `seq, machineId, status (running\|stopped\|maintenance\|unknown), plannedStop (bool), intervalStart, intervalEnd (nullable), eventTime` |
| production | `seq, workOrder, part, machine, batch, opStep, okQty, ngQty, opStart, opEnd, eventTime` |
| sensor | `seq, machineId, sensor, reading, uom, eventTime` |

Default mappings created by *Set up demo connectors* (internal field ← source field):

- equipment: `id←seq, equipment_id←machineId, state←status, planned←plannedStop, start_ts←intervalStart, end_ts←intervalEnd`
- production: `id←seq, order_id←workOrder, product_id←part, equipment_id←machine, lot_id←batch, step_no←opStep, good_qty←okQty, defect_qty←ngQty, start_ts←opStart, end_ts←opEnd`
- sensor: `id←seq, equipment_id←machineId, metric←sensor, value←reading, unit←uom, source_ts←eventTime`

Ids are namespaced per connector (`<connectorId>:<seq>`), so collected records never collide with uploaded ones. Events reference the same equipment/products/orders as `sample-data/`, so import the sample data first; events with unknown references are counted as *rejected* without failing the poll.

Timestamps: `eventTime` is the **source** time; the server stores its own **ingestion** time separately (`ingested_at`). Newer source timestamps win for the same id; older or equal ones (late, out-of-order or duplicate deliveries) are ignored.

## Test/demo controls (not part of the "external" surface)

| Call | Effect |
|---|---|
| `POST /mock-api/admin/emit` `{ "category": "equipment\|production\|sensor", "payload": { … } }` | append an event (payload fields override generated ones) |
| `POST /mock-api/admin/force` `{ "endpoint": "equipment\|production\|sensor\|all", "status": 429\|500\|"malformed", "times": n }` | make the next *n* requests fail (429 sends `Retry-After: 2`; `malformed` returns invalid JSON with status 200) |
| `POST /mock-api/admin/reset` | clear events and forced failures, reseed |

Example: `curl -X POST localhost:4000/mock-api/admin/emit -H 'Content-Type: application/json' -d '{"category":"production","payload":{"workOrder":"ORD-1004","part":"PROD-BRAKE-PAD","machine":"EQ-PAINT-1","opStep":2,"okQty":500,"ngQty":3}}'`

Unless `MOCK_API_AUTO_EMIT=false`, the mock also emits one random event per stream every 12 s so a started connector visibly has something to collect. Streams keep at most 5,000 events in memory.
