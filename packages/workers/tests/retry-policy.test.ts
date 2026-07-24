import { describe, expect, it } from "vitest";

import { CrawlFailure } from "../src/errors/crawl-failure";
import {
  calculateBackoffDelay,
  parseRetryAfter,
} from "../src/retry/retry-policy";

describe("retry policy", () => {
  it("parses Retry-After delta seconds and HTTP dates", () => {
    expect(parseRetryAfter("5", 0)).toBe(5_000);
    expect(
      parseRetryAfter(
        "Wed, 21 Oct 2015 07:28:00 GMT",
        Date.parse("Wed, 21 Oct 2015 07:27:55 GMT"),
      ),
    ).toBe(5_000);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });

  it("uses Retry-After before exponential fallback", () => {
    const failure = new CrawlFailure(
      "HTTP_429",
      "slow down",
      true,
      7_000,
    );

    expect(calculateBackoffDelay(1, failure)).toBe(7_000);
    expect(calculateBackoffDelay(1)).toBe(1_000);
    expect(calculateBackoffDelay(2)).toBe(2_000);
    expect(calculateBackoffDelay(3)).toBe(4_000);
  });

  it("retains retryable and permanent classification", () => {
    expect(
      new CrawlFailure("HTTP_503", "temporary", true).retryable,
    ).toBe(true);
    expect(
      new CrawlFailure("UNSAFE_TARGET", "private", false).retryable,
    ).toBe(false);
  });
});
