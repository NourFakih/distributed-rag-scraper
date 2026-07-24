import {
  normalizeCrawlUrl,
  normalizedOrigin,
} from "../src/url/normalize-url";
import type { UrlNormalizationError } from "../src/url/normalize-url";
import { describe, expect, it } from "vitest";

describe("normalizeCrawlUrl", () => {
  it.each([
    [
      "normalizes scheme, host, and a default port",
      "HTTP://EXAMPLE.COM:80/docs/?b=2&a=1#part",
      {},
      "http://example.com/docs/?b=2&a=1",
    ],
    [
      "preserves an explicit trailing slash",
      "https://example.com/docs/",
      {},
      "https://example.com/docs/",
    ],
    [
      "preserves a missing trailing slash",
      "https://example.com/docs",
      {},
      "https://example.com/docs",
    ],
    [
      "resolves a relative path against the final page",
      "../guide?x=1&x=2#section",
      {
        baseUrl: "https://example.com/docs/start/",
        allowedOrigin: "https://example.com",
      },
      "https://example.com/docs/guide?x=1&x=2",
    ],
    [
      "preserves query order and values",
      "?z=last&a=first&a=second",
      {
        baseUrl: "https://example.com/docs/page",
        allowedOrigin: "https://example.com",
      },
      "https://example.com/docs/page?z=last&a=first&a=second",
    ],
  ])("%s", (_label, input, options, expected) => {
    expect(normalizeCrawlUrl(input, options)).toBe(expected);
  });

  it.each([
    ["relative seed", "/docs", {}, "INVALID_URL"],
    ["credentials", "https://user:secret@example.com/", {}, "CREDENTIALS_NOT_ALLOWED"],
    ["mailto", "mailto:team@example.com", {}, "UNSUPPORTED_PROTOCOL"],
    ["telephone", "tel:+123", {}, "UNSUPPORTED_PROTOCOL"],
    ["javascript", "javascript:alert(1)", {}, "UNSUPPORTED_PROTOCOL"],
    ["data", "data:text/plain,hello", {}, "UNSUPPORTED_PROTOCOL"],
    ["file", "file:///tmp/page.html", {}, "UNSUPPORTED_PROTOCOL"],
    [
      "external origin",
      "https://cdn.example.com/page",
      { allowedOrigin: "https://example.com" },
      "EXTERNAL_ORIGIN",
    ],
    ["download", "https://example.com/report.PDF?latest=1", {}, "DOWNLOADABLE_URL"],
    [
      "oversized URL",
      `https://example.com/${"a".repeat(2_100)}`,
      {},
      "URL_TOO_LONG",
    ],
  ])("rejects %s", (_label, input, options, code) => {
    expect(() => normalizeCrawlUrl(input, options)).toThrow(
      expect.objectContaining<Partial<UrlNormalizationError>>({
        code,
      }),
    );
  });

  it("returns a normalized origin", () => {
    expect(normalizedOrigin("HTTPS://EXAMPLE.COM:443/docs")).toBe(
      "https://example.com",
    );
  });
});
