import { assertUrlAllowed, BlockedUrlError } from "./ssrfGuard.js";

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  maxRedirects?: number;
  allowPrivateNetwork?: boolean;
}

export interface FetchResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
  attempts: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_WAIT_MS = 30_000;
const BACKOFF_BASE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (!Number.isNaN(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = new Date(header).getTime();
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * Follows redirects manually (never `redirect: 'follow'`), re-validating every hop
 * against the SSRF guard, so a malicious/compromised redirect target can't bypass the
 * destination restriction. Retries bounded, transient failures (timeout/network/5xx)
 * with exponential backoff; honors 429's Retry-After (capped) as a special-cased wait
 * rather than counting it against the backoff schedule.
 */
export async function fetchJson(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowPrivateNetwork = opts.allowPrivateNetwork ?? false;

  let attempts = 0;
  let currentUrl = rawUrl;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    let validatedUrl: URL;
    try {
      validatedUrl = await assertUrlAllowed(currentUrl, allowPrivateNetwork);
    } catch (err) {
      if (err instanceof BlockedUrlError) return { ok: false, error: err.message, attempts };
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let redirectCount = 0;
      let response = await fetch(validatedUrl, { headers: opts.headers, redirect: "manual", signal: controller.signal });

      while (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          return { ok: false, error: "Too many redirects", attempts };
        }
        const location = response.headers.get("location")!;
        const nextUrl = new URL(location, validatedUrl);
        const revalidated = await assertUrlAllowed(nextUrl.toString(), allowPrivateNetwork);
        response = await fetch(revalidated, { headers: opts.headers, redirect: "manual", signal: controller.signal });
      }

      clearTimeout(timer);

      if (response.status === 429) {
        const waitMs = Math.min(parseRetryAfter(response.headers.get("retry-after")) ?? BACKOFF_BASE_MS * 2 ** attempt, MAX_RETRY_AFTER_WAIT_MS);
        if (attempt < maxRetries) {
          await sleep(waitMs);
          continue;
        }
        return { ok: false, status: 429, error: "Rate limited (429) and retries exhausted", attempts };
      }

      if (response.status >= 500) {
        if (attempt < maxRetries) {
          await sleep(BACKOFF_BASE_MS * 2 ** attempt + Math.random() * 100);
          continue;
        }
        return { ok: false, status: response.status, error: `Server error ${response.status} and retries exhausted`, attempts };
      }

      if (!response.ok) {
        // 4xx other than 429: not retryable (auth failure, bad request, not found, etc.)
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          /* non-JSON error body is fine to ignore */
        }
        return { ok: false, status: response.status, body, error: `Request failed with status ${response.status}`, attempts };
      }

      try {
        const body = await response.json();
        return { ok: true, status: response.status, body, attempts };
      } catch (err) {
        return { ok: false, status: response.status, error: `Malformed JSON response: ${(err as Error).message}`, attempts };
      }
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (attempt < maxRetries) {
        await sleep(BACKOFF_BASE_MS * 2 ** attempt + Math.random() * 100);
        continue;
      }
      return { ok: false, error: isAbort ? `Request timed out after ${timeoutMs}ms` : `Network error: ${(err as Error).message}`, attempts };
    }
  }

  return { ok: false, error: "Retries exhausted", attempts };
}
