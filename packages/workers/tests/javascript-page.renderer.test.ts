import type { CrawlerConfig } from "@distributed-rag/shared";
import { errors } from "playwright";
import { describe, expect, it, vi } from "vitest";

import type { GlobalDomainLimiter } from "../src/http/global-domain-limiter";
import type { BrowserManager } from "../src/rendering/browser-manager";
import { JavaScriptPageRenderer } from "../src/rendering/javascript-page.renderer";
import type { NavigationGuard } from "../src/rendering/navigation-guard";
import type { RobotsService } from "../src/robots/robots.service";

const config: CrawlerConfig = {
  userAgent: "FixtureBot/1.0",
  defaultIntervalMs: 1,
  javascriptNavigationTimeoutMs: 1_000,
  javascriptSettleMs: 0,
  javascriptWaitSelector: undefined,
  javascriptWaitSelectorTimeoutMs: 500,
  javascriptMaxContexts: 1,
  allowPrivateTestTargets: true,
};

function rendererRejecting(error: Error) {
  const acquire = vi.fn().mockResolvedValue(undefined);
  const validate = vi
    .fn()
    .mockImplementation(async (url: string) => url);
  const renderer = new JavaScriptPageRenderer(
    config,
    {
      withPage: vi.fn().mockRejectedValue(error),
    } as unknown as BrowserManager,
    { validate } as unknown as NavigationGuard,
    { acquire } as unknown as GlobalDomainLimiter,
    {} as RobotsService,
  );
  return { acquire, renderer, validate };
}

describe("JavaScriptPageRenderer failures", () => {
  it("classifies browser timeouts as retryable", async () => {
    const fixture = rendererRejecting(
      new errors.TimeoutError("fixture timeout"),
    );

    await expect(
      fixture.renderer.render({
        url: "https://example.com/",
        allowedOrigin: "https://example.com",
      }),
    ).rejects.toMatchObject({
      category: "BROWSER_TIMEOUT",
      retryable: true,
    });
    expect(fixture.acquire).toHaveBeenCalledTimes(1);
  });

  it("classifies browser crashes as retryable", async () => {
    const fixture = rendererRejecting(
      new Error("Target page, context or browser has been closed"),
    );

    await expect(
      fixture.renderer.render({
        url: "https://example.com/",
        allowedOrigin: "https://example.com",
      }),
    ).rejects.toMatchObject({
      category: "BROWSER_CRASH",
      retryable: true,
    });
  });
});
