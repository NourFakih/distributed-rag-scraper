import { CrawlFailure } from "../errors/crawl-failure";

export const BASE_RETRY_DELAY_MS = 1_000;
export const MAX_EXPONENTIAL_RETRY_DELAY_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export function parseRetryAfter(
  value: string | string[] | undefined,
  nowMs = Date.now(),
): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) {
    return undefined;
  }

  const trimmed = candidate.trim();
  let delayMs: number;

  if (/^\d+$/u.test(trimmed)) {
    delayMs = Number.parseInt(trimmed, 10) * 1_000;
  } else {
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) {
      return undefined;
    }
    delayMs = timestamp - nowMs;
  }

  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return undefined;
  }

  return Math.min(delayMs, MAX_RETRY_AFTER_MS);
}

export function calculateBackoffDelay(
  attemptsMade: number,
  error?: Error,
): number {
  if (
    error instanceof CrawlFailure &&
    error.retryAfterMs !== undefined
  ) {
    return error.retryAfterMs;
  }

  const exponent = Math.max(attemptsMade - 1, 0);
  return Math.min(
    BASE_RETRY_DELAY_MS * 2 ** exponent,
    MAX_EXPONENTIAL_RETRY_DELAY_MS,
  );
}
