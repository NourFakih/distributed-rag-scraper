import {
  CrawlFailure,
  type CrawlFailureCategory,
} from "../errors/crawl-failure";
import {
  CRAWLER_HTTP_TIMEOUT_MS,
  retryableHttpFailure,
} from "../http/crawler-http-client";
import type { CrawlerHttpClient } from "../http/crawler-http-client";
import {
  processPageSource,
  type ProcessedPage,
} from "../processing/process-page";

export const STATIC_FETCH_TIMEOUT_MS = CRAWLER_HTTP_TIMEOUT_MS;
export const MAX_STATIC_PAGE_BYTES = 2 * 1024 * 1024;

export type StaticPageResult = ProcessedPage;

export class StaticPageScrapeError extends CrawlFailure {
  public constructor(
    category: CrawlFailureCategory,
    message: string,
  ) {
    super(category, message, false);
    this.name = "StaticPageScrapeError";
  }
}

export async function scrapeStaticPage(
  url: string,
  allowedOrigin: string,
  client: CrawlerHttpClient,
  crawlDelayMs?: number,
  checkRedirectPolicy?: (
    url: string,
  ) => Promise<{ allowed: boolean; crawlDelayMs?: number }>,
): Promise<StaticPageResult> {
  const response = await client.request({
    url,
    allowedOrigin,
    accept: "text/html,application/xhtml+xml",
    maxResponseBytes: MAX_STATIC_PAGE_BYTES,
    crawlDelayMs,
    checkRedirectPolicy,
  });
  const retryableFailure = retryableHttpFailure(response);
  if (retryableFailure) {
    throw retryableFailure;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new StaticPageScrapeError(
      "HTTP_PERMANENT",
      `Static page returned HTTP ${response.status}`,
    );
  }

  const contentType = response.headers["content-type"] ?? null;

  if (
    !contentType ||
    !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)
  ) {
    throw new StaticPageScrapeError(
      "UNSUPPORTED_CONTENT_TYPE",
      `Unsupported content type: ${contentType ?? "missing"}`,
    );
  }

  if (typeof response.data !== "string") {
    throw new StaticPageScrapeError(
      "HTTP_PERMANENT",
      "Static page response was not text",
    );
  }

  if (Buffer.byteLength(response.data, "utf8") > MAX_STATIC_PAGE_BYTES) {
    throw new StaticPageScrapeError(
      "RESPONSE_TOO_LARGE",
      "Static page exceeded the 2 MiB limit",
    );
  }

  return processPageSource({
    url: response.url,
    title: null,
    rawHtml: response.data,
    httpStatus: response.status,
    headers: response.headers,
    contentType,
    fetchedAt: new Date(),
  });
}
