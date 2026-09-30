import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { app } from "../src/app.js";
import { db } from "../src/db/client.js";
import { fetchJson } from "../src/connectors/httpConnector.js";
import { assertUrlAllowed, BlockedUrlError } from "../src/connectors/ssrfGuard.js";
import { createConnector, getConnector } from "../src/connectors/store.js";
import { pollConnector } from "../src/connectors/ingest.js";
import { startConnector, stopConnector, isRunning, stopAllConnectors } from "../src/connectors/pollingScheduler.js";
import { getConnectorSourceStatuses } from "../src/domain/sources.js";
import { freshDb, loadAllSamples } from "./helpers.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void;

let server: http.Server;
let base: string;
let hits = 0;
let handler: Handler = (_req, res) => res.end("{}");

beforeEach(async () => {
  hits = 0;
  freshDb();
  server = http.createServer((req, res) => handler(req, res, ++hits));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  stopAllConnectors();
  await new Promise((r) => server.close(r));
  vi.unstubAllGlobals();
});
afterAll(() => stopAllConnectors());

const json = (res: http.ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const count = (table: string) => (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as unknown as { c: number }).c;

describe("destination restrictions (SSRF)", () => {
  it("blocks loopback/private/metadata hosts and non-http protocols unless private network is explicitly allowed", async () => {
    for (const url of ["http://127.0.0.1:1/", "http://localhost/", "http://10.1.2.3/", "http://192.168.0.5/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://172.20.0.1/"]) {
      await expect(assertUrlAllowed(url, false), url).rejects.toBeInstanceOf(BlockedUrlError);
    }
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://x/"]) {
      await expect(assertUrlAllowed(url, true), url).rejects.toThrow(/Protocol not allowed/);
    }
    await expect(assertUrlAllowed("http://127.0.0.1:1/", true)).resolves.toBeInstanceOf(URL);
    await expect(assertUrlAllowed("http://93.184.216.34/", false)).resolves.toBeInstanceOf(URL);
  });

  it("fetchJson refuses a private destination by default without making a request", async () => {
    handler = (_q, res) => json(res, { ok: 1 });
    const r = await fetchJson(base + "/x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private/);
    expect(hits).toBe(0);
  });

  it("re-validates every redirect hop: a redirect from a public host to a private one is blocked", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/admin" } }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchJson("http://93.184.216.34/start", { maxRetries: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to a non-http protocol even when private networks are allowed, and caps redirect loops", async () => {
    handler = (_q, res) => {
      res.writeHead(302, { Location: "file:///etc/passwd" });
      res.end();
    };
    const r1 = await fetchJson(base + "/a", { allowPrivateNetwork: true, maxRetries: 0 });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/Protocol not allowed/);

    handler = (_q, res) => {
      res.writeHead(302, { Location: base + "/loop" });
      res.end();
    };
    const r2 = await fetchJson(base + "/loop", { allowPrivateNetwork: true, maxRetries: 0, maxRedirects: 3 });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/Too many redirects/);
  });
});

