import {
  DEFAULT_CRAWLER_USER_AGENT,
  loadCrawlerConfig,
} from "../src/config/crawler";
import { describe, expect, it } from "vitest";

describe("loadCrawlerConfig", () => {
  it("applies the documented crawler defaults", () => {
    expect(loadCrawlerConfig({})).toEqual({
      userAgent: DEFAULT_CRAWLER_USER_AGENT,
      defaultIntervalMs: 1_000,
      allowPrivateTestTargets: false,
    });
  });

  it.each(["0", "-1", "1.5", "not-a-number", "60001"])(
    "rejects invalid domain interval %s",
    (interval) => {
      expect(() =>
        loadCrawlerConfig({
          CRAWLER_DEFAULT_INTERVAL_MS: interval,
        }),
      ).toThrow();
    },
  );

  it("allows private targets only under an explicit test configuration", () => {
    expect(
      loadCrawlerConfig({
        NODE_ENV: "test",
        CRAWLER_ALLOW_PRIVATE_TEST_TARGETS: "true",
      }).allowPrivateTestTargets,
    ).toBe(true);

    expect(() =>
      loadCrawlerConfig({
        NODE_ENV: "production",
        CRAWLER_ALLOW_PRIVATE_TEST_TARGETS: "true",
      }),
    ).toThrow("Private crawler targets");
  });
});
