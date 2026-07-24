import type { CrawlerConfig } from "@distributed-rag/shared";
import {
  errors,
  type Download,
  type Request,
  type Response,
  type Route,
} from "playwright";

import {
  CrawlFailure,
  RobotsExcludedError,
} from "../errors/crawl-failure";
import {
  retryableHttpFailure,
  type CrawlerHttpResponse,
} from "../http/crawler-http-client";
import type { GlobalDomainLimiter } from "../http/global-domain-limiter";
import {
  MAX_STATIC_PAGE_BYTES,
} from "../scraping/static-page.scraper";
import type { RobotsService } from "../robots/robots.service";
import {
  processPageSource,
  type PageSource,
  type ProcessedPage,
} from "../processing/process-page";
import type { BrowserManager } from "./browser-manager";
import type { NavigationGuard } from "./navigation-guard";

const MAX_TOP_LEVEL_REQUESTS = 6;

export interface JavaScriptRenderRequest {
  url: string;
  allowedOrigin: string;
  crawlDelayMs?: number;
}

function isMainNavigation(request: Request): boolean {
  return (
    request.isNavigationRequest() &&
    request.frame() === request.frame().page().mainFrame()
  );
}

function responseHeaders(
  response: Response | null,
): Promise<Record<string, string>> {
  return response ? response.allHeaders() : Promise.resolve({});
}

