import { db } from "../db/client.js";
import { newId } from "../util/id.js";
import { nowIso } from "../util/time.js";
import { broadcastReplayTick } from "../realtime/sseHub.js";

export interface ReplaySessionRow {
  id: string;
  name: string;
  range_from: string;
  range_to: string;
  speed: number;
  status: "playing" | "paused" | "stopped";
  cursor_ts: string;
  created_at: string;
  updated_at: string;
}

const TICK_MS = 1000;
const timers = new Map<string, NodeJS.Timeout>();

export function createReplaySession(name: string, rangeFrom: string, rangeTo: string, speed = 3600): ReplaySessionRow {
  const id = newId("replay");
  const now = nowIso();
  db.prepare(
    `INSERT INTO replay_sessions (id, name, range_from, range_to, speed, status, cursor_ts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?)`
  ).run(id, name, rangeFrom, rangeTo, speed, rangeFrom, now, now);
  return getReplaySession(id)!;
}

export function getReplaySession(id: string): ReplaySessionRow | null {
  if (!id) return null;
  return (db.prepare(`SELECT * FROM replay_sessions WHERE id = ?`).get(id) as unknown as ReplaySessionRow) ?? null;
}

export function listReplaySessions(): ReplaySessionRow[] {
  return db.prepare(`SELECT * FROM replay_sessions ORDER BY created_at DESC`).all() as unknown as ReplaySessionRow[];
}

function stopTimer(id: string) {
  const t = timers.get(id);
  if (t) {
    clearInterval(t);
    timers.delete(id);
  }
}

function tick(id: string) {
  const session = getReplaySession(id);
  if (!session || session.status !== "playing") {
    stopTimer(id);
    return;
  }
  const nextCursorMs = new Date(session.cursor_ts).getTime() + session.speed * (TICK_MS / 1000) * 1000;
  const rangeToMs = new Date(session.range_to).getTime();
  const done = nextCursorMs >= rangeToMs;
  const nextCursor = new Date(Math.min(nextCursorMs, rangeToMs)).toISOString();

  db.prepare(`UPDATE replay_sessions SET cursor_ts = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    nextCursor,
    done ? "paused" : "playing",
    nowIso(),
    id
  );
  if (done) stopTimer(id);
  broadcastReplayTick(id, nextCursor, done);
}

export function play(id: string): ReplaySessionRow {
  const session = getReplaySession(id);
  if (!session) throw new Error("replay session not found");
  db.prepare(`UPDATE replay_sessions SET status = 'playing', updated_at = ? WHERE id = ?`).run(nowIso(), id);
  stopTimer(id);
  const timer = setInterval(() => tick(id), TICK_MS);
  timer.unref();
  timers.set(id, timer);
  return getReplaySession(id)!;
}

export function pause(id: string): ReplaySessionRow {
  const session = getReplaySession(id);
  if (!session) throw new Error("replay session not found");
  stopTimer(id);
  db.prepare(`UPDATE replay_sessions SET status = 'paused', updated_at = ? WHERE id = ?`).run(nowIso(), id);
  return getReplaySession(id)!;
}

export function reset(id: string): ReplaySessionRow {
  const session = getReplaySession(id);
  if (!session) throw new Error("replay session not found");
  stopTimer(id);
  db.prepare(`UPDATE replay_sessions SET status = 'paused', cursor_ts = range_from, updated_at = ? WHERE id = ?`).run(nowIso(), id);
  return getReplaySession(id)!;
}

export function setSpeed(id: string, speed: number): ReplaySessionRow {
  const session = getReplaySession(id);
  if (!session) throw new Error("replay session not found");
  db.prepare(`UPDATE replay_sessions SET speed = ?, updated_at = ? WHERE id = ?`).run(speed, nowIso(), id);
  return getReplaySession(id)!;
}
