/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt, fmtDate, usd } from "../api";
import { Health, HBars, KpiTile, ModeBadge, Section } from "../components/ui";
import { Sparkline } from "../components/Sparkline";

type Filters = { factoryId: string; lineId: string; equipmentId: string; productId: string; from: string; to: string };
const EMPTY: Filters = { factoryId: "", lineId: "", equipmentId: "", productId: "", from: "", to: "" };

function qs(f: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}

export function Overview({ replaySessionId }: { replaySessionId?: string }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [dims, setDims] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [sensor, setSensor] = useState<{ equipmentId: string; metric: string } | null>(null);
  const [integrity, setIntegrity] = useState<any>(null);
  const mode = replaySessionId ? "REPLAY" : "LIVE";

  useEffect(() => {
    api("/api/overview/dimensions").then(setDims).catch((e) => setError(e.message));
  }, []);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const load = useCallback(async () => {
    try {
      const f = filtersRef.current;
      const extra = replaySessionId ? { mode: "replay", replaySessionId } : {};
      const [ov, src] = await Promise.all([api(`/api/overview?${qs({ ...f, ...extra })}`), api("/api/overview/sources")]);
      setData(ov);
      setSources(src);
      setUpdatedAt(new Date());
      setError("");
    } catch (e) {
      // Keep the last good data on screen; only the banner changes.
      setError((e as Error).message);
    }
  }, [replaySessionId]);

  useEffect(() => {
    void load();
  }, [load, filters]);

  // One SSE subscription per mounted overview; closed on unmount/reconnect so none accumulate.
  useEffect(() => {
    const topics = replaySessionId ? `overview,replay:${replaySessionId}` : "overview";
    const es = new EventSource(`/api/stream?topics=${encodeURIComponent(topics)}`);
    let timer: number | undefined;
    const kick = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    };
    es.addEventListener("change", kick);
    es.addEventListener("tick", kick);
    const fallback = window.setInterval(() => void load(), 15000);
    return () => {
      es.close();
      window.clearInterval(fallback);
      window.clearTimeout(timer);
    };
  }, [load, replaySessionId]);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const linesFor = dims?.lines.filter((l: any) => !filters.factoryId || l.factory_id === filters.factoryId) ?? [];
  const eqFor = dims?.equipment.filter((e: any) => (!filters.factoryId || e.factory_id === filters.factoryId) && (!filters.lineId || e.line_id === filters.lineId)) ?? [];

  if (!data) return <div className="card">{error ? <span className="err">{error}</span> : "Loading…"}</div>;
  const k = data.kpis;
  const p = data.production;
  const q = data.quality;
  const eq = data.equipment;
  const sc = data.supplyChain;
  const dl = data.delivery;
  const cost = data.costs;

  return (
    <div className="grid">
      <div className="row">
        <ModeBadge mode={mode} />
        <span className="sub">
          {mode === "REPLAY"
            ? `Historical replay as of ${fmtDate(data.asOf)} — uploaded history, not live data.`
            : "Data from uploads and polled APIs. Updates arrive when sources are collected (polling), not as a millisecond stream."}
        </span>
        <span className="sub">View refreshed {updatedAt?.toLocaleTimeString()}</span>
      </div>
      {error && <div className="banner err">Refresh failed ({error}). Showing the last successfully loaded values — they may be stale.</div>}

      <SourceStrip sources={sources} />

      <div className="filters">
        <label>Factory<select value={filters.factoryId} onChange={set("factoryId")}><option value="">All</option>{dims?.factories.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>Line<select value={filters.lineId} onChange={set("lineId")}><option value="">All</option>{linesFor.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>Equipment<select value={filters.equipmentId} onChange={set("equipmentId")}><option value="">All</option>{eqFor.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>Product<select value={filters.productId} onChange={set("productId")}><option value="">All</option>{dims?.products.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>From (UTC)<input type="date" value={filters.from.slice(0, 10)} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value ? `${e.target.value}T00:00:00Z` : "" }))} /></label>
        <label>To (UTC)<input type="date" value={filters.to.slice(0, 10)} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value ? `${e.target.value}T23:59:59Z` : "" }))} /></label>
        <button className="btn" onClick={() => setFilters(EMPTY)}>Reset filters</button>
      </div>

      <div className="grid cols-kpi">
        <KpiTile label="On-time delivery" kpi={k.onTimeDeliveryRate} format={(v) => `${(v * 100).toFixed(1)}%`} note={k.onTimeDeliveryRate.available ? `${k.onTimeDeliveryRate.numerator} of ${k.onTimeDeliveryRate.denominator} shipments` : undefined} />
        <KpiTile label="Good-unit output" kpi={k.goodUnitOutput} format={(v) => fmt(v)} note="final-step good units" />
        <KpiTile label="Defect rate" kpi={k.defectRate} format={(v) => `${(v * 100).toFixed(2)}%`} note={k.defectRate.available ? `${fmt(k.defectRate.numerator)} / ${fmt(k.defectRate.denominator)} inspected` : undefined} />
        <KpiTile label="Unplanned downtime" kpi={k.unplannedDowntimeHours} format={(v) => `${v.toFixed(1)} h`} note={k.unplannedDowntimeHours.available ? `${k.unplannedDowntimeHours.numerator} interval(s)` : undefined} />
        <KpiTile label="Operating cost" kpi={k.totalOperatingCost} format={usd} note="machine + labor + material" />
      </div>

      <div className="grid cols-2">
        <Section title="Production — planned vs actual">
          <HBars rows={[{ label: "Planned (orders due)", value: p.plannedOutputUnits }, { label: "Actual good units", value: p.actualGoodUnits }, { label: "Defective units", value: p.actualDefectUnits }]} />
          <div className="sub">Plan basis: {p.plannedOutputBasis}. Lots produced: {p.lotsProduced}.</div>
          <h2 style={{ marginTop: 10 }}>Active jobs (machine currently running)</h2>
          {p.activeJobs.length === 0 ? <div className="sub">None reported running.</div> : (
            <table><tbody>{p.activeJobs.map((j: any) => <tr key={j.equipmentId}><td>{j.equipmentName}</td><td className="sub">since {fmtDate(j.runningSince)}</td></tr>)}</tbody></table>
          )}
        </Section>

        <Section title="Quality (inspections)">
          <div className="big">{q.defectRateAvailable ? `${(q.defectRate * 100).toFixed(2)}%` : <span className="muted">Unavailable</span>}</div>
          <div className="sub">Defect categories (units)</div>
          <HBars rows={q.defectCategories.map((c: any) => ({ label: c.category, value: c.qty }))} />
          <h2 style={{ marginTop: 10 }}>At-risk lots <span className="sub">(rule-based baseline, not AI)</span></h2>
          {q.atRiskLots.length === 0 ? <div className="sub">None flagged.</div> : (
            <table><thead><tr><th>Lot</th><th className="num">Defect rate</th><th className="num">Product baseline</th></tr></thead>
              <tbody>{q.atRiskLots.slice(0, 8).map((l: any) => <tr key={l.lotId}><td>{l.lotId}</td><td className="num">{(l.defectRate * 100).toFixed(1)}%</td><td className="num">{(l.productBaselineDefectRate * 100).toFixed(1)}%</td></tr>)}</tbody></table>
          )}
        </Section>

        <Section title="Equipment">
          <div className="row">
            {(["running", "stopped", "maintenance", "unknown"] as const).map((s) => <span key={s} className="badge b-unknown" style={{ color: s === "running" ? "var(--good-text)" : s === "stopped" ? "var(--critical)" : s === "maintenance" ? "var(--replay)" : "var(--muted)" }}>{s}: {eq.counts[s]}</span>)}
          </div>
          <table><thead><tr><th>Machine</th><th>State</th></tr></thead>
            <tbody>{eq.details.map((d: any) => <tr key={d.equipmentId}><td>{d.name}</td><td>{d.state}{d.state === "unknown" && <span className="sub"> (no state data covers this time)</span>}</td></tr>)}</tbody></table>
          <h2 style={{ marginTop: 10 }}>Sensor anomalies <span className="sub">(rule-based z-score baseline, not AI)</span></h2>
          <table><thead><tr><th>Machine</th><th>Metric</th><th className="num">Latest</th><th className="num">z</th><th /></tr></thead>
            <tbody>{eq.anomalies.map((a: any) => (
              <tr key={a.equipmentId + a.metric}>
                <td>{a.equipmentId}</td><td>{a.metric}</td><td className="num">{a.latestValue}</td><td className="num">{a.zScore ?? "—"}</td>
                <td>{a.anomalous ? <span className="badge b-failed">⚠ anomalous</span> : <span className="sub">normal</span>} <button className="btn" onClick={() => setSensor({ equipmentId: a.equipmentId, metric: a.metric })}>trend</button></td>
              </tr>))}</tbody></table>
          {sensor && <SensorTrend {...sensor} asOf={replaySessionId ? data.asOf : undefined} onClose={() => setSensor(null)} />}
        </Section>

        <Section title="Supply chain">
          <h2>Material shortages (next {sc.shortageLookaheadDays} days of open-order demand)</h2>
          {sc.materialShortages.length === 0 ? <div className="sub">No shortages projected.</div> : (
            <table><thead><tr><th>Material</th><th className="num">Stock</th><th className="num">Demand</th><th className="num">Incoming</th><th className="num">Short</th></tr></thead>
              <tbody>{sc.materialShortages.map((m: any) => <tr key={m.materialId}><td>{m.materialName}</td><td className="num">{fmt(m.currentStock)}</td><td className="num">{fmt(m.projectedDemand)}</td><td className="num">{fmt(m.incomingBeforeNeed)}</td><td className="num err">{fmt(m.shortageQty)}</td></tr>)}</tbody></table>
          )}
          <h2 style={{ marginTop: 10 }}>Delayed receipts</h2>
          {sc.delayedReceipts.length === 0 ? <div className="sub">None.</div> : (
            <table><tbody>{sc.delayedReceipts.map((d: any) => <tr key={d.id}><td>{d.material_name}</td><td>{d.supplier_name}</td><td className="sub">expected {fmtDate(d.expected_date)}, not received</td></tr>)}</tbody></table>
          )}
          <div className="sub" style={{ marginTop: 6 }}>Orders affected by shortages: {sc.affectedOrders.map((o: any) => <button key={o.id} className="btn" style={{ padding: "0 6px", marginRight: 4 }} onClick={() => setOrderId(o.id)}>{o.id}</button>)}{sc.affectedOrders.length === 0 && "none"}</div>
        </Section>

        <Section title="Delivery — at-risk orders">
          <div className="sub">{dl.openOrderCount} open orders; {dl.atRiskOrders.length} at risk. Ship dates are estimates from trailing throughput, not commitments.</div>
          <table><thead><tr><th>Order</th><th>Due</th><th>Est. ship</th><th className="num">Remaining</th><th>Why</th></tr></thead>
            <tbody>{dl.atRiskOrders.map((o: any) => (
              <tr key={o.orderId}>
                <td><button className="btn" style={{ padding: "0 6px" }} onClick={() => setOrderId(o.orderId)}>{o.orderId}</button></td>
                <td>{fmtDate(o.dueDate)}</td><td>{o.projectedShipDate ? fmtDate(o.projectedShipDate) : "Unavailable"}</td><td className="num">{fmt(o.remainingQty)}</td>
                <td className="sub">{o.atRiskDueToMaterialShortage ? "material shortage; " : ""}{o.projectedShipDate && o.projectedShipDate > o.dueDate ? "projected after due date" : o.projectedShipDate ? "" : o.projectedBasis}</td>
              </tr>))}</tbody></table>
        </Section>

        <Section title="Costs (calculable operating cost)">
          <table><tbody>
            <tr><td>Machine run cost</td><td className="num">{usd(cost.machineCost)}</td></tr>
            <tr><td>Labor</td><td className="num">{usd(cost.laborCost)}</td></tr>
            <tr><td>Material (first-step consumption)</td><td className="num">{usd(cost.materialCost)}</td></tr>
            <tr><th>Total</th><th className="num">{usd(cost.totalCost)}</th></tr>
          </tbody></table>
          {cost.excluded.map((e: any, i: number) => <div key={i} className="warn-box">Excluded: {e.context} — {e.reason}</div>)}
          <div className="sub">Scenario cost estimates are shown in the Simulation tab (SIMULATION mode), never mixed into these actuals.</div>
        </Section>

        <Section title="Process relationships">
          <table><tbody>
            <tr><td>Orders with production</td><td className="num">{data.relationships.ordersInvolved}</td></tr>
            <tr><td>Machines involved</td><td className="num">{data.relationships.equipmentInvolved}</td></tr>
            <tr><td>Production lots</td><td className="num">{data.relationships.lotsInvolved}</td></tr>
            <tr><td>Materials in BOMs</td><td className="num">{data.relationships.materialsInvolved}</td></tr>
            <tr><td>Inspections</td><td className="num">{data.relationships.inspectionsTotal}</td></tr>
            <tr><td>Shipments</td><td className="num">{data.relationships.shipmentsTotal}</td></tr>
          </tbody></table>
          <div className="sub">Open an order above for the full trace. </div>
          <button className="btn" onClick={() => api("/api/overview/integrity").then(setIntegrity)}>Run data-integrity check</button>
          {integrity && (
            <div style={{ marginTop: 6 }}>
              <span className={integrity.ok ? "ok" : "err"}>{integrity.ok ? "✓ No integrity errors" : "✕ Integrity errors found"}</span>
              {integrity.issues.slice(0, 6).map((i: any, idx: number) => <div key={idx} className="warn-box">{i.severity}: {i.message}</div>)}
            </div>
          )}
        </Section>
      </div>

      {orderId && <OrderDetail orderId={orderId} onClose={() => setOrderId(null)} />}
    </div>
  );
}

