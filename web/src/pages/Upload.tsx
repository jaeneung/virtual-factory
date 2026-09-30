/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { api, fmtDate } from "../api";

const ORDER_HINT = "Recommended import order: factories, lines, equipment, products, materials, bom, suppliers, process_routes, orders, stock_movements, supplier_deliveries, production_records, inspections, equipment_states, sensor_readings, shipments (later files reference earlier ones).";

export function Upload() {
  const [cats, setCats] = useState<any[]>([]);
  const [category, setCategory] = useState("factories");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [dry, setDry] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshBatches = () => api("/api/upload/batches").then(setBatches);
  useEffect(() => {
    api("/api/upload/categories").then(setCats);
    void refreshBatches();
  }, []);

  const cat = cats.find((c) => c.key === category);
  const reset = () => { setPreview(null); setDry(null); setReport(null); setError(""); };

  async function doPreview() {
    if (!file) return;
    setBusy(true); reset();
    try {
      const form = new FormData();
      form.set("category", category);
      form.set("file", file);
      const p = await api("/api/upload/preview", { form });
      setPreview(p);
      setMapping(p.suggestedMapping);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function doValidate() {
    setBusy(true); setError("");
    try { setDry(await api("/api/upload/validate", { body: { category, previewToken: preview.previewToken, mapping } })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function doCommit() {
    setBusy(true); setError("");
    try {
      setReport(await api("/api/upload/commit", { body: { category, previewToken: preview.previewToken, mapping, filename: file?.name } }));
      setPreview(null); setDry(null); void refreshBatches();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const missingRequired = cat ? cat.fields.filter((f: any) => f.required && !mapping[f.key]) : [];

  return (
    <div className="grid">
      <div className="card">
        <h2>1 · Choose data category and file</h2>
        <div className="row">
          <select value={category} onChange={(e) => { setCategory(e.target.value); reset(); }}>
            {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <input type="file" accept=".csv,.json,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }} />
          <button className="btn primary" disabled={!file || busy} onClick={doPreview}>Preview file</button>
        </div>
        <div className="sub">CSV, JSON (array of records or {"{ records: [...] }"}) and XLSX (first sheet). Limits: 20 MB, 100,000 rows. Sample files are in <code>sample-data/</code>.</div>
        <div className="sub">{ORDER_HINT}</div>
        {cat && (
          <details>
            <summary>Field documentation for “{cat.label}” — key policy: {cat.keyPolicy === "upsert" ? `upsert by (${cat.naturalKey.join(", ")}); re-uploads update` : `insert-if-new by (${cat.naturalKey.join(", ")}); repeats are counted as duplicates`}</summary>
            <table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Unit / notes</th></tr></thead>
              <tbody>{cat.fields.map((f: any) => <tr key={f.key}><td><code>{f.key}</code> {f.label}</td><td>{f.type}{f.enumValues ? ` (${f.enumValues.join("|")})` : ""}</td><td>{f.required ? "yes" : "no"}</td><td>{f.unit ?? ""}{f.refTable ? ` → ${f.refTable}` : ""}</td></tr>)}</tbody></table>
          </details>
        )}
        {error && <div className="err">{error}</div>}
      </div>

      {preview && (
        <div className="card">
          <h2>2 · Preview ({preview.totalRows} rows) and field mapping</h2>
          <div style={{ overflowX: "auto" }}>
            <table><thead><tr>{preview.headers.map((h: string) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{preview.sampleRows.slice(0, 5).map((r: any, i: number) => <tr key={i}>{preview.headers.map((h: string) => <td key={h}>{String(r[h] ?? "")}</td>)}</tr>)}</tbody></table>
          </div>
          <h2 style={{ marginTop: 12 }}>Map source columns to internal fields</h2>
          <table><thead><tr><th>Internal field</th><th>Source column</th></tr></thead>
            <tbody>{cat.fields.map((f: any) => (
              <tr key={f.key}>
                <td>{f.label} {f.required && <span className="err">*</span>}<div className="sub"><code>{f.key}</code></div></td>
                <td><select value={mapping[f.key] ?? ""} onChange={(e) => { setMapping({ ...mapping, [f.key]: e.target.value || null }); setDry(null); }}>
                  <option value="">— not mapped —</option>{preview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}</select></td>
              </tr>))}</tbody></table>
          {missingRequired.length > 0 && <div className="warn-box">Required fields not mapped: {missingRequired.map((f: any) => f.label).join(", ")}. Rows will be rejected until these are mapped or provided.</div>}
          <button className="btn primary" disabled={busy} onClick={doValidate}>3 · Validate (dry run, nothing is imported)</button>
        </div>
      )}

      {dry && (
        <div className="card">
          <h2>Validation result</h2>
          <div><span className="ok">{dry.validCount} valid</span> · <span className={dry.invalidCount ? "err" : ""}>{dry.invalidCount} invalid</span> of {dry.totalRows} rows</div>
          {dry.invalidCount > 0 && (
            <table><thead><tr><th>Row</th><th>Field</th><th>Problem and how to fix it</th></tr></thead>
              <tbody>{dry.invalidSample.slice(0, 50).flatMap((r: any) => r.errors.map((e: any, i: number) => <tr key={r.rowNo + "-" + i}><td>{r.rowNo}</td><td><code>{e.field}</code></td><td>{e.message}</td></tr>))}</tbody></table>
          )}
          <p className="sub">Only the {dry.validCount} valid rows will be imported; invalid rows are excluded and listed in the report.</p>
          <button className="btn primary" disabled={busy || dry.validCount === 0} onClick={doCommit}>4 · Confirm and import {dry.validCount} valid rows</button>
        </div>
      )}

      {report && (
        <div className="card" style={{ border: "2px solid var(--good)" }}>
          <h2>Import report</h2>
          <table><tbody>
            <tr><td>Inserted (new)</td><td className="num">{report.insertedCount}</td></tr>
            <tr><td>Updated (existing key, changed policy: upsert)</td><td className="num">{report.updatedCount}</td></tr>
            <tr><td>Duplicates skipped (already imported)</td><td className="num">{report.duplicateCount}</td></tr>
            <tr><td>Excluded (invalid)</td><td className="num">{report.rejectedCount}</td></tr>
          </tbody></table>
          {report.errors.slice(0, 20).map((e: any, i: number) => <div key={i} className="sub">Row {e.rowNo} · {e.field}: {e.message}</div>)}
        </div>
      )}

      <div className="card">
        <h2>Import history</h2>
        <table><thead><tr><th>When</th><th>Category</th><th>File</th><th className="num">New</th><th className="num">Upd</th><th className="num">Dup</th><th className="num">Excl</th></tr></thead>
          <tbody>{batches.map((b) => <tr key={b.id}><td>{fmtDate(b.uploaded_at)}</td><td>{b.category}</td><td>{b.filename ?? b.connector_id}</td><td className="num">{b.inserted_count}</td><td className="num">{b.updated_count}</td><td className="num">{b.duplicate_count}</td><td className="num">{b.rejected_count}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}
