/**
 * Generates the default sample-data set (1 factory, 3 products, 3 machines, 2 suppliers)
 * for the automotive brake-parts example. Deterministic (fixed seed) so re-running produces
 * identical output. Run with: npx tsx scripts/generateSampleData.ts
 */
import fs from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import { mulberry32 } from "../src/util/rng.js";

const rand = mulberry32(42);
const OUT_DIR = path.resolve(process.cwd(), "../sample-data");
fs.mkdirSync(OUT_DIR, { recursive: true });

// Anchor "today" for the sample dataset. Historical rows go backward from here so the
// walkthrough shows recent activity; order due dates spread from slightly overdue to
// several weeks out so at-risk/on-track examples both exist.
const TODAY = new Date("2026-09-21T08:00:00.000Z");
const days = (n: number) => new Date(TODAY.getTime() + n * 86_400_000);
const hours = (d: Date, n: number) => new Date(d.getTime() + n * 3_600_000);
const iso = (d: Date) => d.toISOString();

function writeCsv(name: string, rows: Record<string, unknown>[]) {
  const csv = stringify(rows, { header: true });
  fs.writeFileSync(path.join(OUT_DIR, name), csv);
  console.log(`wrote ${name} (${rows.length} rows)`);
}

function writeJson(name: string, rows: unknown[]) {
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(rows, null, 2));
  console.log(`wrote ${name} (${rows.length} rows)`);
}

