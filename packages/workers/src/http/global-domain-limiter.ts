import { randomUUID } from "node:crypto";
import type IORedis from "ioredis";

import { CrawlFailure } from "../errors/crawl-failure";

const ACQUIRE_DOMAIN_SLOT_SCRIPT = `
local acquired = redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX")
if acquired then
  return {1, tonumber(ARGV[2])}
end

local ttl = redis.call("PTTL", KEYS[1])
if ttl < 1 then
  return {0, 1}
end
return {0, ttl}
`;

export type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export function domainLimiterKey(url: URL): string {
  const effectivePort =
    url.port || (url.protocol === "https:" ? "443" : "80");
  return `crawler:domain-slot:v1:${encodeURIComponent(
    url.hostname.toLowerCase(),
  )}:${effectivePort}`;
}

export class GlobalDomainLimiter {
  public constructor(
    private readonly redis: IORedis,
    private readonly defaultIntervalMs: number,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  public async acquire(
    url: URL,
    crawlDelayMs?: number,
  ): Promise<void> {
    const intervalMs = Math.max(
      this.defaultIntervalMs,
      crawlDelayMs ?? 0,
    );
    const key = domainLimiterKey(url);

    while (true) {
      let result: unknown;
      try {
        result = await this.redis.eval(
          ACQUIRE_DOMAIN_SLOT_SCRIPT,
          1,
          key,
          randomUUID(),
          intervalMs,
        );
      } catch (error: unknown) {
        throw new CrawlFailure(
          "RATE_LIMIT_UNAVAILABLE",
          "The global domain limiter is temporarily unavailable",
          true,
          undefined,
          { cause: error },
        );
      }

      if (
        !Array.isArray(result) ||
        result.length !== 2 ||
        typeof result[0] !== "number" ||
        typeof result[1] !== "number"
      ) {
        throw new CrawlFailure(
          "RATE_LIMIT_UNAVAILABLE",
          "The global domain limiter returned an invalid response",
          true,
        );
      }

      const [acquired, remainingTtlMs] = result;
      if (acquired === 1) {
        return;
      }

      await this.sleep(Math.max(remainingTtlMs, 1));
    }
  }
}
