export const CRAWL_FAILURE_CATEGORIES = [
  "HTTP_429",
  "HTTP_502",
  "HTTP_503",
  "HTTP_504",
  "NETWORK_TIMEOUT",
  "CONNECTION_RESET",
  "BROWSER_TIMEOUT",
  "BROWSER_CRASH",
  "BROWSER_NAVIGATION",
  "DNS_TEMPORARY",
  "ROBOTS_UNREACHABLE",
  "RATE_LIMIT_UNAVAILABLE",
  "UNSAFE_TARGET",
  "DNS_FAILURE",
  "SAME_ORIGIN_VIOLATION",
  "INVALID_REDIRECT",
  "INVALID_URL",
  "HTTP_PERMANENT",
  "UNSUPPORTED_CONTENT_TYPE",
  "RESPONSE_TOO_LARGE",
  "EMPTY_CONTENT",
  "UNKNOWN",
] as const;

export type CrawlFailureCategory =
  (typeof CRAWL_FAILURE_CATEGORIES)[number];

export class CrawlFailure extends Error {
  public constructor(
    public readonly category: CrawlFailureCategory,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CrawlFailure";
  }
}

export class RobotsExcludedError extends Error {
  public constructor(public readonly url: string) {
    super(`Blocked by robots.txt: ${url}`);
    this.name = "RobotsExcludedError";
  }
}

export function asCrawlFailure(error: unknown): CrawlFailure {
  if (error instanceof CrawlFailure) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new CrawlFailure("UNKNOWN", message, true, undefined, {
    cause: error,
  });
}
