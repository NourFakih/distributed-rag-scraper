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
      javascriptNavigationTimeoutMs: 15_000,
      javascriptSettleMs: 500,
      javascriptWaitSelector: undefined,
      javascriptWaitSelectorTimeoutMs: 5_000,
      javascriptMaxContexts: 2,
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

  it("loads bounded JavaScript renderer settings", () => {
    expect(
      loadCrawlerConfig({
        CRAWLER_JAVASCRIPT_NAVIGATION_TIMEOUT_MS: "20000",
        CRAWLER_JAVASCRIPT_SETTLE_MS: "250",
        CRAWLER_JAVASCRIPT_WAIT_SELECTOR: " #ready ",
        CRAWLER_JAVASCRIPT_WAIT_SELECTOR_TIMEOUT_MS: "3000",
        CRAWLER_JAVASCRIPT_MAX_CONTEXTS: "3",
      }),
    ).toMatchObject({
      javascriptNavigationTimeoutMs: 20_000,
      javascriptSettleMs: 250,
      javascriptWaitSelector: "#ready",
      javascriptWaitSelectorTimeoutMs: 3_000,
      javascriptMaxContexts: 3,
    });
  });

  it.each([
    ["CRAWLER_JAVASCRIPT_NAVIGATION_TIMEOUT_MS", "999"],
    ["CRAWLER_JAVASCRIPT_SETTLE_MS", "5001"],
    ["CRAWLER_JAVASCRIPT_WAIT_SELECTOR", "x".repeat(513)],
    ["CRAWLER_JAVASCRIPT_WAIT_SELECTOR_TIMEOUT_MS", "99"],
    ["CRAWLER_JAVASCRIPT_MAX_CONTEXTS", "11"],
  ])("rejects invalid renderer setting %s=%s", (name, value) => {
    expect(() =>
      loadCrawlerConfig({
        [name]: value,
      }),
    ).toThrow();
  });

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
