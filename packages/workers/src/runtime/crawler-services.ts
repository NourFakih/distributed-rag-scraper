import {
  createRedisConnection,
  loadCrawlerConfig,
  type CrawlerConfig,
} from "@distributed-rag/shared";
import type IORedis from "ioredis";

import { CrawlerHttpClient } from "../http/crawler-http-client";
import { GlobalDomainLimiter } from "../http/global-domain-limiter";
import { BrowserManager } from "../rendering/browser-manager";
import { JavaScriptPageRenderer } from "../rendering/javascript-page.renderer";
import { NavigationGuard } from "../rendering/navigation-guard";
import { RobotsService } from "../robots/robots.service";

export interface CrawlerServices {
  config: CrawlerConfig;
  httpClient: CrawlerHttpClient;
  robotsService: RobotsService;
  javascriptRenderer: JavaScriptPageRenderer;
}

interface CrawlerServicesRuntime extends CrawlerServices {
  redis: IORedis;
  browserManager: BrowserManager;
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
    const browserManager = new BrowserManager(
      config.javascriptMaxContexts,
    );
    const navigationGuard = new NavigationGuard(config);
    const javascriptRenderer = new JavaScriptPageRenderer(
      config,
      browserManager,
      navigationGuard,
      limiter,
      robotsService,
    );
    runtime = {
      browserManager,
      config,
      redis,
      httpClient,
      robotsService,
      javascriptRenderer,
    };
  }

  return runtime;
}

export async function closeCrawlerServices(): Promise<void> {
  const current = runtime;
  runtime = undefined;

  if (current) {
    await current.browserManager.close();
    if (current.redis.status !== "end") {
      await current.redis.quit();
    }
  }
}
