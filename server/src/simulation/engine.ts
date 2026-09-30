import { EquipmentScheduler, MaterialLedger, DayCapacity } from "./schedule.js";

export interface RouteStep {
  stepNo: number;
  equipmentType: string;
  cycleTimeSec: number;
  expectedYieldPct: number | null;
}

export interface BomLine {
  materialId: string;
  qtyPerUnit: number;
  unitCost: number | null;
}

export interface EquipmentDef {
  id: string;
  name: string;
  equipmentType: string;
  ratePerHourCost: number | null;
  availableHoursPerDay: number;
}

export interface VirtualOrder {
  orderId: string;
  productId: string;
  quantity: number;
  dueDate: Date;
  priority: number;
}

export interface ScenarioConfig {
  type: "normal" | "delayed_material" | "machine_down" | "quality_urgent";
  delayedMaterialId?: string;
  delayDays?: number;
  downEquipmentId?: string;
  downDays?: number;
  defectMultiplier?: number;
  urgentOrder?: VirtualOrder;
}

export interface ResponseOptionConfig {
  type: "keep_current_plan" | "alt_equipment" | "overtime" | "resequence";
  overtimeHoursPerDay?: number;
}

export interface EngineInput {
  snapshotTs: Date;
  orders: VirtualOrder[];
  routesByProduct: Map<string, RouteStep[]>;
  bomByProduct: Map<string, BomLine[]>;
  equipmentList: EquipmentDef[];
  materialOpeningStock: Map<string, number>;
  materialDeliveries: Map<string, { ts: Date; qty: number }[]>;
  scenario: ScenarioConfig;
  option: ResponseOptionConfig;
  costConfig: { laborRatePerHour: number; overtimeMultiplier: number };
}

export interface SimJob {
  orderId: string;
  stepNo: number;
  equipmentId: string;
  plannedStart: Date;
  plannedEnd: Date;
  qty: number;
  goodQty: number;
  defectQty: number;
  substituted: boolean;
}

export interface SimInventoryEvent {
  materialId: string;
  qtyDelta: number;
  ts: Date;
  reason: string;
}

export interface OrderOutcome {
  orderId: string;
  dueDate: Date;
  requestedQty: number;
  finalGoodQty: number;
  plannedShipDate: Date | null;
  lateDays: number;
  feasible: boolean;
  bindingConstraints: string[];
}

export interface ScheduleResult {
  jobs: SimJob[];
  inventoryEvents: SimInventoryEvent[];
  shipments: { orderId: string; shippedQty: number; shipTs: Date }[];
  orderOutcomes: OrderOutcome[];
  kpis: {
    goodUnitOutput: number;
    shortageUnits: number;
    onTimeCount: number;
    lateCount: number;
    infeasibleCount: number;
    onTimeRate: number | null;
    totalLateDays: number;
    maxLateDays: number;
    machineCost: number;
    laborCost: number;
    overtimePremium: number;
    materialCost: number;
    totalCost: number;
  };
  feasibility: "feasible" | "infeasible";
  bindingConstraints: string[];
}

const ALT_EQUIPMENT_CYCLE_PENALTY = 1.5;
const ALT_EQUIPMENT_YIELD_PENALTY = 0.9;
const SHIPPING_HANDLING_HOURS = 4;

function isEquipmentDown(eq: EquipmentDef, scenario: ScenarioConfig): boolean {
  return scenario.type === "machine_down" && eq.id === scenario.downEquipmentId;
}

function resolveEquipment(
  equipmentType: string,
  scenario: ScenarioConfig,
  option: ResponseOptionConfig,
  equipmentList: EquipmentDef[]
): { eq: EquipmentDef; cyclePenalty: number; yieldPenalty: number; substituted: boolean } | null {
  const ofType = equipmentList.filter((e) => e.equipmentType === equipmentType);
  if (ofType.length === 0) return null;
  const healthy = ofType.find((e) => !isEquipmentDown(e, scenario));

  // Same-type equipment that is not down is always preferred.
  if (healthy) return { eq: healthy, cyclePenalty: 1, yieldPenalty: 1, substituted: false };

  // The only machine of this type is temporarily down. The "use alternate equipment"
  // option may substitute a differently-typed machine (lacking the specialized tooling, so
  // at a documented cycle-time and yield penalty). Every other option waits out the outage:
  // the downed machine's capacity is zero until it is repaired, so its jobs queue behind it.
  if (option.type === "alt_equipment") {
    const substitute = equipmentList.find((e) => !isEquipmentDown(e, scenario) && e.equipmentType !== equipmentType);
    if (substitute) return { eq: substitute, cyclePenalty: ALT_EQUIPMENT_CYCLE_PENALTY, yieldPenalty: ALT_EQUIPMENT_YIELD_PENALTY, substituted: true };
  }
  return { eq: ofType[0], cyclePenalty: 1, yieldPenalty: 1, substituted: false };
}

