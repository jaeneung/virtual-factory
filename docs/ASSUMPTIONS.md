# Assumptions, formulas and limitations

## Data provenance and modes

| Mode | What it shows | Where the data lives |
|---|---|---|
| **LIVE** | Everything ingested from uploads and polled APIs, up to now. "Live" means *most recently collected*, not a millisecond stream: each source shows its poll interval, last successful ingestion, latest source timestamp, lag, and healthy / stale (lag > 3× interval) / failed status. | source tables |
| **REPLAY** | The same uploaded history seen "as of" a playback cursor (`source_ts <= cursor`). Play / pause / speed / reset only touch the session's cursor. Nothing is copied or deleted. | source tables + `replay_sessions` |
| **SIMULATION** | Predictions for a virtual plan from a snapshot of current data. | separate `simulation_runs`, `sim_*` tables |

The LIVE and REPLAY endpoints never read `sim_*` tables; simulation never writes source tables (asserted by tests that hash every source table before/after). When a connector fails, the last valid rows stay and the source is flagged `failed`/`stale`; missing data is shown as *Unavailable* or *unknown*, never as zero or healthy.

## Identifiers and update policy

See `DATA_DICTIONARY.md`. Master data, orders and supplier deliveries are **upserted** by key; events (production, inspections, stock movements, equipment states, sensor readings, shipments) are **insert-if-new** (repeats are reported as duplicates and change nothing). Connector events are namespaced `<connectorId>:<sourceId>`; for the same id a newer source timestamp wins, older/equal ones are ignored. Stock is never decreased by re-delivered consumption events because those are duplicates by id.

## KPI definitions (UTC; filters: factory, line, equipment, product, time range)

- **On-time delivery rate** = shipments with `ship_ts <= order.due_date` ÷ all shipments in the window (by `ship_ts`). Denominator is shipments, not orders; an order not yet shipped is in neither count.
- **Good-unit output** = Σ `good_qty` of the product's **final** route step (products without a route: all records). Intermediate steps are work-in-progress and would double count.
- **Defect rate** = Σ inspection `defect_qty` ÷ Σ `inspected_qty` in the window.
- **Unplanned downtime** = total hours of `equipment_states` intervals with state `stopped`/`maintenance` and `planned = false`; an open interval counts until now. Shown in hours, not as a ratio (no shift calendar is assumed).
- **Total operating cost** = machine + labor + material, below.
- A KPI is **Unavailable** (with reason) only when its source category has no rows at all or the window is empty for a ratio; a real zero is shown as 0.

## Cost formulas (USD)

- Machine = Σ over production records of `(end−start)` hours × `equipment.rate_per_hour_cost`.
- Labor = same job-hours × `cost_config.labor_rate_per_hour` (default 28; one operator per running job is assumed).
- Material = units started at the **first** route step (good + defect) × BOM `qty_per_unit` × `materials.unit_cost`.
- Equipment or materials with no configured rate/cost are **excluded and listed**, not treated as free. No cost is attributed twice (material only at the first step, machine and labor per record). Rates in the sample data are illustrative.
- **Planned output** in the LIVE overview = Σ order quantities with `due_date` in the window (no production schedule category exists).
- Ship-date estimates for open orders use the product's trailing 14-day final-step throughput; they are estimates, not commitments, and are Unavailable without recent throughput.

## Simulation model (deliberately coarse)

Flow: order → material availability → production steps → inspection yield → finished goods → shipment (+4 h handling).

