import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import axios from "axios";
import type {
  AxiosRequestConfig,
  AxiosResponse,
} from "axios";
import {
  normalizeCrawlUrl,
  UrlNormalizationError,
  type CrawlerConfig,
} from "@distributed-rag/shared";

import {
  CrawlFailure,
  RobotsExcludedError,
} from "../errors/crawl-failure";
import { parseRetryAfter } from "../retry/retry-policy";
import type { GlobalDomainLimiter } from "./global-domain-limiter";
import {
  defaultDnsResolver,
  resolveAndValidateTarget,
  type DnsResolver,
} from "./ip-safety";

export const CRAWLER_HTTP_TIMEOUT_MS = 15_000;
export const MAX_CRAWLER_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface CrawlerHttpRequest {
  url: string;
  allowedOrigin: string;
  accept: string;
  maxResponseBytes: number;
  crawlDelayMs?: number;
  requestHeaders?: Readonly<Record<string, string>>;
  checkRedirectPolicy?: (
    url: string,
  ) => Promise<{ allowed: boolean; crawlDelayMs?: number }>;
}

export interface CrawlerHttpResponse {
  url: string;
  status: number;
  headers: Record<string, string | undefined>;
  data: string;
}

export type HttpTransport = (
  configuration: AxiosRequestConfig,
) => Promise<AxiosResponse<string>>;

function responseHeaders(
  response: AxiosResponse<string>,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    normalized[name.toLowerCase()] =
      value === undefined ? undefined : String(value);
  }
  return normalized;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function networkFailure(error: unknown): CrawlFailure {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);

  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return new CrawlFailure(
      "NETWORK_TIMEOUT",
      "Crawler request timed out",
      true,
      undefined,
      { cause: error },
    );
  }
  if (code === "ECONNRESET") {
    return new CrawlFailure(
      "CONNECTION_RESET",
      "Crawler connection was reset",
      true,
      undefined,
      { cause: error },
    );
  }
  if (code === "EAI_AGAIN") {
    return new CrawlFailure(
      "DNS_TEMPORARY",
      "DNS resolution is temporarily unavailable",
      true,
      undefined,
      { cause: error },
    );
  }
  if (code === "ENOTFOUND") {
    return new CrawlFailure(
      "DNS_FAILURE",
      "Crawler target could not be resolved",
      false,
      undefined,
      { cause: error },
    );
  }
  if (/maxContentLength|maxBodyLength/iu.test(message)) {
    return new CrawlFailure(
      "RESPONSE_TOO_LARGE",
      "Crawler response exceeded its size limit",
      false,
      undefined,
      { cause: error },
    );
  }

  return new CrawlFailure("UNKNOWN", message, true, undefined, {
    cause: error,
  });
}

function normalizedHop(url: string, allowedOrigin: string): string {
  try {
    return normalizeCrawlUrl(url, {
      allowedOrigin,
      rejectDownloadable: false,
    });
  } catch (error: unknown) {
    if (error instanceof UrlNormalizationError) {
      const category =
        error.code === "EXTERNAL_ORIGIN"
          ? "SAME_ORIGIN_VIOLATION"
          : "INVALID_URL";
      throw new CrawlFailure(category, error.message, false, undefined, {
        cause: error,
      });
    }
    throw error;
  }
}

function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = options.family;
    const eligible =
      requestedFamily === 4 || requestedFamily === 6
        ? addresses.filter((address) => address.family === requestedFamily)
        : addresses;
    const selected = eligible[0] ?? addresses[0];

    if (!selected) {
      const error = new Error("No validated DNS address is available");
      Object.assign(error, { code: "ENOTFOUND" });
      callback(error, "", 0);
      return;
    }

    if (options.all) {
      callback(null, eligible.length > 0 ? eligible : addresses);
      return;
    }

    callback(null, selected.address, selected.family);
  };
}

export function retryableHttpFailure(
  response: CrawlerHttpResponse,
): CrawlFailure | undefined {
  const categoryByStatus = {
    429: "HTTP_429",
    502: "HTTP_502",
    503: "HTTP_503",
    504: "HTTP_504",
  } as const;
  const category =
    categoryByStatus[
      response.status as keyof typeof categoryByStatus
    ];
  if (!category) {
    return undefined;
  }

  return new CrawlFailure(
    category,
    `Crawler request returned HTTP ${response.status}`,
    true,
    parseRetryAfter(response.headers["retry-after"]),
  );
}

