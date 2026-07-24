import {
  createRedisConnection,
  type CrawlerConfig,
} from "@distributed-rag/shared";
import type IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  CrawlerHttpClient,
  CrawlerHttpResponse,
} from "../src/http/crawler-http-client";
import {
  domainLimiterKey,
  GlobalDomainLimiter,
} from "../src/http/global-domain-limiter";
import {
  robotsCacheKey,
  robotsLockKey,
  RobotsService,
} from "../src/robots/robots.service";

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

describe.runIf(runIntegrationTests)("Redis crawler politeness", () => {
  let firstRedis: IORedis;
  let secondRedis: IORedis;

  beforeAll(async () => {
    firstRedis = createRedisConnection("politeness-test-one");
    secondRedis = createRedisConnection("politeness-test-two");
    await Promise.all([firstRedis.connect(), secondRedis.connect()]);
  });

  afterAll(async () => {
    await Promise.all([firstRedis.quit(), secondRedis.quit()]);
  });

  it("spaces request starts across two independent Redis connections", async () => {
    const url = new URL("https://spacing-fixture.test:8443/page");
    await firstRedis.del(domainLimiterKey(url));
    const first = new GlobalDomainLimiter(firstRedis, 100);
    const second = new GlobalDomainLimiter(secondRedis, 100);

    await first.acquire(url);
    const startedAt = Date.now();
    await second.acquire(url);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);
  });

  it("uses Crawl-delay when it is larger than the default interval", async () => {
    const url = new URL("https://delay-fixture.test/page");
    await firstRedis.del(domainLimiterKey(url));
    const first = new GlobalDomainLimiter(firstRedis, 20);
    const second = new GlobalDomainLimiter(secondRedis, 20);

    await first.acquire(url, 150);
    const startedAt = Date.now();
    await second.acquire(url, 150);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
  });

  it("shares the robots cache and single-flight lock across services", async () => {
    const origin = "https://robots-cache-fixture.test";
    await firstRedis.del(robotsCacheKey(origin), robotsLockKey(origin));
    const request = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        url: `${origin}/robots.txt`,
        status: 200,
        headers: {},
        data: "User-agent: *\nAllow: /\n",
      } satisfies CrawlerHttpResponse;
    });
    const config: CrawlerConfig = {
      userAgent: "FixtureBot/1.0",
      defaultIntervalMs: 10,
      allowPrivateTestTargets: true,
    };
    const first = new RobotsService(
      firstRedis,
      { request } as unknown as CrawlerHttpClient,
      config,
    );
    const second = new RobotsService(
      secondRedis,
      { request } as unknown as CrawlerHttpClient,
      config,
    );

    await Promise.all([
      first.check(`${origin}/one`, origin),
      second.check(`${origin}/two`, origin),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    const ttl = await firstRedis.ttl(robotsCacheKey(origin));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);
  });
});
