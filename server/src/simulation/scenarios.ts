import { ScenarioConfig, VirtualOrder } from "./engine.js";
import { FactorySnapshot } from "./snapshot.js";

export type ScenarioType = ScenarioConfig["type"];

export const SCENARIO_LABELS: Record<ScenarioType, string> = {
  normal: "Normal operations",
  delayed_material: "Delayed material delivery",
  machine_down: "One critical machine becomes unavailable",
  quality_urgent: "Increased defects combined with an urgent order",
};

/**
 * Resolves a scenario type into concrete parameters against the current snapshot, so the
 * demo generalizes beyond the hardcoded sample IDs. "Critical machine" = the equipment used
 * by the most process-route steps (most products depend on it). "Material at risk" = the
 * material with the soonest not-yet-received expected delivery (a real supply risk in the
 * uploaded data, not an arbitrary pick).
 */
export function buildScenario(type: ScenarioType, snapshot: FactorySnapshot, runId: string, rand: () => number): ScenarioConfig {
  if (type === "normal") return { type: "normal" };

  if (type === "delayed_material") {
    // Pick the material whose open-order demand most exceeds current stock and that has an
    // incoming delivery — i.e. one the plan actually depends on. Falls back to the soonest delivery.
    const demand = new Map<string, number>();
    for (const o of snapshot.orders) {
      for (const line of snapshot.bomByProduct.get(o.productId) ?? []) {
        demand.set(line.materialId, (demand.get(line.materialId) ?? 0) + line.qtyPerUnit * o.quantity);
      }
    }
    let pick: string | null = null;
    let bestDeficit = 0;
    let soonest: string | null = null;
    let soonestTs = Infinity;
    for (const [materialId, deliveries] of snapshot.materialDeliveries.entries()) {
      if (deliveries.length === 0) continue;
      const deficit = (demand.get(materialId) ?? 0) - (snapshot.materialOpeningStock.get(materialId) ?? 0);
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        pick = materialId;
      }
      for (const d of deliveries) {
        if (d.ts.getTime() < soonestTs) {
          soonestTs = d.ts.getTime();
          soonest = materialId;
        }
      }
    }
    return { type, delayedMaterialId: pick ?? soonest ?? undefined, delayDays: 5 };
  }

  if (type === "machine_down") {
    const usageCount = new Map<string, number>();
    for (const routes of snapshot.routesByProduct.values()) {
      for (const step of routes) {
        for (const eq of snapshot.equipmentList) {
          if (eq.equipmentType === step.equipmentType) usageCount.set(eq.id, (usageCount.get(eq.id) ?? 0) + 1);
        }
      }
    }
    const busiest = Array.from(usageCount.entries()).sort((a, b) => b[1] - a[1])[0];
    return { type, downEquipmentId: busiest?.[0], downDays: 3 };
  }

  // quality_urgent
  const anyProduct = snapshot.orders[0]?.productId ?? Array.from(snapshot.routesByProduct.keys())[0];
  const urgentOrder: VirtualOrder | undefined = anyProduct
    ? {
        orderId: `URGENT-${runId}`,
        productId: anyProduct,
        quantity: Math.round(500 + rand() * 300),
        dueDate: new Date(snapshot.snapshotTs.getTime() + 2 * 86_400_000),
        priority: 0,
      }
    : undefined;
  return { type, defectMultiplier: 3, urgentOrder };
}