function browserFailure(error: unknown): CrawlFailure {
  if (error instanceof CrawlFailure) {
    return error;
  }
  if (error instanceof errors.TimeoutError) {
    return new CrawlFailure(
      "BROWSER_TIMEOUT",
      "JavaScript page navigation timed out",
      true,
      undefined,
      { cause: error },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/browser.*(?:closed|crash|disconnect)|target.*closed/iu.test(message)) {
    return new CrawlFailure(
      "BROWSER_CRASH",
      "Chromium closed unexpectedly while rendering the page",
      true,
      undefined,
      { cause: error },
    );
  }
  return new CrawlFailure(
    "BROWSER_NAVIGATION",
    "Chromium could not complete the page navigation",
    true,
    undefined,
    { cause: error },
  );
}

export class JavaScriptPageRenderer {
  public constructor(
    private readonly config: CrawlerConfig,
    private readonly browserManager: BrowserManager,
    private readonly navigationGuard: NavigationGuard,
    private readonly limiter: GlobalDomainLimiter,
    private readonly robotsService: RobotsService,
  ) {}

  public async render(
    request: JavaScriptRenderRequest,
  ): Promise<ProcessedPage> {
    const initialUrl = await this.navigationGuard.validate(
      request.url,
      request.allowedOrigin,
    );
    await this.limiter.acquire(new URL(initialUrl), request.crawlDelayMs);

    try {
      return await this.browserManager.withPage(
        this.config.userAgent,
        async ({ context, page }) => {
          let terminalFailure: Error | undefined;
          let topLevelRequests = 0;
          let latestNavigationResponse: Response | null = null;

          const reject = async (
            route: Route,
            failure: Error,
          ): Promise<void> => {
            terminalFailure ??= failure;
            await route.abort("blockedbyclient").catch(() => undefined);
          };

          await context.route("**/*", async (route) => {
            const browserRequest = route.request();
            const routeUrl = browserRequest.url();
            const protocol = new URL(routeUrl).protocol;
            if (protocol !== "http:" && protocol !== "https:") {
              await reject(
                route,
                new CrawlFailure(
                  "INVALID_URL",
                  "Chromium attempted a non-HTTP request",
                  false,
                ),
              );
              return;
            }

            try {
              const mainNavigation = isMainNavigation(browserRequest);
              const validatedUrl = await this.navigationGuard.validate(
                routeUrl,
                mainNavigation ? request.allowedOrigin : undefined,
              );

              if (mainNavigation) {
                topLevelRequests += 1;
                if (topLevelRequests > MAX_TOP_LEVEL_REQUESTS) {
                  throw new CrawlFailure(
                    "INVALID_REDIRECT",
                    "Chromium exceeded five navigation redirects",
                    false,
                  );
                }

                if (topLevelRequests > 1) {
                  const robotsDecision =
                    await this.robotsService.check(
                      validatedUrl,
                      request.allowedOrigin,
                    );
                  if (!robotsDecision.allowed) {
                    throw new RobotsExcludedError(validatedUrl);
                  }
                  await this.limiter.acquire(
                    new URL(validatedUrl),
                    robotsDecision.crawlDelayMs,
                  );
                }
              }

              await route.continue();
            } catch (error: unknown) {
              await reject(
                route,
                error instanceof Error
                  ? error
                  : new Error(String(error)),
              );
            }
          });

          context.on("page", (openedPage) => {
            if (openedPage !== page) {
              void openedPage.close().catch(() => undefined);
            }
          });
          page.on("popup", (popup) => {
            void popup.close().catch(() => undefined);
          });
          page.on("download", (download: Download) => {
            terminalFailure ??= new CrawlFailure(
              "UNSUPPORTED_CONTENT_TYPE",
              "Chromium navigation attempted a download",
              false,
            );
            void download.cancel().catch(() => undefined);
          });
          page.on("crash", () => {
            terminalFailure ??= new CrawlFailure(
              "BROWSER_CRASH",
              "Chromium crashed while rendering the page",
              true,
            );
          });
          page.on("response", (response) => {
            if (isMainNavigation(response.request())) {
              latestNavigationResponse = response;
            }
          });

          page.setDefaultNavigationTimeout(
            this.config.javascriptNavigationTimeoutMs,
          );
          await context.addInitScript({
            content:
              "Object.defineProperty(window, 'open', " +
              "{ configurable: false, value: () => null, writable: false });",
          });
          let gotoResponse: Response | null;
          try {
            gotoResponse = await page.goto(initialUrl, {
              waitUntil: "domcontentloaded",
              timeout: this.config.javascriptNavigationTimeoutMs,
            });
          } catch (navigationError: unknown) {
            if (terminalFailure) {
              throw terminalFailure;
            }
            throw navigationError;
          }
          if (terminalFailure) {
            throw terminalFailure;
          }

          try {
            if (this.config.javascriptWaitSelector) {
              await page.waitForSelector(
                this.config.javascriptWaitSelector,
                {
                  state: "attached",
                  timeout:
                    this.config.javascriptWaitSelectorTimeoutMs,
                },
              );
            }
            if (this.config.javascriptSettleMs > 0) {
              await page.waitForTimeout(
                this.config.javascriptSettleMs,
              );
            }
          } catch (settlingError: unknown) {
            if (terminalFailure) {
              throw terminalFailure;
            }
            throw settlingError;
          }
          if (terminalFailure) {
            throw terminalFailure;
          }

          const finalUrl = await this.navigationGuard.validate(
            page.url(),
            request.allowedOrigin,
          );
          const finalResponse =
            latestNavigationResponse ?? gotoResponse;
          const headers = await responseHeaders(finalResponse);
          const httpStatus = finalResponse?.status() ?? 0;
          const contentType = headers["content-type"] ?? null;
          const rawHtml = await page.content();

          const syntheticResponse: CrawlerHttpResponse = {
            url: finalUrl,
            status: httpStatus,
            headers,
            data: rawHtml,
          };
          const retryableFailure =
            retryableHttpFailure(syntheticResponse);
          if (retryableFailure) {
            throw retryableFailure;
          }
          if (httpStatus < 200 || httpStatus >= 300) {
            throw new CrawlFailure(
              "HTTP_PERMANENT",
              `JavaScript page returned HTTP ${httpStatus}`,
              false,
            );
          }
          if (
            !contentType ||
            !/^(text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(
              contentType,
            )
          ) {
            throw new CrawlFailure(
              "UNSUPPORTED_CONTENT_TYPE",
              `Unsupported content type: ${contentType ?? "missing"}`,
              false,
            );
          }
          if (
            Buffer.byteLength(rawHtml, "utf8") >
            MAX_STATIC_PAGE_BYTES
          ) {
            throw new CrawlFailure(
              "RESPONSE_TOO_LARGE",
              "Rendered page exceeded the 2 MiB limit",
              false,
            );
          }

          const source: PageSource = {
            url: finalUrl,
            title: await page.title(),
            rawHtml,
            httpStatus,
            headers,
            contentType,
            fetchedAt: new Date(),
          };
          return processPageSource(source);
        },
      );
    } catch (error: unknown) {
      if (error instanceof RobotsExcludedError) {
        throw error;
      }
      throw browserFailure(error);
    }
  }
}
