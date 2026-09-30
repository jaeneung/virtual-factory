/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { api, fmt, fmtDate, usd } from "../api";
import { HBars, ModeBadge } from "../components/ui";

export function Simulation() {
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [scenario, setScenario] = useState("machine_down");
  const [seed, setSeed] = useState("42");
  const [snapshot, setSnapshot] = useState("");
  const [runId, setRunId] = useState("");
  const [options, setOptions] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/api/simulation/scenarios").then(setScenarios);
    api("/api/simulation/runs").then(setRuns);
    // Default the snapshot to the latest production data time so uploaded historical/sample data is simulated from where it ends.
    api("/api/overview/dimensions").then((d) => { if (d.dataRange?.max) setSnapshot(d.dataRange.max); });
  }, []);

  const loadRun = async (id: string) => {
    setRunId(id);
    if (!id) { setOptions(null); setDetail(null); return; }
    const [o, d] = await Promise.all([api(`/api/simulation/runs/${id}/options`), api(`/api/simulation/runs/${id}`)]);
    setOptions(o);
    setDetail(d);
  };

  const create = async () => {
    setBusy(true); setError("");
    try {
      const r = await api("/api/simulation/runs", { body: { name: `${scenario} (seed ${seed})`, scenario, seed: Number(seed), snapshotTs: snapshot.trim() || undefined } });
      setRuns(await api("/api/simulation/runs"));
      await loadRun(r.run.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const apply = async (optionType: string) => {
    setError("");
    try { await api(`/api/simulation/runs/${runId}/apply`, { body: { optionType } }); await loadRun(runId); } catch (e) { setError((e as Error).message); }
  };

  const opts: any[] = options?.options ?? [];
  const base = opts.find((o) => o.type === "keep_current_plan");
  const orderIds: string[] = base ? base.orderOutcomes.map((o: any) => o.orderId) : [];
  const applied = new Set<string>((detail?.plan.appliedOptions ?? []).map((h: any) => h.option_type));

  return (
    <div className="grid">
      <div className="banner b-sim" style={{ color: "var(--sim)" }}>
        <ModeBadge mode="SIMULATION" /> Virtual factory run from a snapshot of current data. Results are predictions stored separately from source records; they never change orders, due dates, or LIVE/REPLAY figures.
      </div>

      <div className="card">
        <h2>New simulation run</h2>
        <div className="filters">
          <label>Scenario<select value={scenario} onChange={(e) => setScenario(e.target.value)}>{scenarios.map((s) => <option key={s.type} value={s.type}>{s.label}</option>)}</select></label>
          <label>Random seed<input value={seed} onChange={(e) => setSeed(e.target.value)} size={8} /></label>
          <label>Snapshot time (UTC ISO, blank = now)<input value={snapshot} onChange={(e) => setSnapshot(e.target.value)} size={26} /></label>
          <button className="btn primary" disabled={busy} onClick={create}>Run scenario and compare options</button>
          <label>Previous runs<select value={runId} onChange={(e) => loadRun(e.target.value)}><option value="">Select…</option>{runs.map((r) => <option key={r.id} value={r.id}>{r.name} · {fmtDate(r.created_at)}</option>)}</select></label>
        </div>
        <div className="sub">Same seed + same snapshot ⇒ identical results. All options are evaluated against the identical snapshot, orders and seed.</div>
        {error && <div className="err">{error}</div>}
      </div>

      {options && (
        <>
          <div className="card">
            <h2>Response options — {scenarios.find((s) => s.type === options.scenario)?.label}</h2>
            <table>
              <thead><tr><th>Option</th><th>Feasible?</th><th className="num">Good units</th><th className="num">Shortage</th><th className="num">On-time / late</th><th className="num">Total days late</th><th className="num">Max days late</th><th className="num">Total cost</th><th className="num">Δ cost vs current</th><th /></tr></thead>
              <tbody>
                {opts.map((o) => {
                  const dLate = o.kpis.totalLateDays - base.kpis.totalLateDays;
                  return (
                    <tr key={o.type}>
                      <td><strong>{o.label}</strong>{o.type === "keep_current_plan" && <div className="sub">baseline</div>}</td>
                      <td>{o.feasibility === "feasible" ? <span className="ok">✓ yes</span> : <span className="err">✕ no</span>}
                        {o.bindingConstraints.map((c: string) => <div key={c} className="sub">binding: {c}</div>)}</td>
                      <td className="num">{fmt(o.kpis.goodUnitOutput)}</td>
                      <td className="num">{fmt(o.kpis.shortageUnits)}</td>
                      <td className="num">{o.kpis.onTimeCount} / {o.kpis.lateCount}{o.kpis.infeasibleCount ? ` (+${o.kpis.infeasibleCount} blocked)` : ""}</td>
                      <td className="num">{fmt(o.kpis.totalLateDays, 1)} {o.type !== "keep_current_plan" && <span className={dLate > 0.05 ? "err" : dLate < -0.05 ? "ok" : "sub"}>({dLate > 0 ? "+" : ""}{dLate.toFixed(1)})</span>}</td>
                      <td className="num">{fmt(o.kpis.maxLateDays, 1)}</td>
                      <td className="num">{usd(o.kpis.totalCost)}</td>
                      <td className="num">{o.type === "keep_current_plan" ? "—" : <span className={o.additionalCostVsBaseline > 0 ? "err" : ""}>{o.additionalCostVsBaseline > 0 ? "+" : ""}{usd(o.additionalCostVsBaseline)}</span>}
                        {o.kpis.overtimePremium > 0 && <div className="sub">incl. overtime premium {usd(o.kpis.overtimePremium)}</div>}</td>
                      <td>{o.type === "keep_current_plan" ? <span className="sub">current plan</span> : <button className="btn primary" disabled={applied.has(o.type)} onClick={() => apply(o.type)}>{applied.has(o.type) ? "Applied" : "Apply to virtual plan"}</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="sub" style={{ marginTop: 6 }}>
              Cost = machine run cost + labor + material + overtime premium (labor × (multiplier−1) on overtime hours). Alternate equipment assumes a substitute machine runs the step at 1.5× cycle time and 0.9× yield (no specialised tooling) and is used only when the specialist machine is down. Overtime adds 4 h/day of capacity. Resequencing orders by earliest due date ignores stated priority. Trade-offs are computed, not assumed — regressions show in red.
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card"><h2>Total days late (lower is better)</h2><HBars rows={opts.map((o) => ({ label: o.label.replace(/ \(.*/, ""), value: o.kpis.totalLateDays }))} /></div>
            <div className="card"><h2>Total cost (USD)</h2><HBars rows={opts.map((o) => ({ label: o.label.replace(/ \(.*/, ""), value: o.kpis.totalCost }))} unit=" USD" /></div>
          </div>

          <div className="card">
            <h2>Expected shipping date by order (original due date is never changed)</h2>
            <table>
              <thead><tr><th>Order</th><th>Due date</th>{opts.map((o) => <th key={o.type}>{o.label.replace(/ \(.*/, "")}</th>)}</tr></thead>
              <tbody>
                {orderIds.map((id) => {
                  const due = base.orderOutcomes.find((o: any) => o.orderId === id).dueDate;
                  return (
                    <tr key={id}>
                      <td>{id.startsWith("URGENT") ? "URGENT (injected)" : id}</td><td>{fmtDate(due)}</td>
                      {opts.map((o) => {
                        const r = o.orderOutcomes.find((x: any) => x.orderId === id);
                        return <td key={o.type}>{r?.plannedShipDate ? <>{fmtDate(r.plannedShipDate)}<div className={r.lateDays > 0 ? "err sub" : "ok sub"}>{r.lateDays > 0 ? `${r.lateDays.toFixed(1)} d late` : "on time"} · {fmt(r.finalGoodQty)}/{fmt(r.requestedQty)} units</div></> : <span className="err">blocked: {r?.bindingConstraints?.[0]}</span>}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2>Change history (virtual plan only)</h2>
              {(detail?.plan.appliedOptions ?? []).length === 0 ? <div className="sub">No options applied. The plan is the scenario’s current plan.</div> : (
                <table><tbody>{detail.plan.appliedOptions.map((h: any) => <tr key={h.id}><td>{h.option_type}</td><td className="sub">{fmtDate(h.applied_at)}</td></tr>)}</tbody></table>
              )}
              <div className="sub">An option can be applied to a run only once.</div>
            </div>
            <div className="card">
              <h2>Current virtual plan: jobs</h2>
              <div style={{ maxHeight: 260, overflow: "auto" }}>
                <table><thead><tr><th>Order</th><th>Step</th><th>Machine</th><th>Start</th><th>End</th></tr></thead>
                  <tbody>{(detail?.plan.jobs ?? []).map((j: any) => <tr key={j.id}><td>{j.order_id.startsWith("URGENT") ? "URGENT" : j.order_id}</td><td>{j.step_no}</td><td>{j.equipment_id}</td><td>{fmtDate(j.planned_start)}</td><td>{fmtDate(j.planned_end)}</td></tr>)}</tbody></table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
