/* Optional browser E2E. Needs: npm i --no-save playwright-core, a running app on an EMPTY database,
   and CHROME_PATH pointing at a Chromium-based browser. Run: BASE=http://127.0.0.1:4000 node e2e/run.mjs */
import { chromium } from "playwright-core";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE ?? "http://127.0.0.1:4000";
const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(here, "../sample-data");
const SP = fs.mkdtempSync(path.join(tmpdir(), "vf-e2e-"));
const exe = process.env.CHROME_PATH; // path to Chrome/Chromium/Edge; omit to use playwright default browser

const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); };

const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

async function uploadFile(category, file) {
  await page.selectOption("select >> nth=0", category);
  await page.setInputFiles('input[type=file]', file);
  await page.click("text=Preview file");
  await page.waitForSelector("text=Map source columns");
}

// ---- Upload wizard
await page.goto(BASE + "/#upload");
await uploadFile("factories", `${SAMPLE}/factories.csv`);
check("preview shows rows and suggested mapping", (await page.locator("select").count()) > 2);
await page.click("text=Validate (dry run");
await page.waitForSelector("text=Validation result");
check("validation reports 1 valid", (await page.textContent("body")).includes("1 valid"));
await page.click("text=Confirm and import");
await page.waitForSelector("text=Import report");
check("import report inserted=1", (await page.textContent("body")).includes("Inserted (new)"));

// invalid file with actionable errors
fs.writeFileSync(`${SP}/bad_lines.csv`, "id,factory_id,name\nL1,FAC-NOPE,Bad line\n,FAC-1,No id\n");
await uploadFile("lines", `${SP}/bad_lines.csv`);
await page.click("text=Validate (dry run");
await page.waitForSelector("text=Validation result");
const body = await page.textContent("body");
check("invalid rows shown with actionable messages", body.includes("does not reference an existing factories") && body.includes("is required"));

// renamed headers -> manual mapping
fs.writeFileSync(`${SP}/renamed.csv`, "Code,Label\nFAC-2,Second plant\n");
await uploadFile("factories", `${SP}/renamed.csv`);
const selects = page.locator("table select");
await selects.nth(0).selectOption("Code");
await selects.nth(1).selectOption("Label");
await page.click("text=Validate (dry run");
await page.waitForSelector("text=Validation result");
await page.click("text=Confirm and import");
await page.waitForSelector("text=Import report");
check("manual field mapping imports renamed columns", true);

// remaining sample data via API for speed
const load = [["lines","lines.csv"],["equipment","equipment.csv"],["products","products.csv"],["materials","materials.csv"],["bom","bom.csv"],["suppliers","suppliers.csv"],["process_routes","process_routes.csv"],["orders","orders.xlsx"],["stock_movements","stock_movements.csv"],["supplier_deliveries","supplier_deliveries.csv"],["production_records","production_records.csv"],["inspections","inspections.csv"],["equipment_states","equipment_states.csv"],["sensor_readings","sensor_readings.json"],["shipments","shipments.csv"]];
for (const [category, f] of load) {
  const form = new FormData();
  form.set("category", category);
  form.set("file", new Blob([fs.readFileSync(`${SAMPLE}/${f}`)]), f);
  const pv = await (await fetch(`${BASE}/api/upload/preview`, { method: "POST", body: form })).json();
  const r = await (await fetch(`${BASE}/api/upload/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, previewToken: pv.previewToken, mapping: pv.suggestedMapping, filename: f }) })).json();
  if (r.rejectedCount) console.log("  rejected", category, r.errors.slice(0, 2));
}

// ---- Overview
await page.goto(BASE + "/#overview");
await page.reload();
await page.waitForSelector("text=Good-unit output");
check("overview KPIs render", (await page.textContent("body")).includes("On-time delivery"));
await page.selectOption("select >> nth=3", { index: 1 }); // product filter? (factory,line,equipment,product order)
await page.waitForTimeout(800);
await page.click("text=Reset filters");
await page.click("button:has-text('ORD-1001') >> nth=0");
await page.waitForSelector("text=Order ORD-1001");
const tr = await page.textContent("body");
check("order trace shows materials, lots, inspections, shipments", tr.includes("Materials (BOM)") && tr.includes("Production lots") && tr.includes("Inspections") && tr.includes("Shipments"));
await page.click("button:has-text('trend') >> nth=5");
await page.waitForSelector("svg[aria-label='sensor trend']");
check("sensor trend chart renders", true);
await page.screenshot({ path: `${SP}/e2e_overview.png`, fullPage: true });

// ---- Connectors: live update through the UI
await page.click("nav >> text=API connectors");
await page.click("text=Set up demo connectors");
await page.waitForSelector("text=Mock production events");
for (let i = 0; i < 3; i++) { await page.locator("button:text-is('Start')").first().click(); await page.waitForTimeout(900); }
await page.waitForTimeout(1500);
await page.click("nav >> text=Overview (LIVE)");
await page.waitForSelector("text=Data sources");
const goodBefore = await page.locator(".card:has-text('Good-unit output') .big").first().textContent();
await fetch(`${BASE}/mock-api/admin/emit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: "production", payload: { workOrder: "ORD-1004", part: "PROD-BRAKE-PAD", machine: "EQ-PAINT-1", opStep: 2, okQty: 4321, ngQty: 0 } }) });
let changed = false;
for (let i = 0; i < 20 && !changed; i++) {
  await page.waitForTimeout(500);
  changed = (await page.locator(".card:has-text('Good-unit output') .big").first().textContent()) !== goodBefore;
}
check("overview updates automatically after mock API data changes", changed, `(${goodBefore} -> ${await page.locator(".card:has-text('Good-unit output') .big").first().textContent()})`);
check("source strip lists running connectors as healthy", (await page.locator("text=healthy").count()) >= 3);

// ---- Replay
await page.click("nav >> text=Replay");
await page.waitForSelector("text=New replay session");
await page.click("text=New replay session");
await page.waitForSelector("text=Virtual time");
const t0 = await page.textContent("text=Virtual time");
await page.click("button:text-is('▶ Play')");
await page.waitForTimeout(2500);
await page.click("button:text-is('⏸ Pause')");
const t1 = await page.textContent("text=Virtual time");
check("replay play advances virtual time", t0 !== t1, `(${t0} -> ${t1})`);
await page.waitForTimeout(1500);
check("replay pause holds the cursor", (await page.textContent("text=Virtual time")) === t1);
await page.click("button:text-is('⟲ Reset')");
await page.waitForTimeout(500);
check("replay reset returns to start", (await page.textContent("text=Virtual time")) === t0);
check("replay overview is labelled REPLAY", (await page.textContent("body")).includes("Historical replay as of"));

// ---- Simulation
await page.click("nav >> text=Simulation");
await page.waitForSelector("text=New simulation run");
await page.selectOption("select >> nth=0", "machine_down");
await page.click("text=Run scenario and compare options");
await page.waitForSelector("text=Response options");
const simText = await page.textContent("body");
check("four options compared", ["Keep current plan", "Use alternate equipment", "Add overtime", "Change job sequence"].every((s) => simText.includes(s)));
await page.click("button:has-text('Apply to virtual plan') >> nth=1");
await page.waitForSelector("button:has-text('Applied')");
check("applied option is recorded and disabled", (await page.locator("button:has-text('Applied')").isDisabled()));
check("change history lists applied option", (await page.textContent("body")).includes("overtime"));
await page.screenshot({ path: `${SP}/e2e_simulation.png`, fullPage: true });

check("no browser console/page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