async function writeXlsx(name: string, rows: Record<string, unknown>[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  if (rows.length > 0) {
    ws.columns = Object.keys(rows[0]).map((key) => ({ header: key, key }));
    ws.addRows(rows);
  }
  await wb.xlsx.writeFile(path.join(OUT_DIR, name));
  console.log(`wrote ${name} (${rows.length} rows)`);
}

// ---------------------------------------------------------------- Master data

const factories = [{ id: "FAC-1", name: "Riverside Auto Parts Plant", timezone: "America/Chicago" }];

const lines = [
  { id: "LINE-A", factory_id: "FAC-1", name: "Forming & Welding Line A" },
  { id: "LINE-B", factory_id: "FAC-1", name: "Finishing Line B" },
];

const equipment = [
  { id: "EQ-STAMP-1", factory_id: "FAC-1", line_id: "LINE-A", name: "Stamping Press 1", equipment_type: "stamping_press", nominal_cycle_time_sec: 27, rate_per_hour_cost: 45, available_hours_per_day: 16 },
  { id: "EQ-WELD-1", factory_id: "FAC-1", line_id: "LINE-A", name: "Welding Robot 1", equipment_type: "welding_robot", nominal_cycle_time_sec: 38, rate_per_hour_cost: 60, available_hours_per_day: 16 },
  { id: "EQ-PAINT-1", factory_id: "FAC-1", line_id: "LINE-B", name: "Paint/E-Coat Booth 1", equipment_type: "paint_booth", nominal_cycle_time_sec: 18, rate_per_hour_cost: 38, available_hours_per_day: 16 },
];

const products = [
  { id: "PROD-BRAKE-PAD", name: "Brake Pad Set", sku: "BP-4200", unit: "set" },
  { id: "PROD-ROTOR", name: "Brake Rotor", sku: "RT-3100", unit: "ea" },
  { id: "PROD-CALIPER", name: "Brake Caliper", sku: "CL-9000", unit: "ea" },
];

const processRoutes = [
  { id: "RT-BP-1", product_id: "PROD-BRAKE-PAD", step_no: 1, step_name: "Stamp backing plate", equipment_type: "stamping_press", standard_cycle_time_sec: 25, expected_yield_pct: 98 },
  { id: "RT-BP-2", product_id: "PROD-BRAKE-PAD", step_no: 2, step_name: "E-coat backing plate", equipment_type: "paint_booth", standard_cycle_time_sec: 15, expected_yield_pct: 99 },
  { id: "RT-RT-1", product_id: "PROD-ROTOR", step_no: 1, step_name: "Weld hub assembly", equipment_type: "welding_robot", standard_cycle_time_sec: 40, expected_yield_pct: 97 },
  { id: "RT-RT-2", product_id: "PROD-ROTOR", step_no: 2, step_name: "Finish coat", equipment_type: "paint_booth", standard_cycle_time_sec: 20, expected_yield_pct: 99 },
  { id: "RT-CL-1", product_id: "PROD-CALIPER", step_no: 1, step_name: "Stamp caliper bracket", equipment_type: "stamping_press", standard_cycle_time_sec: 30, expected_yield_pct: 97 },
  { id: "RT-CL-2", product_id: "PROD-CALIPER", step_no: 2, step_name: "Weld bracket to housing", equipment_type: "welding_robot", standard_cycle_time_sec: 35, expected_yield_pct: 96 },
  { id: "RT-CL-3", product_id: "PROD-CALIPER", step_no: 3, step_name: "Finish coat", equipment_type: "paint_booth", standard_cycle_time_sec: 18, expected_yield_pct: 99 },
];

const materials = [
  { id: "MAT-STEEL-COIL", name: "Steel Coil Stock", unit: "kg", unit_cost: 3.2 },
  { id: "MAT-FRICTION-COMPOUND", name: "Friction Compound", unit: "kg", unit_cost: 5.0 },
  { id: "MAT-PAINT", name: "E-Coat Paint", unit: "L", unit_cost: 2.0 },
  { id: "MAT-FASTENER-KIT", name: "Fastener Kit", unit: "kit", unit_cost: 1.5 },
];

const bom = [
  { id: "BOM-BP-1", product_id: "PROD-BRAKE-PAD", material_id: "MAT-STEEL-COIL", qty_per_unit: 0.4 },
  { id: "BOM-BP-2", product_id: "PROD-BRAKE-PAD", material_id: "MAT-FRICTION-COMPOUND", qty_per_unit: 0.2 },
  { id: "BOM-BP-3", product_id: "PROD-BRAKE-PAD", material_id: "MAT-PAINT", qty_per_unit: 0.05 },
  { id: "BOM-RT-1", product_id: "PROD-ROTOR", material_id: "MAT-STEEL-COIL", qty_per_unit: 1.2 },
  { id: "BOM-RT-2", product_id: "PROD-ROTOR", material_id: "MAT-PAINT", qty_per_unit: 0.08 },
  { id: "BOM-CL-1", product_id: "PROD-CALIPER", material_id: "MAT-STEEL-COIL", qty_per_unit: 0.9 },
  { id: "BOM-CL-2", product_id: "PROD-CALIPER", material_id: "MAT-FASTENER-KIT", qty_per_unit: 1 },
  { id: "BOM-CL-3", product_id: "PROD-CALIPER", material_id: "MAT-PAINT", qty_per_unit: 0.06 },
];

const suppliers = [
  { id: "SUP-STEELCO", name: "SteelCo Metals", default_lead_time_days: 5 },
  { id: "SUP-CHEMPARTS", name: "ChemParts Industrial", default_lead_time_days: 7 },
];

// ---------------------------------------------------------------- Orders

const orders = [
  { id: "ORD-1001", factory_id: "FAC-1", product_id: "PROD-BRAKE-PAD", quantity: 4000, due_date: iso(days(-1)), priority: 1, status: "open" }, // already overdue-ish -> at risk
  { id: "ORD-1002", factory_id: "FAC-1", product_id: "PROD-ROTOR", quantity: 2500, due_date: iso(days(3)), priority: 2, status: "open" },
  { id: "ORD-1003", factory_id: "FAC-1", product_id: "PROD-CALIPER", quantity: 1800, due_date: iso(days(5)), priority: 1, status: "open" },
  { id: "ORD-1004", factory_id: "FAC-1", product_id: "PROD-BRAKE-PAD", quantity: 3000, due_date: iso(days(9)), priority: 3, status: "open" },
  { id: "ORD-1005", factory_id: "FAC-1", product_id: "PROD-ROTOR", quantity: 1600, due_date: iso(days(12)), priority: 3, status: "open" },
  { id: "ORD-1006", factory_id: "FAC-1", product_id: "PROD-CALIPER", quantity: 1200, due_date: iso(days(15)), priority: 4, status: "open" },
  { id: "ORD-1007", factory_id: "FAC-1", product_id: "PROD-BRAKE-PAD", quantity: 2200, due_date: iso(days(20)), priority: 4, status: "open" },
  { id: "ORD-0900", factory_id: "FAC-1", product_id: "PROD-ROTOR", quantity: 1000, due_date: iso(days(-6)), priority: 2, status: "closed" }, // already fully shipped
];

// ---------------------------------------------------------------- Production history (last 10 days)

const HIST_DAYS = 10;
const productionRecords: Record<string, unknown>[] = [];
const inspections: Record<string, unknown>[] = [];
const equipmentStates: Record<string, unknown>[] = [];
const sensorReadings: Record<string, unknown>[] = [];
const stockMovements: Record<string, unknown>[] = [];

const routesByEquipmentType: Record<string, typeof processRoutes> = {};
for (const r of processRoutes) {
  (routesByEquipmentType[r.equipment_type] ??= []).push(r);
}

const eqForType: Record<string, string> = {
  stamping_press: "EQ-STAMP-1",
  welding_robot: "EQ-WELD-1",
  paint_booth: "EQ-PAINT-1",
};

// Orders currently "open" that production should be logged against, cycling through them.
const openOrderIds = orders.filter((o) => o.status === "open").map((o) => o.id);
let orderCursor = 0;
function nextOpenOrderForProduct(productId: string): string {
  const candidates = orders.filter((o) => o.product_id === productId && o.status === "open").map((o) => o.id);
  if (candidates.length === 0) return orders.find((o) => o.product_id === productId)!.id;
  orderCursor++;
  return candidates[orderCursor % candidates.length];
}

let lotCounter = 1;
let prCounter = 1;
let inspCounter = 1;

for (let d = -HIST_DAYS; d < 0; d++) {
  const dayStart = days(d);
  for (const route of processRoutes) {
    const equipmentId = eqForType[route.equipment_type];
    // Two production runs (shifts) per day per route/equipment.
    for (let shift = 0; shift < 2; shift++) {
      // Routes that share a machine run one after another inside the shift (a machine never
      // runs two jobs at once), each taking an equal slot of the ~7h shift window.
      const sharing = processRoutes.filter((r) => eqForType[r.equipment_type] === equipmentId);
      const slot = 7 / sharing.length;
      const slotIndex = sharing.findIndex((r) => r.id === route.id);
      const runHours = slot * (0.85 + rand() * 0.1);
      const start = hours(dayStart, (shift === 0 ? 6 : 14) + slotIndex * slot);
      const end = hours(start, runHours);
      const cyclesPerHour = 3600 / route.standard_cycle_time_sec;
      const plannedQty = Math.round(cyclesPerHour * runHours * 0.35); // scaled so history is commensurate with order sizes

      const baseYield = (route.expected_yield_pct ?? 97) / 100;
      // Inject an elevated-defect lot on day -3 for the caliper welding step, and a
      // downtime-adjacent dip on day -2 for the stamping press, so the quality/at-risk
      // and downtime views have something real to show.
      const isQualityIncident = route.id === "RT-CL-2" && d === -3;
      const yieldPct = isQualityIncident ? 0.82 : Math.min(0.995, baseYield + (rand() - 0.5) * 0.02);

      const goodQty = Math.round(plannedQty * yieldPct);
      const defectQty = Math.max(0, plannedQty - goodQty);
      const lotId = `LOT-${route.product_id}-${lotCounter++}`;
      const orderId = nextOpenOrderForProduct(route.product_id);
      const prId = `PR-${String(prCounter++).padStart(5, "0")}`;

      productionRecords.push({
        id: prId,
        order_id: orderId,
        product_id: route.product_id,
        equipment_id: equipmentId,
        lot_id: lotId,
        step_no: route.step_no,
        good_qty: goodQty,
        defect_qty: defectQty,
        start_ts: iso(start),
        end_ts: iso(end),
      });

      const inspDefectQty = isQualityIncident ? Math.round(plannedQty * 0.12) : Math.round(defectQty * 0.8);
      const inspGoodEnough = inspDefectQty / plannedQty < 0.05;
      inspections.push({
        id: `INSP-${String(inspCounter++).padStart(5, "0")}`,
        lot_id: lotId,
        order_id: orderId,
        product_id: route.product_id,
        inspected_qty: plannedQty,
        defect_qty: inspDefectQty,
        defect_category: isQualityIncident ? "assembly_gap" : rand() > 0.5 ? "surface_finish" : "dimensional",
        result: inspGoodEnough ? "pass" : "fail",
        inspected_ts: iso(hours(end, 0.5)),
      });

      // Material consumption for this lot.
      const isFirstStep = route.step_no === Math.min(...processRoutes.filter((r) => r.product_id === route.product_id).map((r) => r.step_no));
      for (const line of isFirstStep ? bom.filter((b) => b.product_id === route.product_id) : []) {
        stockMovements.push({
          id: `SM-CONS-${prId}-${line.material_id}`,
          material_id: line.material_id,
          factory_id: "FAC-1",
          movement_type: "consumption",
          qty: Math.round(line.qty_per_unit * (goodQty + defectQty) * 100) / 100,
          movement_ts: iso(end),
          source_ref: prId,
        });
      }
    }
  }

  // Equipment state intervals for the day: running during shifts, stopped overnight,
  // one planned maintenance block, and one unplanned stoppage near the end of the window
  // (ties into the "critical machine unavailable" simulation scenario).
  for (const eq of equipment) {
    equipmentStates.push({
      id: `ES-${eq.id}-${d}-run1`,
      equipment_id: eq.id,
      state: "running",
      planned: false,
      start_ts: iso(hours(dayStart, 6)),
      end_ts: iso(hours(dayStart, 13)),
    });
    if (eq.id === "EQ-WELD-1" && d === -2) {
      equipmentStates.push({
        id: `ES-${eq.id}-${d}-maint`,
        equipment_id: eq.id,
        state: "maintenance",
        planned: true,
        start_ts: iso(hours(dayStart, 13)),
        end_ts: iso(hours(dayStart, 15)),
      });
    } else if (eq.id === "EQ-STAMP-1" && d === -1) {
      equipmentStates.push({
        id: `ES-${eq.id}-${d}-breakdown`,
        equipment_id: eq.id,
        state: "stopped",
        planned: false,
        start_ts: iso(hours(dayStart, 13)),
        end_ts: iso(hours(dayStart, 17)),
      });
    } else {
      equipmentStates.push({
        id: `ES-${eq.id}-${d}-run2`,
        equipment_id: eq.id,
        state: "running",
        planned: false,
        start_ts: iso(hours(dayStart, 14)),
        end_ts: iso(hours(dayStart, 21.5)),
      });
    }
  }
}

// Leave the most recent equipment_states interval open-ended (end_ts null) for
// EQ-PAINT-1 and EQ-WELD-1 to represent "currently running" jobs in the live overview.
equipmentStates.push({
  id: "ES-EQ-PAINT-1-current",
  equipment_id: "EQ-PAINT-1",
  state: "running",
  planned: false,
  start_ts: iso(hours(days(0), -2)),
  end_ts: null,
});
equipmentStates.push({
  id: "ES-EQ-WELD-1-current",
  equipment_id: "EQ-WELD-1",
  state: "running",
  planned: false,
  start_ts: iso(hours(days(0), -1)),
  end_ts: null,
});

// ---------------------------------------------------------------- Sensor readings (last 4 days, hourly)

const SENSOR_DAYS = 4;
const metrics: { name: string; unit: string; base: number; noise: number }[] = [
  { name: "temperature_c", unit: "C", base: 55, noise: 3 },
  { name: "vibration_mm_s", unit: "mm/s", base: 2.2, noise: 0.4 },
];

for (let h = -SENSOR_DAYS * 24; h < 0; h++) {
  const ts = hours(days(0), h);
  for (const eq of equipment) {
    for (const m of metrics) {
      let value = m.base + (rand() - 0.5) * 2 * m.noise;
      // Inject a clear vibration anomaly on the welding robot near the end of the window.
      if (eq.id === "EQ-WELD-1" && m.name === "vibration_mm_s" && h >= -3 && h < 0) {
        value = m.base + 6.5 + rand();
      }
      sensorReadings.push({
        equipment_id: eq.id,
        metric: m.name,
        value: Math.round(value * 100) / 100,
        unit: m.unit,
        source_ts: iso(ts),
      });
    }
  }
}

// ---------------------------------------------------------------- Supplier deliveries & receipts

const supplierDeliveries = [
  { id: "SD-1", supplier_id: "SUP-STEELCO", material_id: "MAT-STEEL-COIL", expected_qty: 5000, expected_date: iso(days(-8)), actual_qty: 5000, actual_date: iso(days(-8)), status: "delivered" },
  { id: "SD-2", supplier_id: "SUP-STEELCO", material_id: "MAT-STEEL-COIL", expected_qty: 5000, expected_date: iso(days(-3)), actual_qty: 5000, actual_date: iso(days(-3)), status: "delivered" },
  { id: "SD-3", supplier_id: "SUP-CHEMPARTS", material_id: "MAT-FRICTION-COMPOUND", expected_qty: 1200, expected_date: iso(days(-2)), actual_qty: null, actual_date: null, status: "delayed" }, // overdue, not received
  { id: "SD-4", supplier_id: "SUP-CHEMPARTS", material_id: "MAT-PAINT", expected_qty: 800, expected_date: iso(days(-5)), actual_qty: 800, actual_date: iso(days(-5)), status: "delivered" },
  { id: "SD-5", supplier_id: "SUP-CHEMPARTS", material_id: "MAT-FASTENER-KIT", expected_qty: 3000, expected_date: iso(days(-4)), actual_qty: 3000, actual_date: iso(days(-4)), status: "delivered" },
  { id: "SD-6", supplier_id: "SUP-STEELCO", material_id: "MAT-STEEL-COIL", expected_qty: 9000, expected_date: iso(days(4)), actual_qty: null, actual_date: null, status: "in_transit" },
  { id: "SD-7", supplier_id: "SUP-CHEMPARTS", material_id: "MAT-FRICTION-COMPOUND", expected_qty: 1200, expected_date: iso(days(6)), actual_qty: null, actual_date: null, status: "pending" },
  { id: "SD-8", supplier_id: "SUP-CHEMPARTS", material_id: "MAT-FASTENER-KIT", expected_qty: 3000, expected_date: iso(days(3)), actual_qty: null, actual_date: null, status: "in_transit" },
];

// Initial receipts corresponding to delivered supplier shipments (feeds current stock).
for (const sd of supplierDeliveries) {
  if (sd.status === "delivered") {
    stockMovements.push({
      id: `SM-RECV-${sd.id}`,
      material_id: sd.material_id,
      factory_id: "FAC-1",
      movement_type: "receipt",
      qty: sd.actual_qty,
      movement_ts: sd.actual_date,
      source_ref: sd.id,
    });
  }
}
// A modest opening balance so consumption doesn't go negative before the first receipt.
for (const m of materials) {
  stockMovements.push({
    id: `SM-OPEN-${m.id}`,
    material_id: m.id,
    factory_id: "FAC-1",
    movement_type: "adjustment",
    qty: 2000,
    movement_ts: iso(days(-HIST_DAYS - 1)),
    source_ref: "opening-balance",
  });
}

// ---------------------------------------------------------------- Shipments

const shipments = [
  { id: "SHIP-1", order_id: "ORD-0900", shipped_qty: 1000, ship_ts: iso(days(-7)), carrier: "RoadFreight Co", status: "shipped" },
  { id: "SHIP-2", order_id: "ORD-1001", shipped_qty: 1500, ship_ts: iso(days(-2)), carrier: "RoadFreight Co", status: "shipped" },
  { id: "SHIP-3", order_id: "ORD-1002", shipped_qty: 800, ship_ts: iso(days(-1)), carrier: "RoadFreight Co", status: "shipped" },
];

// ---------------------------------------------------------------- Write files

writeCsv("factories.csv", factories);
writeCsv("lines.csv", lines);
writeCsv("equipment.csv", equipment);
writeCsv("products.csv", products);
writeCsv("process_routes.csv", processRoutes);
writeCsv("materials.csv", materials);
writeCsv("bom.csv", bom);
writeCsv("suppliers.csv", suppliers);
writeCsv("orders.csv", orders);
await writeXlsx("orders.xlsx", orders); // demonstrates XLSX upload support with the same data as orders.csv
writeCsv("stock_movements.csv", stockMovements);
writeCsv("supplier_deliveries.csv", supplierDeliveries);
writeCsv("production_records.csv", productionRecords);
writeCsv("inspections.csv", inspections);
writeCsv("equipment_states.csv", equipmentStates);
writeJson("sensor_readings.json", sensorReadings); // demonstrates JSON upload support
writeCsv("shipments.csv", shipments);

console.log("\nSample data generation complete.");
