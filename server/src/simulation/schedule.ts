/**
 * Coarse-grained forward scheduler primitives. Equipment capacity is modeled as a daily
 * window starting at 06:00 UTC of length `capacity.extended` hours (matching the sample
 * data's 06:00 shift start); hours beyond `capacity.base` within that window are "overtime"
 * and reported separately so the engine can cost them at the overtime rate. This is a
 * deliberate simplification (no exact shift calendars, no per-minute granularity) —
 * documented in docs/ASSUMPTIONS.md — appropriate for comparing response options, not for
 * dispatching real work orders.
 */

export interface DayCapacity {
  base: number;
  extended: number;
}

const SHIFT_START_HOUR = 6;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MAX_HORIZON_DAYS = 90;

function dayWindowStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), SHIFT_START_HOUR, 0, 0));
  if (date.getTime() < d.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

export class EquipmentScheduler {
  private cursor: Date;
  private dayUsage = new Map<number, number>(); // dayWindowStart epoch -> hours used so far

  constructor(
    startAt: Date,
    private readonly capacityFn: (dayWindowStartDate: Date) => DayCapacity
  ) {
    this.cursor = new Date(startAt);
  }

  get nextFreeAt(): Date {
    return new Date(this.cursor);
  }

  /** Allocates `durationHours` of work no earlier than `notBefore`. Returns the actual
   *  [start,end) and how many of those hours fell in the overtime band. Throws if the
   *  horizon is exceeded (treated by the engine as an infeasible schedule). */
  allocate(durationHours: number, notBefore?: Date): { start: Date; end: Date; overtimeHours: number } {
    let t = new Date(Math.max(this.cursor.getTime(), notBefore?.getTime() ?? 0));
    const horizonLimit = new Date(this.cursor.getTime() + MAX_HORIZON_DAYS * MS_PER_DAY);
    let remaining = durationHours;
    let overtimeHours = 0;
    const start = new Date(t);

    while (remaining > 1e-9) {
      if (t > horizonLimit) throw new Error("scheduling horizon exceeded");
      const winStart = dayWindowStart(t);
      const cap = this.capacityFn(winStart);
      const winEnd = new Date(winStart.getTime() + cap.extended * MS_PER_HOUR);

      if (t < winStart) {
        t = winStart;
        continue;
      }
      if (t >= winEnd || cap.extended <= 0) {
        t = new Date(winStart.getTime() + MS_PER_DAY); // next day's window
        continue;
      }

      const usedSoFar = this.dayUsage.get(winStart.getTime()) ?? Math.max(0, (t.getTime() - winStart.getTime()) / MS_PER_HOUR);
      const availableNow = cap.extended - usedSoFar;
      const use = Math.min(availableNow, remaining);
      if (use <= 1e-9) {
        t = new Date(winStart.getTime() + MS_PER_DAY);
        continue;
      }

      const normalRemaining = Math.max(0, cap.base - usedSoFar);
      const overtimePortion = Math.max(0, use - normalRemaining);
      overtimeHours += overtimePortion;

      this.dayUsage.set(winStart.getTime(), usedSoFar + use);
      t = new Date(t.getTime() + use * MS_PER_HOUR);
      remaining -= use;
    }

    this.cursor = new Date(t);
    return { start, end: t, overtimeHours };
  }
}

/** Tracks a material's running committed balance against opening stock + scheduled future
 *  deliveries, so concurrent orders competing for the same material are served in the order
 *  they're scheduled (first-committed-first-served) rather than all optimistically assuming
 *  the same stock is free. */
export class MaterialLedger {
  private allocated = 0;
  private readonly deliveries: { ts: number; qty: number }[];

  constructor(
    private readonly openingStock: number,
    deliveries: { ts: Date; qty: number }[]
  ) {
    this.deliveries = deliveries.map((d) => ({ ts: d.ts.getTime(), qty: d.qty })).sort((a, b) => a.ts - b.ts);
  }

  private cumulativeAvailableAt(t: number): number {
    let total = this.openingStock;
    for (const d of this.deliveries) {
      if (d.ts <= t) total += d.qty;
    }
    return total;
  }

  /** Returns the earliest time at which `qty` additional units can be committed on top of
   *  everything already reserved, or null if it can never be satisfied within the horizon. */
  earliestAvailable(qty: number, notBefore: Date): Date | null {
    const needed = this.allocated + qty;
    if (this.cumulativeAvailableAt(notBefore.getTime()) >= needed) return notBefore;
    for (const d of this.deliveries) {
      if (d.ts <= notBefore.getTime()) continue;
      if (this.cumulativeAvailableAt(d.ts) >= needed) return new Date(d.ts);
    }
    return null;
  }

  commit(qty: number): void {
    this.allocated += qty;
  }
}
