-- Virtual Factory Decision-Support System — core schema
-- All timestamps are stored as ISO-8601 UTC strings. Display-side localization uses
-- factories.timezone. See docs/ASSUMPTIONS.md for units, denominators, and cost formulas.

-- ============================== Master / config data ==============================

CREATE TABLE IF NOT EXISTS factories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL REFERENCES factories(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment (
  id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL REFERENCES factories(id),
  line_id TEXT REFERENCES lines(id),
  name TEXT NOT NULL,
  equipment_type TEXT NOT NULL,
  nominal_cycle_time_sec REAL,
  rate_per_hour_cost REAL,
  available_hours_per_day REAL NOT NULL DEFAULT 16,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  unit TEXT NOT NULL DEFAULT 'ea',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Process route: ordered steps a product must go through. equipment_type is a
-- capability requirement (e.g. "stamping_press"), not a specific machine id — the
-- scheduler picks eligible equipment of that type. This is the explicit, user-provided
-- process route; nothing here is inferred.
CREATE TABLE IF NOT EXISTS process_routes (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  step_no INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  equipment_type TEXT NOT NULL,
  standard_cycle_time_sec REAL NOT NULL,
  expected_yield_pct REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, step_no)
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_cost REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bom (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  material_id TEXT NOT NULL REFERENCES materials(id),
  qty_per_unit REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, material_id)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_lead_time_days REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================== Orders / supply chain ==============================

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  factory_id TEXT NOT NULL REFERENCES factories(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  due_date TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  import_batch_id TEXT
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id),
  factory_id TEXT NOT NULL REFERENCES factories(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt','consumption','adjustment')),
  qty REAL NOT NULL,
  movement_ts TEXT NOT NULL,
  source_ref TEXT,
  import_batch_id TEXT,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_deliveries (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  material_id TEXT NOT NULL REFERENCES materials(id),
  expected_qty REAL NOT NULL,
  expected_date TEXT NOT NULL,
  actual_qty REAL,
  actual_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_transit','delivered','delayed','cancelled')),
  import_batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================== Production / quality / equipment ==============================

CREATE TABLE IF NOT EXISTS production_records (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  lot_id TEXT NOT NULL,
  step_no INTEGER NOT NULL,
  good_qty REAL NOT NULL DEFAULT 0,
  defect_qty REAL NOT NULL DEFAULT 0,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  import_batch_id TEXT
);

CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  inspected_qty REAL NOT NULL,
  defect_qty REAL NOT NULL DEFAULT 0,
  defect_category TEXT,
  result TEXT NOT NULL CHECK (result IN ('pass','fail','partial')),
  inspected_ts TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  import_batch_id TEXT
);

CREATE TABLE IF NOT EXISTS equipment_states (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  state TEXT NOT NULL CHECK (state IN ('running','stopped','maintenance','unknown')),
  planned INTEGER NOT NULL DEFAULT 0,
  start_ts TEXT NOT NULL,
  end_ts TEXT,
  source_ts TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  import_batch_id TEXT
);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  source_ts TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  import_batch_id TEXT,
  UNIQUE(equipment_id, metric, source_ts)
);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  shipped_qty REAL NOT NULL,
  ship_ts TEXT NOT NULL,
  carrier TEXT,
  status TEXT NOT NULL DEFAULT 'shipped',
  source_ts TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  import_batch_id TEXT
);

-- ============================== Ingestion bookkeeping ==============================

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'file' CHECK (source_type IN ('file','api')),
  filename TEXT,
  connector_id TEXT,
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','failed')),
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  mapping_json TEXT
);

CREATE TABLE IF NOT EXISTS import_row_errors (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  row_no INTEGER NOT NULL,
  field TEXT,
  message TEXT NOT NULL,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS field_mapping_presets (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ============================== API connectors ==============================

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  base_url TEXT NOT NULL,
  endpoint_path TEXT NOT NULL DEFAULT '/',
  auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','api_key','bearer')),
  secret_env_var TEXT,
  poll_interval_sec INTEGER NOT NULL DEFAULT 30,
  allow_private_network INTEGER NOT NULL DEFAULT 0,
  mapping_json TEXT,
  status TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped','running','failed')),
  last_cursor TEXT,
  last_success_at TEXT,
  last_source_ts TEXT,
  last_error TEXT,
  last_error_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================== Simulation (isolated from source tables) ==============================

CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scenario TEXT NOT NULL,
  seed INTEGER NOT NULL,
  snapshot_ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','running','complete')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_orders (
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  due_date TEXT NOT NULL,
  priority INTEGER NOT NULL,
  planned_ship_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  PRIMARY KEY (run_id, order_id)
);

CREATE TABLE IF NOT EXISTS sim_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  order_id TEXT NOT NULL,
  step_no INTEGER NOT NULL,
  equipment_id TEXT NOT NULL,
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  qty REAL NOT NULL,
  good_qty REAL,
  defect_qty REAL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','blocked'))
);

CREATE TABLE IF NOT EXISTS sim_inventory_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  material_id TEXT NOT NULL,
  qty_delta REAL NOT NULL,
  ts TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_shipments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  order_id TEXT NOT NULL,
  shipped_qty REAL NOT NULL,
  ship_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_option_history (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  option_type TEXT NOT NULL,
  params_json TEXT,
  applied_at TEXT NOT NULL,
  UNIQUE(run_id, option_type)
);

CREATE TABLE IF NOT EXISTS sim_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  option_type TEXT NOT NULL,
  kpis_json TEXT NOT NULL,
  feasibility TEXT NOT NULL CHECK (feasibility IN ('feasible','infeasible')),
  binding_constraints_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, option_type)
);

-- ============================== Replay sessions ==============================
-- Replay reads the *same* historical source tables above (production_records,
-- inspections, equipment_states, sensor_readings, shipments, stock_movements),
-- filtered by `source_ts <= cursor_ts`. No data is duplicated for replay; only the
-- playback cursor is session state.

CREATE TABLE IF NOT EXISTS replay_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  speed REAL NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('playing','paused','stopped')),
  cursor_ts TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================== Cost configuration ==============================

CREATE TABLE IF NOT EXISTS cost_config (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  description TEXT NOT NULL
);

INSERT OR IGNORE INTO cost_config (key, value, unit, description) VALUES
  ('labor_rate_per_hour', 28, 'USD/hour', 'Fully loaded operator labor cost per hour per staffed job'),
  ('overtime_multiplier', 1.5, 'ratio', 'Multiplier applied to labor_rate_per_hour for overtime hours'),
  ('expedite_fee_flat', 150, 'USD/shipment', 'Flat fee assumed for expedited/alternate-carrier shipment when a response option requires it');
