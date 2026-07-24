import type { CrawlerConfig } from "@distributed-rag/shared";
import type IORedis from "ioredis";
import { describe, expect, it, vi } from "vitest";

import { CrawlFailure } from "../src/errors/crawl-failure";
import type {
  CrawlerHttpClient,
  CrawlerHttpResponse,
} from "../src/http/crawler-http-client";
import { RobotsService } from "../src/robots/robots.service";

class FakeRedis {
  private readonly values = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  private current(key: string) {
    const current = this.values.get(key);
    if (current && current.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return current;
  }

  public async get(key: string): Promise<string | null> {
    return this.current(key)?.value ?? null;
  }

  public async set(
    key: string,
    value: string,
    mode: "EX" | "PX",
    duration: number,
    condition?: "NX",
  ): Promise<"OK" | null> {
    if (condition === "NX" && this.current(key)) {
      return null;
    }
    this.values.set(key, {
      value,
      expiresAt:
        Date.now() + (mode === "EX" ? duration * 1_000 : duration),
    });
    return "OK";
  }

  public async pttl(key: string): Promise<number> {
    const current = this.current(key);
    return current ? Math.max(current.expiresAt - Date.now(), 1) : -2;
  }

  public async eval(
    _script: string,
    _keys: number,
    key: string,
    token: string,
  ): Promise<number> {
    if (this.current(key)?.value === token) {
      this.values.delete(key);
      return 1;
    }
    return 0;
  }
}

const config: CrawlerConfig = {
  userAgent: "FixtureBot/1.0",
  defaultIntervalMs: 1_000,
  javascriptNavigationTimeoutMs: 15_000,
  javascriptSettleMs: 0,
  javascriptWaitSelector: undefined,
  javascriptWaitSelectorTimeoutMs: 5_000,
  javascriptMaxContexts: 1,
  allowPrivateTestTargets: true,
};
const origin = "https://example.com";

function response(
  status: number,
  data: string,
  headers: Record<string, string> = {},
): CrawlerHttpResponse {
  return {
    url: `${origin}/robots.txt`,
    status,
    headers,
    data,
  };
}

function fixtureService(
  request: ReturnType<typeof vi.fn>,
  redis = new FakeRedis(),
) {
  return new RobotsService(
    redis as unknown as IORedis,
    { request } as unknown as CrawlerHttpClient,
    config,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  );
}

describe("RobotsService", () => {
  it("enforces allow/disallow rules and caches the parsed policy", async () => {
    const request = vi.fn().mockResolvedValue(
      response(
        200,
        "User-agent: *\nDisallow: /private\nAllow: /private/public\n",
      ),
    );
    const service = fixtureService(request);

    await expect(
      service.check(`${origin}/private`, origin),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      service.check(`${origin}/private/public`, origin),
    ).resolves.toMatchObject({ allowed: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("matches the configured crawler user-agent and reads Crawl-delay", async () => {
    const request = vi.fn().mockResolvedValue(
      response(
        200,
        [
          "User-agent: OtherBot",
          "Disallow: /",
          "User-agent: FixtureBot",
          "Disallow: /bot-private",
          "Crawl-delay: 3",
        ].join("\n"),
      ),
    );
    const service = fixtureService(request);

    await expect(
      service.check(`${origin}/bot-private`, origin),
    ).resolves.toEqual({
      allowed: false,
      crawlDelayMs: 3_000,
    });
    await expect(service.check(`${origin}/public`, origin)).resolves.toEqual({
      allowed: true,
      crawlDelayMs: 3_000,
    });
  });

  it("permits crawling and caches allow-all when robots returns 404", async () => {
    const request = vi.fn().mockResolvedValue(response(404, "not found"));
    const service = fixtureService(request);

    await expect(service.check(`${origin}/page`, origin)).resolves.toEqual({
      allowed: true,
    });
    await expect(service.check(`${origin}/other`, origin)).resolves.toEqual({
      allowed: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed for robots 5xx and network timeout", async () => {
    const unavailable = fixtureService(
      vi.fn().mockResolvedValue(response(503, "unavailable")),
    );
    await expect(
      unavailable.check(`${origin}/page`, origin),
    ).rejects.toMatchObject({
      category: "ROBOTS_UNREACHABLE",
      retryable: true,
    });

    const timeout = fixtureService(
      vi
        .fn()
        .mockRejectedValue(
          new CrawlFailure("NETWORK_TIMEOUT", "timeout", true),
        ),
    );
    await expect(timeout.check(`${origin}/page`, origin)).rejects.toMatchObject(
      {
        category: "ROBOTS_UNREACHABLE",
        retryable: true,
      },
    );
  });

  it("treats robots DNS failures as retryable robots unavailability", async () => {
    const unavailable = fixtureService(
      vi
        .fn()
        .mockRejectedValue(
          new CrawlFailure("DNS_FAILURE", "not found", false),
        ),
    );

    await expect(
      unavailable.check(`${origin}/page`, origin),
    ).rejects.toMatchObject({
      category: "ROBOTS_UNREACHABLE",
      retryable: true,
    });
  });

  it("single-flights concurrent checks so robots is fetched once", async () => {
    const request = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(200, "User-agent: *\nAllow: /\n");
    });
    const redis = new FakeRedis();
    const first = fixtureService(request, redis);
    const second = fixtureService(request, redis);

    await Promise.all([
      first.check(`${origin}/one`, origin),
      second.check(`${origin}/two`, origin),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
