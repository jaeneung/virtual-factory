# Data dictionary

Generated from `server/src/ingestion/categories.ts` by `npx tsx scripts/generateDataDictionary.ts` — the code is the source of truth.

## Conventions

- **Timestamps** must be ISO-8601. Values with an offset (`2026-03-01T09:00:00+09:00`) are converted to UTC; a datetime **without** an offset is rejected ("add Z or +09:00") because guessing a time zone silently shifts data; a date-only value (`2026-03-01`) means 00:00 UTC. All storage and API output is UTC; the factory timezone (`factories.timezone`) is descriptive only.
- **Units** are documented per field (seconds, hours, USD, %). Nothing is converted automatically: provide values in the documented unit.
- **Required** fields must be present and non-empty; optional fields fall back to the listed default or NULL (never to a fabricated value).
- **References** (`→ table`) must already exist; a row pointing at a missing record is rejected with a message naming the table to import first.
- **Key policy**: `upsert` = re-uploading the same key updates the record (master data, orders, deliveries). `insert-if-new` = immutable event/fact records; a repeated key is reported as a *duplicate* and left untouched, so re-uploads never double count.
- Limits: 20 MB per file, 100,000 rows per file. CSV needs a header row; JSON is an array of objects (or `{ "records": [...] }`); XLSX uses the first sheet, header in row 1.
- Source column names may differ from the internal names: map them in the upload wizard. The sample files use the internal names 1:1.

## Sample files (`sample-data/`)

| File | Category | Content |
|---|---|---|
| factories.csv | `factories` | Physical factory sites. |
| lines.csv | `lines` | Production lines within a factory. |
| equipment.csv | `equipment` | Machines/equipment and their capabilities. |
| products.csv | `products` | Finished products / parts. |
| process_routes.csv | `process_routes` | Ordered process steps a product goes through, and the equipment capability each step needs. |
| materials.csv | `materials` | Raw materials / components used in BOMs. |
| bom.csv | `bom` | Materials consumed per unit of product. |
| suppliers.csv | `suppliers` | Material suppliers. |
| orders.csv / orders.xlsx | `orders` | Customer/production orders with due dates. |
| stock_movements.csv | `stock_movements` | Inventory receipts, consumption, and adjustments. |
| supplier_deliveries.csv | `supplier_deliveries` | Expected and actual supplier deliveries. |
| production_records.csv | `production_records` | Actual production output by lot/step. |
| inspections.csv | `inspections` | Quality inspection outcomes by lot. |
| equipment_states.csv | `equipment_states` | Equipment running/stopped/maintenance state intervals. |
| sensor_readings.json | `sensor_readings` | Raw equipment sensor telemetry. |
| shipments.csv | `shipments` | Finished-goods shipments against orders. |

The sample set is synthetic (fixed seed, dates anchored around 2026-09-21): 1 factory, 2 lines, 3 machines, 3 products, 4 materials, 2 suppliers, 8 orders, 10 days of production/inspection history, 4 days of hourly sensor data. It deliberately contains a quality incident (caliper welding), an unplanned stoppage (stamping press), a sensor anomaly (welding robot vibration), an overdue supplier delivery, and overdue/at-risk orders.

## Factories — `factories`

Physical factory sites.

Natural key: `id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Factory ID | string | yes |  |
| `name` | Name | string | yes |  |
| `timezone` | IANA timezone | string | no | default: UTC |

## Production Lines — `lines`

Production lines within a factory.

Natural key: `id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Line ID | string | yes |  |
| `factory_id` | Factory ID | string | yes | → factories |
| `name` | Name | string | yes |  |

## Equipment — `equipment`

Machines/equipment and their capabilities.

Natural key: `id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Equipment ID | string | yes |  |
| `factory_id` | Factory ID | string | yes | → factories |
| `line_id` | Line ID | string | no | → lines |
| `name` | Name | string | yes |  |
| `equipment_type` | Equipment type / capability | string | yes |  |
| `nominal_cycle_time_sec` | Nominal cycle time | number | no | unit: seconds |
| `rate_per_hour_cost` | Operating cost rate | number | no | unit: USD/hour |
| `available_hours_per_day` | Available hours/day | number | no | unit: hours; default: 16 |

## Products — `products`

Finished products / parts.

Natural key: `id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Product ID | string | yes |  |
| `name` | Name | string | yes |  |
| `sku` | SKU | string | no |  |
| `unit` | Unit of measure | string | no | default: ea |

## Process Routes — `process_routes`

Ordered process steps a product goes through, and the equipment capability each step needs.

Natural key: `product_id, step_no` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Route step ID | string | yes |  |
| `product_id` | Product ID | string | yes | → products |
| `step_no` | Step number | number | yes |  |
| `step_name` | Step name | string | yes |  |
| `equipment_type` | Required equipment type | string | yes |  |
| `standard_cycle_time_sec` | Standard cycle time | number | yes | unit: seconds |
| `expected_yield_pct` | Expected yield | number | no | unit: % |

## Materials — `materials`

Raw materials / components used in BOMs.

