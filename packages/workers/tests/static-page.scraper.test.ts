import { describe, expect, it, vi } from "vitest";

import type {
  CrawlerHttpClient,
  CrawlerHttpResponse,
} from "../src/http/crawler-http-client";
import {
  MAX_STATIC_PAGE_BYTES,
  scrapeStaticPage,
} from "../src/scraping/static-page.scraper";
import {
  EXPECTED_FIXTURE_CONTENT,
  FIXTURE_HTML,
} from "./fixture";


function clientReturning(
  response: Partial<CrawlerHttpResponse>,
): CrawlerHttpClient {
  return {
    request: vi.fn().mockResolvedValue({
      url: "https://fixture.test/page",
      data: FIXTURE_HTML,
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
      ...response,
    }),
  } as unknown as CrawlerHttpClient;
}

describe("scrapeStaticPage", () => {
  it("returns raw HTML, HTTP metadata, and normalized content", async () => {
    const result = await scrapeStaticPage(
      "https://fixture.test/page",
      "https://fixture.test",
      clientReturning({}),
    );

    expect(result.title).toBe("Deterministic Crawl Fixture");
    expect(result.rawHtml).toBe(FIXTURE_HTML);
    expect(result.content).toBe(EXPECTED_FIXTURE_CONTENT);
    expect(result.httpStatus).toBe(200);
    expect(result.headers["content-type"]).toBe(
      "text/html; charset=utf-8",
    );
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(result.fetchedAt).toBeInstanceOf(Date);
  });

  it("rejects a non-HTML response", async () => {
    await expect(
      scrapeStaticPage(
        "https://fixture.test/data.json",
        "https://fixture.test",
        clientReturning({
          headers: {
            "content-type": "application/json",
          },
        }),
      ),
    ).rejects.toThrow("Unsupported content type");
  });

  it("rejects an oversized response even when a custom client ignores limits", async () => {
    await expect(
      scrapeStaticPage(
        "https://fixture.test/large",
        "https://fixture.test",
        clientReturning({
          data: `<main>${"x".repeat(MAX_STATIC_PAGE_BYTES + 1)}</main>`,
        }),
      ),
    ).rejects.toThrow("exceeded the 2 MiB limit");
  });

  it("rejects HTML without readable text", async () => {
    await expect(
      scrapeStaticPage(
        "https://fixture.test/empty",
        "https://fixture.test",
        clientReturning({
          data: "<html><body><script>noise</script></body></html>",
        }),
      ),
    ).rejects.toMatchObject({
      category: "EMPTY_CONTENT",
      retryable: false,
    });
  });

  it("propagates HTTP and timeout errors from Axios", async () => {
    const client = {
      request: vi
        .fn()
        .mockRejectedValue(new Error("timeout of 15000ms exceeded")),
    } as unknown as CrawlerHttpClient;

    await expect(
      scrapeStaticPage(
        "https://fixture.test/timeout",
        "https://fixture.test",
        client,
      ),
    ).rejects.toThrow("timeout of 15000ms exceeded");
  });
});
