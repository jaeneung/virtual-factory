/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { api, fmtDate } from "../api";
import { Health, ModeBadge } from "../components/ui";

const DEFAULT_MAPPING = JSON.stringify({ id: "seq", equipment_id: "machineId", metric: "sensor", value: "reading", unit: "uom", source_ts: "eventTime" }, null, 2);

export function Connectors() {
  const [list, setList] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({
    name: "", category: "sensor_readings", baseUrl: "", endpointPath: "/events", authType: "none", secretEnvVar: "", pollIntervalSec: 30, allowPrivateNetwork: false, mapping: DEFAULT_MAPPING,
  });
  const [testResult, setTestResult] = useState<any>(null);

  const load = async () => {
    setList(await api("/api/connectors"));
    setSources(await api("/api/overview/sources"));
  };
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); setMsg(ok ?? ""); } catch (e) { setMsg("Error: " + (e as Error).message); }
    await load();
  };
  const health = (id: string) => sources.find((s) => s.id === id)?.health ?? "unknown";

  const parsedMapping = () => JSON.parse(form.mapping);
  const body = () => ({ ...form, mapping: parsedMapping() });
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  return (
    <div className="grid">
      <div className="card">
        <h2>Read-only API connectors</h2>
        <div className="sub">The server polls each REST/JSON endpoint with GET requests only. Secrets are read from server-side environment variables and never reach the browser. Polled data is shown in LIVE mode with its freshness.</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" onClick={() => act(() => api("/api/connectors/demo-setup", { body: { pollIntervalSec: 10 } }), "Demo connectors for the built-in mock API are set up. Start them below.")}>Set up demo connectors (built-in mock API)</button>
          {msg && <span className={msg.startsWith("Error") ? "err" : "ok"}>{msg}</span>}
        </div>
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Auth</th><th>Poll</th><th>State</th><th>Last success</th><th>Source ts</th><th>Health</th><th /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td>{c.name}<div className="sub">{c.base_url}{c.endpoint_path}</div>{c.last_error && <div className="err sub">{c.last_error} (failures: {c.consecutive_failures}) — last values retained, marked stale</div>}</td>
                <td>{c.category}</td>
                <td>{c.auth_type}{c.secret_env_var ? <div className="sub">env: {c.secret_env_var}</div> : null}{c.allow_private_network ? <div className="sub">⚠ private network allowed</div> : null}</td>
                <td>{c.poll_interval_sec}s</td>
                <td><ModeBadge mode="LIVE" /> {c.running ? "running" : c.status}</td>
                <td>{fmtDate(c.last_success_at)}</td><td>{fmtDate(c.last_source_ts)}</td>
                <td><Health h={health(c.id)} /></td>
                <td>
                  <div className="row">
                    {c.running ? <button className="btn" onClick={() => act(() => api(`/api/connectors/${c.id}/stop`, { method: "POST" }))}>Stop</button>
                      : <button className="btn primary" onClick={() => act(() => api(`/api/connectors/${c.id}/start`, { method: "POST" }))}>Start</button>}
                    <button className="btn" onClick={() => act(() => api(`/api/connectors/${c.id}/poll-now`, { method: "POST" }).then((r) => setTestResult(r.result)))}>Poll now</button>
                    <button className="btn" onClick={() => act(() => api(`/api/connectors/${c.id}/test`, { method: "POST" }).then(setTestResult))}>Test</button>
                    <button className="btn" onClick={() => act(() => api(`/api/connectors/${c.id}`, { method: "DELETE" }))}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={9} className="sub">No connectors yet.</td></tr>}
          </tbody>
        </table>
        {testResult && <pre style={{ maxHeight: 220, overflow: "auto", fontSize: 12 }}>{JSON.stringify(testResult, null, 2)}</pre>}
      </div>

      <div className="card">
        <h2>Add a connector</h2>
        <div className="sub">Field mapping: internal field → name of the field in each response event. Do not assume a structure — copy field names from your API documentation or from the “Test” response preview. The response must look like {"{ events: [...], nextCursor }"}; pagination uses <code>?since=&lt;cursor&gt;&amp;limit=</code>.</div>
        <div className="filters" style={{ marginTop: 8 }}>
          <label>Name<input value={form.name} onChange={set("name")} /></label>
          <label>Category<select value={form.category} onChange={set("category")}>{["equipment_states", "production_records", "inspections", "sensor_readings", "shipments", "stock_movements"].map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>Base URL (http/https)<input size={32} value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://mes.example.com/api" /></label>
          <label>Endpoint path<input value={form.endpointPath} onChange={set("endpointPath")} /></label>
          <label>Auth<select value={form.authType} onChange={set("authType")}><option value="none">none</option><option value="api_key">API key (x-api-key)</option><option value="bearer">Bearer token</option></select></label>
          <label>Secret env var name<input value={form.secretEnvVar} onChange={set("secretEnvVar")} placeholder="MES_API_TOKEN" /></label>
          <label>Poll interval (s)<input type="number" min={1} value={form.pollIntervalSec} onChange={set("pollIntervalSec")} /></label>
          <label className="row" style={{ flexDirection: "row" }}><input type="checkbox" checked={form.allowPrivateNetwork} onChange={set("allowPrivateNetwork")} /> allow private-network host</label>
        </div>
        {form.allowPrivateNetwork && <div className="warn-box">Private/loopback destinations bypass the SSRF guard. Enable only for hosts you control (e.g. the built-in mock API).</div>}
        <label className="sub">Mapping (JSON)<br /><textarea rows={7} style={{ width: "100%", font: "12px monospace" }} value={form.mapping} onChange={set("mapping")} /></label>
        <div className="row">
          <button className="btn" onClick={() => act(() => api("/api/connectors/test", { body: body() }).then(setTestResult))}>Test connection (no secret typed here; uses env var only after saving)</button>
          <button className="btn primary" onClick={() => act(() => api("/api/connectors", { body: body() }), "Connector saved.")}>Save connector</button>
        </div>
      </div>
    </div>
  );
}