Natural key: `id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Material ID | string | yes |  |
| `name` | Name | string | yes |  |
| `unit` | Unit of measure | string | no | default: ea |
| `unit_cost` | Unit cost | number | no | unit: USD/unit |

## Bill of Materials — `bom`

Materials consumed per unit of product.

Natural key: `product_id, material_id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | BOM line ID | string | yes |  |
| `product_id` | Product ID | string | yes | → products |
| `material_id` | Material ID | string | yes | → materials |
| `qty_per_unit` | Qty per unit | number | yes |  |

## Suppliers — `suppliers`

Material suppliers.

Natural key: `id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Supplier ID | string | yes |  |
| `name` | Name | string | yes |  |
| `default_lead_time_days` | Default lead time | number | no | unit: days |

## Orders — `orders`

Customer/production orders with due dates.

Natural key: `id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Order ID | string | yes |  |
| `factory_id` | Factory ID | string | yes | → factories |
| `product_id` | Product ID | string | yes | → products |
| `quantity` | Quantity | number | yes |  |
| `due_date` | Due date (UTC ISO) | date | yes |  |
| `priority` | Priority (1=highest) | number | no | default: 3 |
| `status` | Status | string | no | default: open |

## Stock Movements — `stock_movements`

Inventory receipts, consumption, and adjustments.

Natural key: `id` · policy: `insert-if-new`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Movement ID | string | yes |  |
| `material_id` | Material ID | string | yes | → materials |
| `factory_id` | Factory ID | string | yes | → factories |
| `movement_type` | Movement type | enum | yes | values: receipt, consumption, adjustment |
| `qty` | Quantity | number | yes |  |
| `movement_ts` | Movement timestamp (UTC ISO) | date | yes |  |
| `source_ref` | Source reference | string | no |  |

## Supplier Delivery Schedules — `supplier_deliveries`

Expected and actual supplier deliveries.

Natural key: `id` · policy: `upsert`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Delivery ID | string | yes |  |
| `supplier_id` | Supplier ID | string | yes | → suppliers |
| `material_id` | Material ID | string | yes | → materials |
| `expected_qty` | Expected quantity | number | yes |  |
| `expected_date` | Expected date (UTC ISO) | date | yes |  |
| `actual_qty` | Actual quantity | number | no |  |
| `actual_date` | Actual date (UTC ISO) | date | no |  |
| `status` | Status | enum | no | default: pending; values: pending, in_transit, delivered, delayed, cancelled |

## Production Records — `production_records`

Actual production output by lot/step.

Natural key: `id` · policy: `insert-if-new`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Record ID | string | yes |  |
| `order_id` | Order ID | string | no | → orders |
| `product_id` | Product ID | string | yes | → products |
| `equipment_id` | Equipment ID | string | yes | → equipment |
| `lot_id` | Lot ID | string | yes |  |
| `step_no` | Step number | number | yes |  |
| `good_qty` | Good quantity | number | yes |  |
| `defect_qty` | Defect quantity | number | no | default: 0 |
| `start_ts` | Start timestamp (UTC ISO) | date | yes |  |
| `end_ts` | End timestamp (UTC ISO) | date | yes |  |

## Inspection Results — `inspections`

Quality inspection outcomes by lot.

Natural key: `id` · policy: `insert-if-new`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Inspection ID | string | yes |  |
| `lot_id` | Lot ID | string | yes |  |
| `order_id` | Order ID | string | no | → orders |
| `product_id` | Product ID | string | yes | → products |
| `inspected_qty` | Inspected quantity | number | yes |  |
| `defect_qty` | Defect quantity | number | no | default: 0 |
| `defect_category` | Defect category | string | no |  |
| `result` | Result | enum | yes | values: pass, fail, partial |
| `inspected_ts` | Inspected timestamp (UTC ISO) | date | yes |  |

## Equipment States — `equipment_states`

Equipment running/stopped/maintenance state intervals.

Natural key: `id` · policy: `insert-if-new`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | State record ID | string | yes |  |
| `equipment_id` | Equipment ID | string | yes | → equipment |
| `state` | State | enum | yes | values: running, stopped, maintenance, unknown |
| `planned` | Planned downtime? | boolean | no | default: false |
| `start_ts` | Start timestamp (UTC ISO) | date | yes |  |
| `end_ts` | End timestamp (UTC ISO) | date | no |  |

## Sensor Measurements — `sensor_readings`

Raw equipment sensor telemetry.

Natural key: `equipment_id, metric, source_ts` · policy: `insert-if-new`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Reading ID | string | no |  |
| `equipment_id` | Equipment ID | string | yes | → equipment |
| `metric` | Metric name | string | yes |  |
| `value` | Value | number | yes |  |
| `unit` | Unit | string | no |  |
| `source_ts` | Reading timestamp (UTC ISO) | date | yes |  |

## Shipments — `shipments`

Finished-goods shipments against orders.

Natural key: `id` · policy: `insert-if-new`

| Field | Meaning | Type | Required | Unit / default / reference |
|---|---|---|---|---|
| `id` | Shipment ID | string | yes |  |
| `order_id` | Order ID | string | yes | → orders |
| `shipped_qty` | Shipped quantity | number | yes |  |
| `ship_ts` | Ship timestamp (UTC ISO) | date | yes |  |
| `carrier` | Carrier | string | no |  |
| `status` | Status | string | no | default: shipped |
