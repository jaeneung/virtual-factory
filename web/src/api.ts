/* eslint-disable @typescript-eslint/no-explicit-any */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export type Mode = "LIVE" | "REPLAY" | "SIMULATION";

export const fmt = (n: number | null | undefined, d = 0) => (n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d }));
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");
export const usd = (n: number | null | undefined) => (n == null ? "—" : "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 }));

export type Kpi = { available: true; value: number; unit: string; numerator: number; denominator: number } | { available: false; reason: string };
