// Thin Mireye HTTP client: auth, typed errors, Retry-After backoff.
//
// Contract verified live against docs.mireye.ai (not the marketing site) —
// see src/schemas/index.ts header comment. If a response disagrees with the
// shapes there, this client throws rather than silently coercing it, per
// CLAUDE.md's "surface the mismatch" rule.

import { MireyeApiError, type MireyeErrorDetail } from "../schemas/index.js";

const RETRYABLE_ERRORS = new Set([
  "ask_upstream_rate_limited",
  "ask_upstream_unreachable",
  "ask_timeout",
  "geocode_busy",
  "geocode_upstream_error",
  "geocode_timeout",
  "resolve_busy",
  "resolve_timeout",
  "proximity_busy",
  "geocodio_distance_budget_exhausted",
  "proximity_data_unavailable",
  "upstream_transient",
  "upstream_error",
  "proximity_deadline_exceeded",
  "field_requests_unavailable",
]);

function baseUrl(): string {
  return process.env.MIREYE_BASE_URL ?? "https://api.mireye.com";
}

function apiKey(): string {
  const key = process.env.MIREYE_API_KEY;
  if (!key) {
    throw new Error(
      "MIREYE_API_KEY is not set. Sign up at mireye.com (code GROWTH) and put the dashboard " +
        "token in .env before running with RECORD=1.",
    );
  }
  return key;
}

/** One authenticated POST/GET against the Mireye API, with typed error handling. */
export async function mireyeRequest<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method ?? "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const requestId = res.headers.get("X-Request-ID");

  if (!res.ok) {
    let detail: MireyeErrorDetail;
    try {
      const parsed = (await res.json()) as { detail?: MireyeErrorDetail };
      detail = parsed.detail ?? { error: "unknown_error", message: `HTTP ${res.status}` };
    } catch {
      detail = { error: "unknown_error", message: `HTTP ${res.status}, no JSON body` };
    }
    const retryAfterHeader = res.headers.get("Retry-After");
    throw new MireyeApiError(
      res.status,
      detail,
      requestId,
      RETRYABLE_ERRORS.has(detail.error),
      retryAfterHeader ? Number(retryAfterHeader) : null,
    );
  }

  return (await res.json()) as T;
}

/** Retry a Mireye call once on a retryable error, honoring Retry-After. */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof MireyeApiError) || !err.retryable || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = (err.retryAfterSeconds ?? 2) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