function capacityFnFor(eq: EquipmentDef, scenario: ScenarioConfig, option: ResponseOptionConfig, snapshotTs: Date): (dayStart: Date) => DayCapacity {
  const overtimeHours = option.type === "overtime" ? (option.overtimeHoursPerDay ?? 4) : 0;
  return (dayStart: Date): DayCapacity => {
    if (scenario.type === "machine_down" && eq.id === scenario.downEquipmentId) {
      const downUntil = new Date(snapshotTs.getTime() + (scenario.downDays ?? 2) * 86_400_000);
      if (dayStart < downUntil) return { base: 0, extended: 0 };
    }
    return { base: eq.availableHoursPerDay, extended: eq.availableHoursPerDay + overtimeHours };
  };
}

export function runSchedule(input: EngineInput): ScheduleResult {
  const { snapshotTs, scenario, option, costConfig } = input;

  const orders = [...input.orders];
  // The urgent order is normally already part of the run's frozen order list; only add it if absent so it is never scheduled twice.
  if (scenario.type === "quality_urgent" && scenario.urgentOrder && !orders.some((o) => o.orderId === scenario.urgentOrder!.orderId)) {
    orders.push(scenario.urgentOrder);
  }

  const sequenced =
    option.type === "resequence"
      ? [...orders].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
      : [...orders].sort((a, b) => a.priority - b.priority || a.dueDate.getTime() - b.dueDate.getTime());

  const equipmentSchedulers = new Map<string, EquipmentScheduler>();
  for (const eq of input.equipmentList) {
    equipmentSchedulers.set(eq.id, new EquipmentScheduler(snapshotTs, capacityFnFor(eq, scenario, option, snapshotTs)));
  }

  const materialLedgers = new Map<string, MaterialLedger>();
  for (const [materialId, opening] of input.materialOpeningStock.entries()) {
    let deliveries = input.materialDeliveries.get(materialId) ?? [];
    if (scenario.type === "delayed_material" && materialId === scenario.delayedMaterialId) {
      const delayMs = (scenario.delayDays ?? 5) * 86_400_000;
      deliveries = deliveries.map((d) => ({ ts: new Date(d.ts.getTime() + delayMs), qty: d.qty }));
    }
    materialLedgers.set(materialId, new MaterialLedger(opening, deliveries));
  }

  const jobs: SimJob[] = [];
  const inventoryEvents: SimInventoryEvent[] = [];
  const shipments: { orderId: string; shippedQty: number; shipTs: Date }[] = [];
  const orderOutcomes: OrderOutcome[] = [];
  let machineCost = 0;
  let laborCost = 0;
  let overtimePremium = 0;
  let materialCost = 0;
  const globalConstraints = new Set<string>();

  for (const order of sequenced) {
    const route = (input.routesByProduct.get(order.productId) ?? []).slice().sort((a, b) => a.stepNo - b.stepNo);
    if (route.length === 0) {
      orderOutcomes.push({
        orderId: order.orderId,
        dueDate: order.dueDate,
        requestedQty: order.quantity,
        finalGoodQty: 0,
        plannedShipDate: null,
        lateDays: 0,
        feasible: false,
        bindingConstraints: ["no process route defined for this product"],
      });
      globalConstraints.add("missing process route");
      continue;
    }

    let qtyIn = order.quantity;
    let currentTime = snapshotTs;
    let blocked: string | null = null;

    for (const step of route) {
      const resolved = resolveEquipment(step.equipmentType, scenario, option, input.equipmentList);
      if (!resolved) {
        blocked = `no available "${step.equipmentType}" equipment for step ${step.stepNo}`;
        break;
      }

      let stepStartNotBefore = currentTime;
      if (step.stepNo === route[0].stepNo) {
        const bom = input.bomByProduct.get(order.productId) ?? [];
        for (const line of bom) {
          const ledger = materialLedgers.get(line.materialId);
          const neededQty = line.qtyPerUnit * qtyIn;
          if (!ledger) continue;
          const available = ledger.earliestAvailable(neededQty, stepStartNotBefore);
          if (!available) {
            blocked = `material ${line.materialId} cannot be supplied within the planning horizon`;
            break;
          }
          if (available.getTime() > stepStartNotBefore.getTime()) stepStartNotBefore = available;
        }
        if (blocked) break;
        for (const line of bom) {
          const ledger = materialLedgers.get(line.materialId);
          const neededQty = line.qtyPerUnit * qtyIn;
          ledger?.commit(neededQty);
          inventoryEvents.push({ materialId: line.materialId, qtyDelta: -neededQty, ts: stepStartNotBefore, reason: `consumption:${order.orderId}` });
          if (line.unitCost != null) materialCost += neededQty * line.unitCost;
        }
      }

      const scheduler = equipmentSchedulers.get(resolved.eq.id)!;
      const durationHours = (qtyIn * step.cycleTimeSec * resolved.cyclePenalty) / 3600;
      let allocation: { start: Date; end: Date; overtimeHours: number };
      try {
        allocation = scheduler.allocate(durationHours, stepStartNotBefore);
      } catch {
        blocked = `equipment ${resolved.eq.id} could not fit step ${step.stepNo} within the planning horizon`;
        break;
      }

      if (resolved.eq.ratePerHourCost != null) machineCost += durationHours * resolved.eq.ratePerHourCost;
      const normalHours = durationHours - allocation.overtimeHours;
      laborCost += normalHours * costConfig.laborRatePerHour;
      laborCost += allocation.overtimeHours * costConfig.laborRatePerHour; // straight-time base pay
      overtimePremium += allocation.overtimeHours * costConfig.laborRatePerHour * (costConfig.overtimeMultiplier - 1);

      let yieldPct = (step.expectedYieldPct ?? 97) / 100;
      if (scenario.type === "quality_urgent") {
        const defectRate = 1 - yieldPct;
        yieldPct = Math.max(0.5, 1 - defectRate * (scenario.defectMultiplier ?? 3));
      }
      yieldPct *= resolved.yieldPenalty;

      const goodQty = Math.round(qtyIn * yieldPct);
      const defectQty = Math.max(0, qtyIn - goodQty);
      jobs.push({
        orderId: order.orderId,
        stepNo: step.stepNo,
        equipmentId: resolved.eq.id,
        plannedStart: allocation.start,
        plannedEnd: allocation.end,
        qty: qtyIn,
        goodQty,
        defectQty,
        substituted: resolved.substituted,
      });

      currentTime = allocation.end;
      qtyIn = goodQty;
    }

    if (blocked) {
      globalConstraints.add(blocked);
      orderOutcomes.push({
        orderId: order.orderId,
        dueDate: order.dueDate,
        requestedQty: order.quantity,
        finalGoodQty: 0,
        plannedShipDate: null,
        lateDays: 0,
        feasible: false,
        bindingConstraints: [blocked],
      });
      continue;
    }

    const shipTs = new Date(currentTime.getTime() + SHIPPING_HANDLING_HOURS * 3_600_000);
    shipments.push({ orderId: order.orderId, shippedQty: qtyIn, shipTs });
    const lateDays = Math.max(0, (shipTs.getTime() - order.dueDate.getTime()) / 86_400_000);
    orderOutcomes.push({
      orderId: order.orderId,
      dueDate: order.dueDate,
      requestedQty: order.quantity,
      finalGoodQty: qtyIn,
      plannedShipDate: shipTs,
      lateDays,
      feasible: true,
      bindingConstraints: [],
    });
  }

  const goodUnitOutput = orderOutcomes.reduce((s, o) => s + o.finalGoodQty, 0);
  const shortageUnits = orderOutcomes.reduce((s, o) => s + Math.max(0, o.requestedQty - o.finalGoodQty), 0);
  const feasibleOutcomes = orderOutcomes.filter((o) => o.feasible);
  const onTimeCount = feasibleOutcomes.filter((o) => o.lateDays <= 0).length;
  const lateCount = feasibleOutcomes.filter((o) => o.lateDays > 0).length;
  const infeasibleCount = orderOutcomes.filter((o) => !o.feasible).length;

  return {
    jobs,
    inventoryEvents,
    shipments,
    orderOutcomes,
    kpis: {
      goodUnitOutput,
      shortageUnits,
      onTimeCount,
      lateCount,
      infeasibleCount,
      onTimeRate: feasibleOutcomes.length > 0 ? onTimeCount / feasibleOutcomes.length : null,
      totalLateDays: round2(feasibleOutcomes.reduce((s, o) => s + o.lateDays, 0)),
      maxLateDays: round2(feasibleOutcomes.reduce((m, o) => Math.max(m, o.lateDays), 0)),
      machineCost: round2(machineCost),
      laborCost: round2(laborCost),
      overtimePremium: round2(overtimePremium),
      materialCost: round2(materialCost),
      totalCost: round2(machineCost + laborCost + overtimePremium + materialCost),
    },
    feasibility: infeasibleCount === 0 ? "feasible" : "infeasible",
    bindingConstraints: Array.from(globalConstraints),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
