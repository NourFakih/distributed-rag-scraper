import {
  createRedisConnection,
  loadCrawlerConfig,
  type CrawlerConfig,
} from "@distributed-rag/shared";
import type IORedis from "ioredis";

import { CrawlerHttpClient } from "../http/crawler-http-client";
import { GlobalDomainLimiter } from "../http/global-domain-limiter";
import { RobotsService } from "../robots/robots.service";

export interface CrawlerServices {
  config: CrawlerConfig;
  httpClient: CrawlerHttpClient;
  robotsService: RobotsService;
}

interface CrawlerServicesRuntime extends CrawlerServices {
  redis: IORedis;
}

let runtime: CrawlerServicesRuntime | undefined;

export function getCrawlerServices(): CrawlerServices {
  if (!runtime) {
    const config = loadCrawlerConfig();
    const redis = createRedisConnection("crawler-network-services");
    const limiter = new GlobalDomainLimiter(
      redis,
      config.defaultIntervalMs,
    );
    const httpClient = new CrawlerHttpClient(config, limiter);
    const robotsService = new RobotsService(redis, httpClient, config);
    runtime = {
      config,
      redis,
      httpClient,
      robotsService,
    };
  }

  return runtime;
}

export async function closeCrawlerServices(): Promise<void> {
  const current = runtime;
  runtime = undefined;

  if (current?.redis.status !== "end") {
    await current?.redis.quit();
  }
}
