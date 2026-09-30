import { mulberry32 } from "../util/rng.js";

/**
 * In-memory generator behind the mock factory API (see docs/MOCK_API_CONTRACT.md).
 * Simulates three independent event streams referencing the same sample-data IDs
 * (equipment/products/orders) so connector-ingested data joins cleanly with the
 * uploaded factory model. Each stream has its own monotonic `seq` cursor.
 */

export type EndpointKey = "equipment" | "production" | "sensor";

export interface MockEvent {
  seq: number;
  eventTime: string;
  [key: string]: unknown;
}

const rand = mulberry32(1234);
const MAX_EVENTS_PER_STREAM = 5000;

const streams: Record<EndpointKey, MockEvent[]> = { equipment: [], production: [], sensor: [] };
const seqCounters: Record<EndpointKey, number> = { equipment: 0, production: 0, sensor: 0 };

const EQUIPMENT_IDS = ["EQ-STAMP-1", "EQ-WELD-1", "EQ-PAINT-1"];
const PRODUCTS = ["PROD-BRAKE-PAD", "PROD-ROTOR", "PROD-CALIPER"];
// product -> [step, machine] pairs matching the sample process routes
const ROUTE_STEPS: Record<string, [number, string][]> = {
  "PROD-BRAKE-PAD": [[1, "EQ-STAMP-1"], [2, "EQ-PAINT-1"]],
  "PROD-ROTOR": [[1, "EQ-WELD-1"], [2, "EQ-PAINT-1"]],
  "PROD-CALIPER": [[1, "EQ-STAMP-1"], [2, "EQ-WELD-1"], [3, "EQ-PAINT-1"]],
};
const ORDER_PRODUCT: Record<string, string> = { "ORD-1004": "PROD-BRAKE-PAD", "ORD-1005": "PROD-ROTOR", "ORD-1006": "PROD-CALIPER", "ORD-1007": "PROD-BRAKE-PAD" };
const OPEN_ORDERS = ["ORD-1004", "ORD-1005", "ORD-1006", "ORD-1007"];
const SENSOR_METRICS: { name: string; unit: string; base: number; noise: number }[] = [
  { name: "temperature_c", unit: "C", base: 55, noise: 3 },
  { name: "vibration_mm_s", unit: "mm/s", base: 2.2, noise: 0.4 },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function push(key: EndpointKey, payload: Record<string, unknown>): MockEvent {
  const seq = ++seqCounters[key];
  const event: MockEvent = { seq, eventTime: new Date().toISOString(), ...payload };
  const stream = streams[key];
  stream.push(event);
  if (stream.length > MAX_EVENTS_PER_STREAM) stream.shift();
  return event;
}

let liveLotCounter = 1;

export function emitEquipmentEvent(overrides: Partial<Record<string, unknown>> = {}): MockEvent {
  const machineId = (overrides.machineId as string) ?? pick(EQUIPMENT_IDS);
  const status = (overrides.status as string) ?? pick(["running", "running", "running", "stopped", "maintenance"]);
  const start = new Date();
  return push("equipment", {
    machineId,
    status,
    plannedStop: status === "maintenance",
    intervalStart: start.toISOString(),
    intervalEnd: status === "running" ? null : new Date(start.getTime() + 20 * 60_000).toISOString(),
    ...overrides,
  });
}

export function emitProductionEvent(overrides: Partial<Record<string, unknown>> = {}): MockEvent {
  const workOrder = (overrides.workOrder as string) ?? pick(OPEN_ORDERS);
  const part = (overrides.part as string) ?? ORDER_PRODUCT[workOrder] ?? pick(PRODUCTS);
  const [defaultStep, defaultMachine] = pick(ROUTE_STEPS[part] ?? [[1, pick(EQUIPMENT_IDS)] as [number, string]]);
  const okQty = (overrides.okQty as number) ?? Math.round(180 + rand() * 40);
  const ngQty = (overrides.ngQty as number) ?? Math.round(rand() * 8);
  const end = new Date();
  const start = new Date(end.getTime() - (30 + rand() * 20) * 60_000);
  return push("production", {
    workOrder,
    part,
    machine: defaultMachine,
    batch: (overrides.batch as string) ?? `LOT-LIVE-${liveLotCounter++}`,
    opStep: defaultStep,
    okQty,
    ngQty,
    opStart: start.toISOString(),
    opEnd: end.toISOString(),
    ...overrides,
  });
}

export function emitSensorEvent(overrides: Partial<Record<string, unknown>> = {}): MockEvent {
  const machineId = (overrides.machineId as string) ?? pick(EQUIPMENT_IDS);
  const requestedMetricName = overrides.sensor as string | undefined;
  const m = (requestedMetricName ? SENSOR_METRICS.find((s) => s.name === requestedMetricName) : undefined) ?? pick(SENSOR_METRICS);
  return push("sensor", {
    machineId,
    sensor: m.name,
    reading: Math.round((m.base + (rand() - 0.5) * 2 * m.noise) * 100) / 100,
    uom: m.unit,
    ...overrides,
  });
}

export function seed(): void {
  for (let i = 0; i < 5; i++) emitEquipmentEvent();
  for (let i = 0; i < 8; i++) emitProductionEvent();
  for (let i = 0; i < 12; i++) emitSensorEvent();
}

export function getSince(key: EndpointKey, since: number, limit: number): { events: MockEvent[]; nextCursor: number; hasMore: boolean } {
  const stream = streams[key];
  const filtered = stream.filter((e) => e.seq > since);
  const page = filtered.slice(0, limit);
  const nextCursor = page.length > 0 ? page[page.length - 1].seq : since;
  return { events: page, nextCursor, hasMore: filtered.length > page.length };
}

export function resetAll(): void {
  streams.equipment = [];
  streams.production = [];
  streams.sensor = [];
  seqCounters.equipment = 0;
  seqCounters.production = 0;
  seqCounters.sensor = 0;
  liveLotCounter = 1;
  seed();
}

let autoEmitTimer: NodeJS.Timeout | null = null;

/** Periodically emits a random event on each stream so LIVE polling has something to observe during manual testing. Not used by deterministic tests, which call emit*Event directly. */
export function startAutoEmit(intervalMs = 12_000): void {
  if (autoEmitTimer) return;
  autoEmitTimer = setInterval(() => {
    emitEquipmentEvent();
    emitProductionEvent();
    emitSensorEvent();
  }, intervalMs);
  autoEmitTimer.unref();
}

export function stopAutoEmit(): void {
  if (autoEmitTimer) clearInterval(autoEmitTimer);
  autoEmitTimer = null;
}

seed();
