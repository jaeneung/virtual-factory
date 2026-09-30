import { withTransaction } from "../db/client.js";
import { getCategory } from "../ingestion/categories.js";
import { applyMapping, validateRows } from "../ingestion/validators.js";
import { persistRow } from "../ingestion/persist.js";
import { fetchJson } from "./httpConnector.js";
import { ConnectorRow, getConnector, recordPollSuccess, recordPollFailure, resolveSecret } from "./store.js";
import { broadcastOverviewChanged } from "../realtime/sseHub.js";

interface MockApiPage {
  events: Record<string, unknown>[];
  nextCursor: number;
  hasMore: boolean;
}

function buildHeaders(connector: ConnectorRow): Record<string, string> {
  const headers: Record<string, string> = {};
  const secret = resolveSecret(connector);
  if (connector.auth_type === "api_key" && secret) headers["x-api-key"] = secret;
  if (connector.auth_type === "bearer" && secret) headers["authorization"] = `Bearer ${secret}`;
  return headers;
}

const PAGE_SIZE = 50;
const MAX_PAGES_PER_POLL = 10;

// Prevents overlapping polls for the same connector (a slow request outliving the next tick).
const inFlight = new Set<string>();

export interface PollOutcome {
  ok: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  ignored: number;
  rejected: number;
  error?: string;
}

export async function pollConnector(connectorId: string): Promise<PollOutcome> {
  if (inFlight.has(connectorId)) {
    return { ok: true, fetched: 0, inserted: 0, updated: 0, ignored: 0, rejected: 0, error: "skipped: previous poll still in flight" };
  }
  const connector = getConnector(connectorId);
  if (!connector) throw new Error("connector not found");

  inFlight.add(connectorId);
  try {
    const category = getCategory(connector.category);
    const mapping = JSON.parse(connector.mapping_json ?? "{}");
    const totals = { fetched: 0, inserted: 0, updated: 0, ignored: 0, rejected: 0 };
    let cursor = connector.last_cursor ?? "0";
    let latestSourceTs: string | null = connector.last_source_ts;

    // Drain pages while the source reports more data (bounded so one poll can't run away).
    for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
      const url = `${connector.base_url.replace(/\/$/, "")}${connector.endpoint_path}?since=${encodeURIComponent(cursor)}&limit=${PAGE_SIZE}`;
      const result = await fetchJson(url, {
        headers: buildHeaders(connector),
        allowPrivateNetwork: Boolean(connector.allow_private_network),
      });
      if (!result.ok) {
        const message = result.error ?? `HTTP ${result.status ?? "error"}`;
        recordPollFailure(connectorId, message);
        return { ok: false, ...totals, error: message };
      }

      const body = result.body as Partial<MockApiPage> | undefined;
      if (!body || !Array.isArray(body.events) || typeof body.nextCursor === "undefined") {
        recordPollFailure(connectorId, "malformed response: expected { events: [...], nextCursor }");
        return { ok: false, ...totals, error: "malformed response" };
      }

      withTransaction(() => {
        for (const rawEvent of body.events!) {
          const [mapped] = applyMapping([rawEvent], mapping);
          // Namespace the connector's own id so two connectors (or a connector and a file
          // upload) can never collide on the same primary key.
          if (mapped.id !== undefined && mapped.id !== null) {
            mapped.id = `${connector.id}:${mapped.id}`;
          }
          const { valid, invalid } = validateRows(category, [mapped]);
          if (invalid.length > 0 || valid.length === 0) {
            totals.rejected++;
            continue;
          }
          const outcome = persistRow(category, valid[0].data, "upsert-if-newer");
          if (outcome === "inserted") totals.inserted++;
          else if (outcome === "updated") totals.updated++;
          else totals.ignored++;

          const tsField = category.deriveSourceTsFrom ?? (category.fields.some((f) => f.key === "source_ts") ? "source_ts" : null);
          const ts = tsField ? (valid[0].data[tsField] as string | undefined) : undefined;
          if (ts && (!latestSourceTs || ts > latestSourceTs)) latestSourceTs = ts;
        }
      });
      totals.fetched += body.events.length;

      const nextCursor = String(body.nextCursor);
      recordPollSuccess(connectorId, nextCursor, latestSourceTs);
      const advanced = nextCursor !== cursor;
      cursor = nextCursor;
      if (!body.hasMore || body.events.length === 0 || !advanced) break;
    }

    if (totals.inserted + totals.updated > 0) broadcastOverviewChanged(`connector ${connector.name} ingested ${totals.inserted + totals.updated} record(s)`);
    return { ok: true, ...totals };
  } catch (err) {
    recordPollFailure(connectorId, (err as Error).message);
    return { ok: false, fetched: 0, inserted: 0, updated: 0, ignored: 0, rejected: 0, error: (err as Error).message };
  } finally {
    inFlight.delete(connectorId);
  }
}
