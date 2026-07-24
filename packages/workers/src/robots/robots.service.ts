import { randomUUID } from "node:crypto";
import {
  MAX_ROBOTS_CACHE_TTL_SECONDS,
  type CrawlerConfig,
} from "@distributed-rag/shared";
import type IORedis from "ioredis";
import robotsParser from "robots-parser";

import { CrawlFailure } from "../errors/crawl-failure";
import type { Sleep } from "../http/global-domain-limiter";
import type {
  CrawlerHttpClient,
  CrawlerHttpResponse,
} from "../http/crawler-http-client";
import { parseRetryAfter } from "../retry/retry-policy";

export const MAX_ROBOTS_BYTES = 512 * 1024;
export const ROBOTS_LOCK_TTL_MS = 2 * 60 * 1_000;

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

type CachedRobotsPolicy =
  | {
      kind: "rules";
      body: string;
    }
  | {
      kind: "allow-all";
    };

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs?: number;
}

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

function originKeyPart(origin: string): string {
  return encodeURIComponent(new URL(origin).origin);
}

export function robotsCacheKey(origin: string): string {
  return `crawler:robots:v1:${originKeyPart(origin)}`;
}

export function robotsLockKey(origin: string): string {
  return `crawler:robots-lock:v1:${originKeyPart(origin)}`;
}

function validCrawlDelayMs(
  policy: ReturnType<typeof robotsParser>,
  userAgent: string,
): number | undefined {
  const seconds = policy.getCrawlDelay(userAgent);
  if (
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return undefined;
  }

  return Math.min(seconds * 1_000, 24 * 60 * 60 * 1_000);
}

function decisionFromPolicy(
  cached: CachedRobotsPolicy,
  robotsUrl: string,
  pageUrl: string,
  userAgent: string,
): RobotsDecision {
  if (cached.kind === "allow-all") {
    return {
      allowed: true,
    };
  }

  const policy = robotsParser(robotsUrl, cached.body);
  return {
    allowed: policy.isAllowed(pageUrl, userAgent) !== false,
    crawlDelayMs: validCrawlDelayMs(policy, userAgent),
  };
}

function robotsUnreachable(
  response: CrawlerHttpResponse,
): CrawlFailure {
  return new CrawlFailure(
    "ROBOTS_UNREACHABLE",
    `robots.txt returned HTTP ${response.status}`,
    true,
    parseRetryAfter(response.headers["retry-after"]),
  );
}

export class RobotsService {
  public constructor(
    private readonly redis: IORedis,
    private readonly httpClient: CrawlerHttpClient,
    private readonly config: CrawlerConfig,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  private async readCache(
    origin: string,
  ): Promise<CachedRobotsPolicy | null> {
    try {
      const serialized = await this.redis.get(robotsCacheKey(origin));
      if (!serialized) {
        return null;
      }
      const parsed = JSON.parse(serialized) as CachedRobotsPolicy;
      if (
        parsed.kind === "allow-all" ||
        (parsed.kind === "rules" && typeof parsed.body === "string")
      ) {
        return parsed;
      }
      return null;
    } catch (error: unknown) {
      throw new CrawlFailure(
        "ROBOTS_UNREACHABLE",
        "The cached robots policy is temporarily unavailable",
        true,
        undefined,
        { cause: error },
      );
    }
  }

  private async writeCache(
    origin: string,
    policy: CachedRobotsPolicy,
  ): Promise<void> {
    try {
      await this.redis.set(
        robotsCacheKey(origin),
        JSON.stringify(policy),
        "EX",
        MAX_ROBOTS_CACHE_TTL_SECONDS,
      );
    } catch (error: unknown) {
      throw new CrawlFailure(
        "ROBOTS_UNREACHABLE",
        "The robots policy could not be cached",
        true,
        undefined,
        { cause: error },
      );
    }
  }

  private async fetchPolicy(
    origin: string,
    robotsUrl: string,
  ): Promise<CachedRobotsPolicy> {
    let response: CrawlerHttpResponse;
    try {
      response = await this.httpClient.request({
        url: robotsUrl,
        allowedOrigin: origin,
        accept: "text/plain,text/*;q=0.9,*/*;q=0.1",
        maxResponseBytes: MAX_ROBOTS_BYTES,
      });
    } catch (error: unknown) {
      if (
        error instanceof CrawlFailure &&
        [
          "UNSAFE_TARGET",
          "SAME_ORIGIN_VIOLATION",
          "INVALID_REDIRECT",
          "INVALID_URL",
        ].includes(error.category)
      ) {
        throw error;
      }
      const failure =
        error instanceof CrawlFailure
          ? error
          : new CrawlFailure("UNKNOWN", String(error), true);
      throw new CrawlFailure(
        "ROBOTS_UNREACHABLE",
        "robots.txt is temporarily unreachable",
        true,
        failure.retryAfterMs,
        { cause: error },
      );
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        kind: "rules",
        body: response.data,
      };
    }
    if (response.status >= 400 && response.status < 500) {
      return {
        kind: "allow-all",
      };
    }

    throw robotsUnreachable(response);
  }

  public async check(
    pageUrl: string,
    normalizedOrigin: string,
  ): Promise<RobotsDecision> {
    const origin = new URL(normalizedOrigin).origin;
    const robotsUrl = new URL("/robots.txt", `${origin}/`).toString();

    while (true) {
      const cached = await this.readCache(origin);
      if (cached) {
        return decisionFromPolicy(
          cached,
          robotsUrl,
          pageUrl,
          this.config.userAgent,
        );
      }

      const token = randomUUID();
      let acquired: string | null;
      try {
        acquired = await this.redis.set(
          robotsLockKey(origin),
          token,
          "PX",
          ROBOTS_LOCK_TTL_MS,
          "NX",
        );
      } catch (error: unknown) {
        throw new CrawlFailure(
          "ROBOTS_UNREACHABLE",
          "The robots single-flight lock is temporarily unavailable",
          true,
          undefined,
          { cause: error },
        );
      }

      if (acquired === "OK") {
        try {
          const policy = await this.fetchPolicy(origin, robotsUrl);
          await this.writeCache(origin, policy);
          return decisionFromPolicy(
            policy,
            robotsUrl,
            pageUrl,
            this.config.userAgent,
          );
        } finally {
          await this.redis
            .eval(
              RELEASE_LOCK_SCRIPT,
              1,
              robotsLockKey(origin),
              token,
            )
            .catch(() => undefined);
        }
      }

      let remainingTtlMs: number;
      try {
        remainingTtlMs = await this.redis.pttl(robotsLockKey(origin));
      } catch (error: unknown) {
        throw new CrawlFailure(
          "ROBOTS_UNREACHABLE",
          "The robots single-flight lock could not be inspected",
          true,
          undefined,
          { cause: error },
        );
      }
      await this.sleep(
        Math.min(Math.max(remainingTtlMs, 1), 250),
      );
    }
  }
}
