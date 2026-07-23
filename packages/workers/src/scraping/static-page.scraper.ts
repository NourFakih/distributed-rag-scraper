import axios from "axios";
import type { AxiosInstance } from "axios";

import { cleanHtml } from "../processing/clean-html";

export const STATIC_FETCH_TIMEOUT_MS = 15_000;
export const MAX_STATIC_PAGE_BYTES = 2 * 1024 * 1024;

export interface StaticPageResult {
  url: string;
  title: string | null;
  rawHtml: string;
  content: string;
  httpStatus: number;
  contentType: string | null;
  fetchedAt: Date;
}

export class StaticPageScrapeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StaticPageScrapeError";
  }
}

export async function scrapeStaticPage(
  url: string,
  client: AxiosInstance = axios,
): Promise<StaticPageResult> {
  const response = await client.get<string>(url, {
    timeout: STATIC_FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: MAX_STATIC_PAGE_BYTES,
    maxBodyLength: MAX_STATIC_PAGE_BYTES,
    responseType: "text",
    transformResponse: [(value: string) => value],
    validateStatus: (status) => status >= 200 && status < 300,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        process.env.CRAWLER_USER_AGENT ??
        "DistributedRagScraper/0.1 (+https://github.com/NourFakih/distributed-rag-scraper)",
    },
  });

  const contentTypeHeader = response.headers["content-type"];
  const contentType =
    typeof contentTypeHeader === "string" ? contentTypeHeader : null;

  if (
    !contentType ||
    !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)
  ) {
    throw new StaticPageScrapeError(
      `Unsupported content type: ${contentType ?? "missing"}`,
    );
  }

  if (typeof response.data !== "string") {
    throw new StaticPageScrapeError("Static page response was not text");
  }

  if (Buffer.byteLength(response.data, "utf8") > MAX_STATIC_PAGE_BYTES) {
    throw new StaticPageScrapeError("Static page exceeded the 2 MiB limit");
  }

  const cleaned = cleanHtml(response.data);
  if (!cleaned.content) {
    throw new StaticPageScrapeError(
      "Static page did not contain readable content",
    );
  }

  return {
    url: response.request?.res?.responseUrl ?? url,
    title: cleaned.title,
    rawHtml: response.data,
    content: cleaned.content,
    httpStatus: response.status,
    contentType,
    fetchedAt: new Date(),
  };
}

