import { getConnector, listConnectors, markRunning, markStopped } from "./store.js";
import { pollConnector } from "./ingest.js";

const timers = new Map<string, NodeJS.Timeout>();

function clearTimer(id: string) {
  const t = timers.get(id);
  if (t) {
    clearInterval(t);
    timers.delete(id);
  }
}

/** Starting a connector that's already running replaces its timer rather than adding a
 *  second one — reconnecting or re-saving config can never create duplicate subscriptions. */
export function startConnector(id: string): void {
  const connector = getConnector(id);
  if (!connector) throw new Error("connector not found");
  clearTimer(id);
  markRunning(id);
  void pollConnector(id);
  const timer = setInterval(() => {
    void pollConnector(id);
  }, connector.poll_interval_sec * 1000);
  timer.unref();
  timers.set(id, timer);
}

export function stopConnector(id: string): void {
  clearTimer(id);
  markStopped(id);
}

export function isRunning(id: string): boolean {
  return timers.has(id);
}

/** Called once at process shutdown so no interval keeps the event loop alive or fires after teardown. */
export function stopAllConnectors(): void {
  for (const id of Array.from(timers.keys())) {
    clearTimer(id);
  }
}

/** Resumes any connectors left in 'running' status across a server restart. */
export function resumeRunningConnectors(): void {
  for (const c of listConnectors()) {
    if (c.status === "running") startConnector(c.id);
  }
}
