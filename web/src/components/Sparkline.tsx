import { useState } from "react";

/** Single-series line: 2px stroke, recessive grid, hover crosshair + tooltip, min/max labels. */
export function Sparkline({ points }: { points: { x: number; y: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div className="sub">Not enough readings to draw a trend.</div>;
  const W = 520, H = 130, P = { l: 40, r: 10, t: 10, b: 18 };
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const sx = (x: number) => P.l + ((x - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const sy = (y: number) => H - P.b - ((y - y0) / (y1 - y0)) * (H - P.t - P.b);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const hp = hover != null ? points[hover] : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 560 }} role="img" aria-label="sensor trend"
      onMouseMove={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const x = x0 + (((e.clientX - r.left) / r.width) * W - P.l) / (W - P.l - P.r) * (x1 - x0);
        let best = 0;
        points.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(points[best].x - x)) best = i; });
        setHover(best);
      }}
      onMouseLeave={() => setHover(null)}>
      {[y0, (y0 + y1) / 2, y1].map((v) => (
        <g key={v}>
          <line x1={P.l} x2={W - P.r} y1={sy(v)} y2={sy(v)} stroke="var(--grid)" strokeWidth="1" />
          <text x={P.l - 4} y={sy(v) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{v.toFixed(1)}</text>
        </g>
      ))}
      <text x={P.l} y={H - 4} fontSize="10" fill="var(--muted)">{new Date(x0).toLocaleDateString()}</text>
      <text x={W - P.r} y={H - 4} textAnchor="end" fontSize="10" fill="var(--muted)">{new Date(x1).toLocaleDateString()}</text>
      <path d={d} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {hp && (
        <g>
          <line x1={sx(hp.x)} x2={sx(hp.x)} y1={P.t} y2={H - P.b} stroke="var(--axis)" />
          <circle cx={sx(hp.x)} cy={sy(hp.y)} r="4" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
          <text x={Math.min(sx(hp.x) + 6, W - 130)} y={P.t + 10} fontSize="11" fill="var(--ink)">{hp.y} · {new Date(hp.x).toLocaleString()}</text>
        </g>
      )}
    </svg>
  );
}
