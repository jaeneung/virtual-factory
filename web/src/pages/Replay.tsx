/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate } from "../api";
import { ModeBadge } from "../components/ui";
import { Overview } from "./Overview";

const SPEEDS = [
  { label: "1 h / s", v: 3600 },
  { label: "6 h / s", v: 21600 },
  { label: "1 day / s", v: 86400 },
  { label: "3 days / s", v: 259200 },
];

export function Replay() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [id, setId] = useState<string>("");
  const [session, setSession] = useState<any>(null);
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [error, setError] = useState("");

  const loadSessions = useCallback(async () => {
    const list = await api("/api/replay");
    setSessions(list);
    return list;
  }, []);

  useEffect(() => {
    void loadSessions();
    api("/api/overview/dimensions").then((d) => {
      if (d.dataRange?.min) setRange({ from: d.dataRange.min.slice(0, 10), to: new Date(new Date(d.dataRange.max).getTime() + 86400000).toISOString().slice(0, 10) });
    });
  }, [loadSessions]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/stream?topics=replay:${id}`);
    es.addEventListener("tick", () => api(`/api/replay/${id}`).then(setSession));
    api(`/api/replay/${id}`).then(setSession);
    return () => es.close();
  }, [id]);

  const call = async (path: string, body?: unknown) => {
    try { setSession(await api(`/api/replay/${id}/${path}`, { method: "POST", body })); setError(""); } catch (e) { setError((e as Error).message); }
  };

  const create = async () => {
    try {
      const s = await api("/api/replay", { body: { name: `Replay ${range.from} → ${range.to}`, rangeFrom: `${range.from}T00:00:00Z`, rangeTo: `${range.to}T00:00:00Z`, speed: 86400 } });
      await loadSessions();
      setId(s.id);
    } catch (e) { setError((e as Error).message); }
  };

  const pct = session ? Math.round(((new Date(session.cursor_ts).getTime() - new Date(session.range_from).getTime()) / (new Date(session.range_to).getTime() - new Date(session.range_from).getTime())) * 100) : 0;

  return (
    <div className="grid">
      <div className="card">
        <div className="row"><ModeBadge mode="REPLAY" /><strong>Historical replay</strong></div>
        <div className="sub">Replays uploaded history chronologically over the same source data (nothing is copied or changed). Reset only moves the playback cursor.</div>
        <div className="filters" style={{ marginTop: 8 }}>
          <label>From (UTC)<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label>To (UTC)<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <button className="btn primary" disabled={!range.from || !range.to} onClick={create}>New replay session</button>
          <label>Existing sessions<select value={id} onChange={(e) => setId(e.target.value)}><option value="">Select…</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        </div>
        {error && <div className="err">{error}</div>}
        {session && (
          <div>
            <div className="row">
              <button className="btn primary" disabled={session.status === "playing"} onClick={() => call("play")}>▶ Play</button>
              <button className="btn" disabled={session.status !== "playing"} onClick={() => call("pause")}>⏸ Pause</button>
              <button className="btn" onClick={() => call("reset")}>⟲ Reset</button>
              <label className="row">Speed
                <select value={session.speed} onChange={(e) => call("speed", { speed: Number(e.target.value) })}>
                  {SPEEDS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                  {!SPEEDS.some((s) => s.v === session.speed) && <option value={session.speed}>{session.speed} s/s</option>}
                </select></label>
              <span className="badge b-replay">{session.status}</span>
            </div>
            <div className="sub">Virtual time: <strong>{fmtDate(session.cursor_ts)}</strong> ({pct}% of range)</div>
            <div style={{ height: 8, background: "var(--grid)", borderRadius: 4, marginTop: 4 }}><div style={{ height: 8, width: `${pct}%`, background: "var(--series-1)", borderRadius: 4 }} /></div>
          </div>
        )}
      </div>
      {id && <Overview key={id} replaySessionId={id} />}
    </div>
  );
}
