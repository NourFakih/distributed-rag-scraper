import type { AxiosInstance, AxiosResponse } from "axios";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_STATIC_PAGE_BYTES,
  scrapeStaticPage,
  StaticPageScrapeError,
} from "../src/scraping/static-page.scraper";
import {
  EXPECTED_FIXTURE_CONTENT,
  FIXTURE_HTML,
} from "./fixture";


function clientReturning(
  response: Partial<AxiosResponse<string>>,
): AxiosInstance {
  return {
    get: vi.fn().mockResolvedValue({
      data: FIXTURE_HTML,
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
      ...response,
    }),
  } as unknown as AxiosInstance;
}

describe("scrapeStaticPage", () => {
  it("returns raw HTML, HTTP metadata, and normalized content", async () => {
    const result = await scrapeStaticPage(
      "https://fixture.test/page",
      clientReturning({}),
    );

    expect(result.title).toBe("Deterministic Crawl Fixture");
    expect(result.rawHtml).toBe(FIXTURE_HTML);
    expect(result.content).toBe(EXPECTED_FIXTURE_CONTENT);
    expect(result.httpStatus).toBe(200);
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(result.fetchedAt).toBeInstanceOf(Date);
  });

  it("rejects a non-HTML response", async () => {
    await expect(
      scrapeStaticPage(
        "https://fixture.test/data.json",
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
        clientReturning({
          data: "<html><body><script>noise</script></body></html>",
        }),
      ),
    ).rejects.toBeInstanceOf(StaticPageScrapeError);
  });

  it("propagates HTTP and timeout errors from Axios", async () => {
    const client = {
      get: vi.fn().mockRejectedValue(new Error("timeout of 15000ms exceeded")),
    } as unknown as AxiosInstance;

    await expect(
      scrapeStaticPage("https://fixture.test/timeout", client),
    ).rejects.toThrow("timeout of 15000ms exceeded");
  });
});
