import type { Response } from "express";

/**
 * The SSE hub does NOT push computed overview payloads (that would risk clients
 * accumulating stale or double-counted state across reconnects). It pushes small
 * "something changed, refetch" notifications; the client re-issues the normal
 * idempotent GET /api/overview (or replay/session) request, which always recomputes
 * from the DB. This keeps "live" honest: it's a change notification over a
 * server-sent-events channel, not a millisecond data stream, and reconnecting never
 * creates duplicate server-side subscriptions because the hub only tracks the
 * open HTTP response objects themselves.
 */

type Topic = "overview" | `replay:${string}`;

interface Client {
  id: number;
  res: Response;
  topics: Set<Topic>;
}

let nextClientId = 1;
const clients = new Map<number, Client>();

export function subscribe(res: Response, topics: Topic[]): number {
  const id = nextClientId++;
  clients.set(id, { id, res, topics: new Set(topics) });
  res.on("close", () => {
    clients.delete(id);
  });
  return id;
}

function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function broadcast(topic: Topic, event: string, data: unknown) {
  for (const client of clients.values()) {
    if (client.topics.has(topic)) {
      send(client.res, event, data);
    }
  }
}

export function broadcastOverviewChanged(reason: string) {
  broadcast("overview", "change", { reason, at: new Date().toISOString() });
}

export function broadcastReplayTick(sessionId: string, cursorTs: string, done: boolean) {
  broadcast(`replay:${sessionId}`, "tick", { sessionId, cursorTs, done });
}

export function clientCount(): number {
  return clients.size;
}