function SourceStrip({ sources }: { sources: any[] }) {
  return (
    <div className="card">
      <h2>Data sources</h2>
      <table>
        <thead><tr><th>Source</th><th>Mode</th><th>Connection</th><th>Last successful ingestion</th><th>Latest source timestamp</th><th className="num">Refresh</th><th className="num">Lag</th><th>Status</th></tr></thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id}>
              <td>{s.label}</td><td><ModeBadge mode={s.mode} /></td><td>{s.connectionStatus}</td>
              <td>{fmtDate(s.lastSuccessfulIngestionAt)}</td><td>{fmtDate(s.latestSourceTimestamp)}</td>
              <td className="num">{s.refreshIntervalSec ? `${s.refreshIntervalSec}s poll` : "on upload"}</td>
              <td className="num">{s.lagSeconds == null ? "—" : `${s.lagSeconds}s`}</td>
              <td><Health h={s.health} />{s.health === "failed" && <span className="sub"> last values are stale</span>}{s.health === "stale" && <span className="sub"> values older than 3× interval</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SensorTrend({ equipmentId, metric, asOf, onClose }: { equipmentId: string; metric: string; asOf?: string; onClose: () => void }) {
  const [rows, setRows] = useState<{ value: number; source_ts: string }[]>([]);
  useEffect(() => {
    api(`/api/overview/sensor-trend?${qs({ equipmentId, metric, asOf })}`).then(setRows);
  }, [equipmentId, metric, asOf]);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row"><strong>{equipmentId} · {metric}</strong><button className="btn" onClick={onClose}>close</button></div>
      <Sparkline points={rows.map((r) => ({ x: new Date(r.source_ts).getTime(), y: r.value }))} />
    </div>
  );
}

function OrderDetail({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [t, setT] = useState<any>(null);
  useEffect(() => {
    api(`/api/overview/orders/${orderId}/trace`).then(setT);
  }, [orderId]);
  if (!t) return null;
  const shipped = t.shipments.reduce((s: number, x: any) => s + x.shipped_qty, 0);
  return (
    <div className="card" style={{ border: "2px solid var(--series-1)" }}>
      <div className="row"><h2 style={{ margin: 0 }}>Order {t.order.id} — trace</h2><button className="btn" onClick={onClose}>close</button></div>
      <div className="sub">Product {t.order.product_id} · qty {fmt(t.order.quantity)} · due {fmtDate(t.order.due_date)} · shipped so far {fmt(shipped)}</div>
      <div className="grid cols-2">
        <div><h2>Materials (BOM)</h2><table><tbody>{t.materials.map((m: any) => <tr key={m.material_id}><td>{m.material_name}</td><td className="num">{m.qty_per_unit}/unit</td></tr>)}</tbody></table></div>
        <div><h2>Equipment used</h2><table><tbody>{t.equipment.map((e: any) => <tr key={e.id}><td>{e.name}</td><td className="sub">{e.equipment_type}</td></tr>)}</tbody></table></div>
        <div><h2>Production lots</h2><table><thead><tr><th>Lot</th><th>Step</th><th>Machine</th><th className="num">Good</th><th className="num">Defect</th></tr></thead>
          <tbody>{t.production.map((p: any) => <tr key={p.id}><td>{p.lot_id}</td><td>{p.step_no}</td><td>{p.equipment_name}</td><td className="num">{p.good_qty}</td><td className="num">{p.defect_qty}</td></tr>)}</tbody></table></div>
        <div><h2>Inspections</h2><table><thead><tr><th>Lot</th><th>Result</th><th className="num">Defects</th><th>Category</th></tr></thead>
          <tbody>{t.inspections.map((i: any) => <tr key={i.id}><td>{i.lot_id}</td><td>{i.result}</td><td className="num">{i.defect_qty}/{i.inspected_qty}</td><td>{i.defect_category ?? "—"}</td></tr>)}</tbody></table></div>
        <div><h2>Shipments</h2>{t.shipments.length === 0 ? <div className="sub">Not shipped yet.</div> : <table><tbody>{t.shipments.map((s: any) => <tr key={s.id}><td>{s.id}</td><td>{fmtDate(s.ship_ts)}</td><td className="num">{s.shipped_qty}</td></tr>)}</tbody></table>}</div>
      </div>
    </div>
  );
}

export { Health };