export class CrawlerHttpClient {
  public constructor(
    private readonly config: CrawlerConfig,
    private readonly limiter: GlobalDomainLimiter,
    private readonly resolver: DnsResolver = defaultDnsResolver,
    private readonly transport: HttpTransport = (configuration) =>
      axios.request<string>(configuration),
  ) {}

  public async request(
    request: CrawlerHttpRequest,
  ): Promise<CrawlerHttpResponse> {
    let currentUrl = normalizedHop(request.url, request.allowedOrigin);
    let crawlDelayMs = request.crawlDelayMs;

    for (
      let redirectCount = 0;
      redirectCount <= MAX_CRAWLER_REDIRECTS;
      redirectCount += 1
    ) {
      const parsed = new URL(currentUrl);
      const dnsHostname = parsed.hostname.replace(/^\[|\]$/gu, "");
      const addresses = await resolveAndValidateTarget(
        dnsHostname,
        this.resolver,
        this.config.allowPrivateTestTargets,
      );
      await this.limiter.acquire(parsed, crawlDelayMs);

      const lookup = pinnedLookup(addresses);
      const httpAgent = new http.Agent({ lookup });
      const httpsAgent = new https.Agent({ lookup });

      let response: AxiosResponse<string>;
      try {
        response = await this.transport({
          method: "GET",
          url: currentUrl,
          timeout: CRAWLER_HTTP_TIMEOUT_MS,
          maxRedirects: 0,
          maxContentLength: request.maxResponseBytes,
          maxBodyLength: request.maxResponseBytes,
          responseType: "text",
          transformResponse: [(value: string) => value],
          validateStatus: () => true,
          proxy: false,
          httpAgent,
          httpsAgent,
          headers: {
            ...request.requestHeaders,
            Accept: request.accept,
            "User-Agent": this.config.userAgent,
          },
        });
      } catch (error: unknown) {
        throw networkFailure(error);
      } finally {
        httpAgent.destroy();
        httpsAgent.destroy();
      }

      if (typeof response.data !== "string") {
        throw new CrawlFailure(
          "HTTP_PERMANENT",
          "Crawler response was not text",
          false,
        );
      }
      if (
        Buffer.byteLength(response.data, "utf8") >
        request.maxResponseBytes
      ) {
        throw new CrawlFailure(
          "RESPONSE_TOO_LARGE",
          "Crawler response exceeded its size limit",
          false,
        );
      }

      const headers = responseHeaders(response);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = headers.location;
        if (!location || redirectCount === MAX_CRAWLER_REDIRECTS) {
          throw new CrawlFailure(
            "INVALID_REDIRECT",
            location
              ? `Crawler exceeded ${MAX_CRAWLER_REDIRECTS} redirects`
              : "Crawler redirect did not include a Location header",
            false,
          );
        }

        try {
          const redirectUrl = normalizedHop(
            new URL(location, currentUrl).toString(),
            request.allowedOrigin,
          );
          if (request.checkRedirectPolicy) {
            const decision =
              await request.checkRedirectPolicy(redirectUrl);
            if (!decision.allowed) {
              throw new RobotsExcludedError(redirectUrl);
            }
            crawlDelayMs = decision.crawlDelayMs;
          }
          currentUrl = redirectUrl;
        } catch (error: unknown) {
          if (
            error instanceof CrawlFailure ||
            error instanceof RobotsExcludedError
          ) {
            throw error;
          }
          throw new CrawlFailure(
            "INVALID_REDIRECT",
            "Crawler redirect destination was invalid",
            false,
            undefined,
            { cause: error },
          );
        }
        continue;
      }

      return {
        url: currentUrl,
        status: response.status,
        headers,
        data: response.data,
      };
    }

    throw new CrawlFailure(
      "INVALID_REDIRECT",
      `Crawler exceeded ${MAX_CRAWLER_REDIRECTS} redirects`,
      false,
    );
  }
}
