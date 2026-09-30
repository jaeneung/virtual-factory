import { Router } from "express";
import { newId } from "../util/id.js";
import { seedFromString, mulberry32 } from "../util/rng.js";
import { buildFactorySnapshot } from "../simulation/snapshot.js";
import { buildScenario, ScenarioType, SCENARIO_LABELS } from "../simulation/scenarios.js";
import { RESPONSE_OPTION_LABELS, ALL_RESPONSE_OPTIONS } from "../simulation/responseOptions.js";
import { evaluateOption, evaluateAllOptions } from "../simulation/compare.js";
import { createRun, getRun, listRuns, applyPlanToRun, saveResult, recordOptionHistory, getResults, getCurrentPlan } from "../simulation/simRepo.js";

export const simulationRouter = Router();

simulationRouter.get("/scenarios", (_req, res) => {
  res.json(Object.entries(SCENARIO_LABELS).map(([type, label]) => ({ type, label })));
});

simulationRouter.get("/response-options", (_req, res) => {
  res.json(Object.entries(RESPONSE_OPTION_LABELS).map(([type, label]) => ({ type, label })));
});

simulationRouter.get("/runs", (_req, res) => {
  res.json(listRuns());
});

simulationRouter.post("/runs", (req, res) => {
  try {
    const { name, scenario, seed, snapshotTs: snapshotTsInput } = req.body as { name: string; scenario: ScenarioType; seed?: number; snapshotTs?: string };
    if (!name || !scenario) return res.status(400).json({ error: "name and scenario are required" });
    if (!(scenario in SCENARIO_LABELS)) return res.status(400).json({ error: `unknown scenario: ${scenario}` });

    const runId = newId("run");
    const snapshotTs = snapshotTsInput ? new Date(snapshotTsInput) : new Date();
    if (Number.isNaN(snapshotTs.getTime())) return res.status(400).json({ error: "snapshotTs must be a valid ISO timestamp" });
    const runSeed = seed ?? seedFromString(runId);
    const baseSnapshot = buildFactorySnapshot(snapshotTs);
    const scenarioCfg = buildScenario(scenario, baseSnapshot, runId, mulberry32(runSeed));
    const orders = scenarioCfg.urgentOrder ? [...baseSnapshot.orders, scenarioCfg.urgentOrder] : baseSnapshot.orders;

    const run = createRun(name, scenario, runSeed, snapshotTs, orders, runId);

    const initial = evaluateOption(run, "keep_current_plan");
    applyPlanToRun(run.id, "keep_current_plan", initial);
    saveResult(run.id, "keep_current_plan", initial);

    res.status(201).json({ run: getRun(run.id), initialResult: { kpis: initial.kpis, feasibility: initial.feasibility, bindingConstraints: initial.bindingConstraints } });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

simulationRouter.get("/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "not found" });
  res.json({ run, plan: getCurrentPlan(run.id), results: getResults(run.id) });
});

simulationRouter.get("/runs/:id/options", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "not found" });
  const evaluated = evaluateAllOptions(run);
  const appliedTypes = new Set((getCurrentPlan(run.id).appliedOptions as { option_type: string }[]).map((h) => h.option_type));
  const options = ALL_RESPONSE_OPTIONS.map((opt) => ({
    type: opt.type,
    label: RESPONSE_OPTION_LABELS[opt.type],
    alreadyApplied: appliedTypes.has(opt.type),
    kpis: evaluated[opt.type].kpis,
    additionalCostVsBaseline: Math.round((evaluated[opt.type].kpis.totalCost - evaluated.keep_current_plan.kpis.totalCost) * 100) / 100,
    feasibility: evaluated[opt.type].feasibility,
    bindingConstraints: evaluated[opt.type].bindingConstraints,
    orderOutcomes: evaluated[opt.type].orderOutcomes,
  }));
  res.json({ runId: run.id, scenario: run.scenario, options });
});

simulationRouter.post("/runs/:id/apply", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "not found" });
  const { optionType } = req.body as { optionType: string };
  if (!ALL_RESPONSE_OPTIONS.some((o) => o.type === optionType)) return res.status(400).json({ error: `unknown option: ${optionType}` });

  const historyResult = recordOptionHistory(run.id, optionType, req.body.params ?? {});
  if (!historyResult.ok) return res.status(409).json({ error: historyResult.reason });

  const result = evaluateOption(run, optionType);
  applyPlanToRun(run.id, optionType, result);
  saveResult(run.id, optionType, result);
  res.json({ run: getRun(run.id), plan: getCurrentPlan(run.id), result: { kpis: result.kpis, feasibility: result.feasibility, bindingConstraints: result.bindingConstraints } });
});
