import { ResponseOptionConfig } from "./engine.js";

export const RESPONSE_OPTION_LABELS: Record<ResponseOptionConfig["type"], string> = {
  keep_current_plan: "Keep current plan",
  alt_equipment: "Use alternate equipment",
  overtime: "Add overtime",
  resequence: "Change job sequence (earliest due date first)",
};

export const ALL_RESPONSE_OPTIONS: ResponseOptionConfig[] = [
  { type: "keep_current_plan" },
  { type: "alt_equipment" },
  { type: "overtime", overtimeHoursPerDay: 4 },
  { type: "resequence" },
];