describe("http resiliency", () => {
  const opts = { allowPrivateNetwork: true };

  it("returns 401 without retrying", async () => {
    handler = (_q, res) => json(res, { error: "nope" }, 401);
    const r = await fetchJson(base, opts);
    expect(r).toMatchObject({ ok: false, status: 401, attempts: 1 });
    expect(hits).toBe(1);
  });

  it("times out", async () => {
    handler = () => undefined;
    const r = await fetchJson(base, { ...opts, timeoutMs: 150, maxRetries: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    handler = (_q, res, hit) => (hit === 1 ? json(res, {}, 429, { "Retry-After": "1" }) : json(res, { fine: true }));
    const t0 = Date.now();
    const r = await fetchJson(base, opts);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it("gives up after a bounded number of attempts on persistent 429", async () => {
    handler = (_q, res) => json(res, {}, 429, { "Retry-After": "0" });
    const r = await fetchJson(base, { ...opts, maxRetries: 2 });
    expect(r).toMatchObject({ ok: false, status: 429, attempts: 3 });
    expect(hits).toBe(3);
  });

  it("retries 5xx with backoff and recovers", async () => {
    handler = (_q, res, hit) => (hit < 3 ? json(res, {}, 503) : json(res, { ok: true }));
    const r = await fetchJson(base, opts);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it("reports malformed JSON", async () => {
    handler = (_q, res) => json(res, "{broken,,", 200);
    const r = await fetchJson(base, opts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Malformed JSON/);
  });
});

const EQ_MAPPING = { id: "seq", equipment_id: "machineId", state: "status", planned: "plannedStop", start_ts: "intervalStart", end_ts: "intervalEnd" };

function newConnector(extra: Partial<Parameters<typeof createConnector>[0]> = {}) {
  return createConnector({
    name: "test-eq",
    category: "equipment_states",
    baseUrl: base,
    endpointPath: "/events",
    authType: "none",
    pollIntervalSec: 1,
    allowPrivateNetwork: true,
    mapping: EQ_MAPPING,
    ...extra,
  });
}

const ev = (seq: number, start: string, status = "running") => ({
  seq,
  machineId: "EQ-STAMP-1",
  status,
  plannedStop: false,
  intervalStart: start,
  intervalEnd: null,
  eventTime: start,
});

describe("polling ingestion", () => {
  it("collects incrementally with a cursor and never double-counts on re-delivery", async () => {
    await loadAllSamples();
    const events = [ev(1, "2026-09-25T01:00:00Z"), ev(2, "2026-09-25T02:00:00Z")];
    handler = (req, res) => {
      const since = Number(new URL(req.url!, base).searchParams.get("since"));
      const page = events.filter((e) => e.seq > since);
      json(res, { events: page, nextCursor: page.length ? page[page.length - 1].seq : since, hasMore: false });
    };
    const c = newConnector();
    const before = count("equipment_states");

    expect(await pollConnector(c.id)).toMatchObject({ ok: true, fetched: 2, inserted: 2 });
    expect(getConnector(c.id)!.last_cursor).toBe("2");

    expect(await pollConnector(c.id)).toMatchObject({ ok: true, fetched: 0, inserted: 0 });

    events.push(ev(3, "2026-09-25T03:00:00Z"));
    expect(await pollConnector(c.id)).toMatchObject({ fetched: 1, inserted: 1 });

    // Connection restart / cursor loss: full re-delivery must not create duplicates.
    db.prepare(`UPDATE connectors SET last_cursor = NULL WHERE id = ?`).run(c.id);
    expect(await pollConnector(c.id)).toMatchObject({ fetched: 3, inserted: 0, ignored: 3 });
    expect(count("equipment_states")).toBe(before + 3);
  });

  it("follows pagination (hasMore) within one poll", async () => {
    await loadAllSamples();
    const all = Array.from({ length: 120 }, (_v, i) => ev(i + 1, new Date(Date.UTC(2026, 8, 25, 0, i)).toISOString()));
    handler = (req, res) => {
      const url = new URL(req.url!, base);
      const since = Number(url.searchParams.get("since"));
      const limit = Number(url.searchParams.get("limit"));
      const rest = all.filter((e) => e.seq > since);
      const page = rest.slice(0, limit);
      json(res, { events: page, nextCursor: page.length ? page[page.length - 1].seq : since, hasMore: rest.length > page.length });
    };
    const c = newConnector();
    expect(await pollConnector(c.id)).toMatchObject({ ok: true, fetched: 120, inserted: 120 });
    expect(hits).toBe(3);
    expect(getConnector(c.id)!.last_cursor).toBe("120");
  });

  it("ignores out-of-order older updates, applies newer ones, and keeps source vs ingestion time separate", async () => {
    await loadAllSamples();
    let body: unknown[] = [];
    handler = (_q, res) => json(res, { events: body, nextCursor: 1, hasMore: false });
    const c = newConnector();

    body = [ev(1, "2026-09-25T05:00:00Z", "running")];
    await pollConnector(c.id);
    body = [ev(1, "2026-09-25T04:00:00Z", "stopped")];
    expect(await pollConnector(c.id)).toMatchObject({ inserted: 0, updated: 0, ignored: 1 });
    body = [ev(1, "2026-09-25T06:00:00Z", "maintenance")];
    expect(await pollConnector(c.id)).toMatchObject({ updated: 1 });

    const row = db.prepare(`SELECT state, source_ts, ingested_at FROM equipment_states WHERE id = ?`).get(`${c.id}:1`) as unknown as {
      state: string;
      source_ts: string;
      ingested_at: string;
    };
    expect(row.state).toBe("maintenance");
    expect(row.source_ts).toBe("2026-09-25T06:00:00.000Z");
    expect(row.ingested_at).not.toBe(row.source_ts);
    expect(getConnector(c.id)!.last_source_ts).toBe("2026-09-25T06:00:00.000Z");
  });

  it("rejects individual invalid events without failing the poll", async () => {
    await loadAllSamples();
    handler = (_q, res) =>
      json(res, { events: [ev(1, "2026-09-25T01:00:00Z"), { ...ev(2, "2026-09-25T02:00:00Z"), machineId: "EQ-UNKNOWN" }], nextCursor: 2, hasMore: false });
    const c = newConnector();
    expect(await pollConnector(c.id)).toMatchObject({ ok: true, inserted: 1, rejected: 1 });
  });

  it("marks the connector failed on auth failure or malformed data, keeps last-good data, then recovers", async () => {
    await loadAllSamples();
    let mode: "good" | "auth" | "malformed" = "good";
    handler = (_q, res) => {
      if (mode === "auth") return json(res, {}, 401);
      if (mode === "malformed") return json(res, { unexpected: true });
      json(res, { events: [ev(1, "2026-09-25T01:00:00Z")], nextCursor: 1, hasMore: false });
    };
    const c = newConnector();
    await pollConnector(c.id);
    const good = getConnector(c.id)!;
    expect(good.status).toBe("running");
    const rowsBefore = count("equipment_states");

    mode = "auth";
    expect((await pollConnector(c.id)).ok).toBe(false);
    let cur = getConnector(c.id)!;
    expect(cur.status).toBe("failed");
    expect(cur.last_error).toMatch(/401/);
    expect(cur.last_success_at).toBe(good.last_success_at);
    expect(cur.last_cursor).toBe("1");
    expect(getConnectorSourceStatuses().find((s) => s.id === c.id)!.health).toBe("failed");

    mode = "malformed";
    expect((await pollConnector(c.id)).error).toMatch(/malformed/);
    expect(getConnector(c.id)!.consecutive_failures).toBe(2);
    expect(count("equipment_states")).toBe(rowsBefore);

    mode = "good";
    await pollConnector(c.id);
    cur = getConnector(c.id)!;
    expect(cur.status).toBe("running");
    expect(cur.last_error).toBeNull();
    expect(cur.consecutive_failures).toBe(0);
  });

  it("marks a healthy-but-silent connector as stale once the lag exceeds 3x its interval", async () => {
    await loadAllSamples();
    handler = (_q, res) => json(res, { events: [], nextCursor: 0, hasMore: false });
    const c = newConnector({ pollIntervalSec: 10 });
    await pollConnector(c.id);
    expect(getConnectorSourceStatuses().find((s) => s.id === c.id)!.health).toBe("healthy");
    const old = new Date(Date.now() - 45_000).toISOString();
    db.prepare(`UPDATE connectors SET last_success_at = ? WHERE id = ?`).run(old, c.id);
    const status = getConnectorSourceStatuses().find((s) => s.id === c.id)!;
    expect(status.health).toBe("stale");
    expect(status.lagSeconds).toBeGreaterThanOrEqual(44);
  });

  it("prevents overlapping polls for the same connector", async () => {
    await loadAllSamples();
    handler = (_q, res) => {
      setTimeout(() => json(res, { events: [], nextCursor: 0, hasMore: false }), 400);
    };
    const c = newConnector();
    const [a, b] = await Promise.all([pollConnector(c.id), pollConnector(c.id)]);
    expect([a, b].filter((r) => r.error?.startsWith("skipped"))).toHaveLength(1);
    expect(hits).toBe(1);
  });

  it("scheduler: restarting never creates duplicate timers, and stopping cleans up", async () => {
    await loadAllSamples();
    handler = (_q, res) => json(res, { events: [], nextCursor: 0, hasMore: false });
    const c = newConnector();
    startConnector(c.id);
    startConnector(c.id);
    startConnector(c.id);
    expect(isRunning(c.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 2300));
    expect(hits).toBeLessThanOrEqual(6);
    stopConnector(c.id);
    expect(isRunning(c.id)).toBe(false);
    const after = hits;
    await new Promise((r) => setTimeout(r, 1300));
    expect(hits).toBe(after);
    expect(getConnector(c.id)!.status).toBe("stopped");
  });
});

describe("credential handling", () => {
  it("sends the secret from a server-side env var as a header and never exposes it via the API, URL, or DB", async () => {
    process.env.VF_TEST_SECRET = "s3cr3t-value-123";
    let seenHeader: string | undefined;
    let seenUrl = "";
    handler = (req, res) => {
      seenHeader = req.headers["x-api-key"] as string;
      seenUrl = req.url!;
      json(res, { events: [], nextCursor: 0, hasMore: false });
    };
    await loadAllSamples();
    const c = newConnector({ authType: "api_key", secretEnvVar: "VF_TEST_SECRET" });
    expect((await pollConnector(c.id)).ok).toBe(true);
    expect(seenHeader).toBe("s3cr3t-value-123");
    expect(seenUrl).not.toContain("s3cr3t");

    const list = await request(app).get("/api/connectors");
    expect(JSON.stringify(list.body)).not.toContain("s3cr3t");
    expect(JSON.stringify(db.prepare(`SELECT * FROM connectors`).all())).not.toContain("s3cr3t");
    const tested = await request(app).post(`/api/connectors/${c.id}/test`);
    expect(JSON.stringify(tested.body)).not.toContain("s3cr3t");
    delete process.env.VF_TEST_SECRET;
  });

  it("fails cleanly (401) when the env var is unset rather than leaking or crashing", async () => {
    handler = (req, res) => (req.headers["x-api-key"] ? json(res, { events: [], nextCursor: 0 }) : json(res, {}, 401));
    await loadAllSamples();
    const c = newConnector({ authType: "api_key", secretEnvVar: "VF_DOES_NOT_EXIST" });
    expect((await pollConnector(c.id)).ok).toBe(false);
    expect(getConnector(c.id)!.last_error).toMatch(/401/);
  });
});
