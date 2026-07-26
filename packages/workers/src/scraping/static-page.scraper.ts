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

export interface ConditionalRequestValidators {
  etag?: string;
  lastModified?: string;
}

interface StaticPageMetadata {
  etag: string | null;
  lastModified: string | null;
  fetchedAt: Date;
}

export type StaticPageResult =
  | (ProcessedPage & StaticPageMetadata & { notModified: false })
  | (StaticPageMetadata & {
      notModified: true;
      url: string;
      httpStatus: 304;
    });

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
  validators?: ConditionalRequestValidators,
): Promise<StaticPageResult> {
  const requestHeaders: Record<string, string> = {};
  if (validators?.etag) {
    requestHeaders["If-None-Match"] = validators.etag;
  }
  if (validators?.lastModified) {
    requestHeaders["If-Modified-Since"] = validators.lastModified;
  }

  const response = await client.request({
    url,
    allowedOrigin,
    accept: "text/html,application/xhtml+xml",
    maxResponseBytes: MAX_STATIC_PAGE_BYTES,
    crawlDelayMs,
    checkRedirectPolicy,
    requestHeaders,
  });
  const responseMetadata: StaticPageMetadata = {
    etag: response.headers.etag ?? null,
    lastModified: response.headers["last-modified"] ?? null,
    fetchedAt: new Date(),
  };
  if (response.status === 304) {
    return {
      notModified: true,
      url: response.url,
      httpStatus: 304,
      ...responseMetadata,
    };
  }
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

  return {
    ...processPageSource({
      url: response.url,
      title: null,
      rawHtml: response.data,
      httpStatus: response.status,
      headers: response.headers,
      contentType,
      fetchedAt: responseMetadata.fetchedAt,
    }),
    notModified: false,
    ...responseMetadata,
  };
}