- Orders are frozen in `sim_orders` at run creation; equipment, routes, BOM and stock/deliveries as of the snapshot time are re-read (stable because uploads never rewrite history). Pass `snapshotTs` and `seed` for reproducible runs; identical inputs give identical results.
- Each machine works a daily window starting 06:00 UTC of `available_hours_per_day` hours; a job may span days. One cursor per machine ⇒ **no overlapping jobs**. Steps of an order run sequentially; the next step's quantity is the previous step's good output.
- Material is committed first-come-first-served in priority order against opening stock plus deliveries not yet received; an order waits for deliveries or is **blocked** (reported as a binding constraint) if it cannot be supplied within the 90-day horizon. Deliveries that are already overdue and unreceived are assumed to arrive **2 days after the snapshot** (`OVERDUE_DELIVERY_ASSUMED_DAYS`) — an explicit assumption because their real arrival is unknown.
- Yield = route `expected_yield_pct` (97% if absent). Expected value, no per-unit randomness; the seed only fixes scenario inputs (e.g. urgent-order size).
- Scenarios: **normal**; **delayed material** (+5 days on the delivery-dependent material with the largest deficit); **critical machine unavailable** (the machine used by most route steps is down for 3 days from the snapshot; work queues behind the outage); **quality + urgent order** (defect rate ×3 and an urgent priority-0 order of 500–800 units due in 2 days).
- Options: **keep current plan** (priority, then due date); **alternate equipment** (only when the specialist machine is down: a differently-typed machine runs the step at 1.5× cycle time and 0.9× yield — an invented, documented penalty; with no machine down it is identical to the baseline); **overtime** (+4 h/day capacity, overtime hours costed at `labor × overtime_multiplier`); **resequence** (earliest due date first, ignoring priority).
- Comparison uses the same snapshot, orders and seed for all options; it reports good units, shortage (requested − good), on-time/late counts, total and max days late, total cost and Δ cost vs. the baseline, feasibility and binding constraints. Results are computed, not tuned: an option can be worse than the baseline and is shown that way.
- Applying an option replaces the run's virtual plan only, records `sim_option_history` (unique per run+option → cannot be applied twice) and never touches `orders` or due dates.
- Not modelled: setup/changeover times, shift calendars, WIP buffers, batch splitting, transport time, real alternate-routing rules, random breakdowns.

## Quality and equipment intelligence (baselines, not AI)

- *At-risk lot*: lot inspection defect rate > max(1.5 × product's historical rate, 5%). Plain threshold rule.
- *Sensor anomaly*: latest reading deviates > 3 standard deviations from the mean of up to 30 preceding readings (needs ≥ 5). Plain z-score rule.
- No model is trained, so there is no train/test split. Performance on the synthetic sample data says nothing about a real factory.

## Security decisions

- All external requests are server-side, GET only. Secrets come from environment variables named in the connector config; only the variable *name* is stored/returned. Secrets are sent in headers, never URLs, and are not logged.
- Only `http`/`https`. Loopback/private/link-local/metadata hosts (including DNS results) are blocked unless the connector explicitly sets *allow private network*; redirects are followed manually (max 5) and each hop is re-validated. Known residual risk: DNS is resolved once for the check and again by `fetch` (DNS-rebinding window); use network-level egress controls in production.
- Limits: 20 MB / 100,000 rows per upload, 2 MB JSON bodies, 5 s request timeout, 3 retries with exponential backoff (300 ms base), `Retry-After` honored up to 30 s.
- The API has **no user authentication** (single-user local tool). Do not expose it to an untrusted network as-is.

## Dependencies

- `node:sqlite` is experimental in Node; chosen to avoid native builds. Pin the Node version in production.
- XLSX uses `exceljs` (the `xlsx` package has unpatched advisories). `npm audit` still reports a moderate `uuid` advisory transitively via exceljs (not reachable through this app's usage) and dev-only findings in the test tooling.

## Known limitations

- One connector = one category = one endpoint; the response shape must be `{ events, nextCursor[, hasMore] }` (mapping is per-field only, no nested paths or transforms).
- Timezone: storage is UTC; datetimes must carry an explicit offset (or be date-only = 00:00 UTC). The factory timezone is informational; the UI displays in the browser's locale.
- Negative inventory and other integrity problems are **detected and reported** (`/api/overview/integrity`), not blocked at import. Simulation never plans negative stock.
- The UI has no authentication, no pagination for very large tables, and was checked with headless-browser screenshots only (see the final report for what was not exercised interactively).
