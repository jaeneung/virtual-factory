import { useState, ReactNode } from "react";
import { Kpi, fmt } from "../api";

export function ModeBadge({ mode }: { mode: "LIVE" | "REPLAY" | "SIMULATION" }) {
  const cls = mode === "LIVE" ? "b-live" : mode === "REPLAY" ? "b-replay" : "b-sim";
  const icon = mode === "LIVE" ? "●" : mode === "REPLAY" ? "⏪" : "◇";
  return (
    <span className={`badge ${cls}`}>
      {icon} {mode}
    </span>
  );
}

export function Health({ h }: { h: string }) {
  const icon = h === "healthy" ? "✓" : h === "stale" ? "⏳" : h === "failed" ? "✕" : "?";
  return (
    <span className={`badge b-${h}`}>
      {icon} {h}
    </span>
  );
}

export function KpiTile({ label, kpi, format, note }: { label: string; kpi: Kpi & { excluded?: unknown[] }; format: (v: number) => string; note?: string }) {
  return (
    <div className="card">
      <h2>{label}</h2>
      {kpi.available ? (
        <>
          <div className="big">{format(kpi.value)}</div>
          <div className="sub">{note ?? `${fmt(kpi.numerator, 2)} / ${fmt(kpi.denominator, 2)}`}</div>
          {kpi.excluded && kpi.excluded.length > 0 && <div className="sub">⚠ {kpi.excluded.length} input(s) excluded (missing cost data)</div>}
        </>
      ) : (
        <>
          <div className="big muted">Unavailable</div>
          <div className="sub">{kpi.reason}</div>
        </>
      )}
    </div>
  );
}

/** Single-series horizontal bars: value labels on every bar, per-bar hover tooltip. */
export function HBars({ rows, unit = "" }: { rows: { label: string; value: number }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  if (rows.length === 0) return <div className="sub">No data in this window.</div>;
  return (
    <div role="img" aria-label="bar chart">
      {rows.map((r) => (
        <div
          className="bar-row"
          key={r.label}
          onMouseMove={(e) => setTip({ x: e.clientX + 12, y: e.clientY + 12, text: `${r.label}: ${fmt(r.value, 2)}${unit}` })}
          onMouseLeave={() => setTip(null)}
        >
          <span>{r.label}</span>
          <div>
            <div className="bar" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span style={{ textAlign: "right" }}>{fmt(r.value, 1)}</span>
        </div>
      ))}
      {tip && (
        <div className="tt" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
