export {
  CRAWL_QUEUE_NAME,
  SCRAPE_STATIC_PAGE_JOB,
  crawlJobDataSchema,
} from "./contracts/crawl";
export type {
  CrawlJobData,
  CrawlJobName,
  CrawlJobResult,
} from "./contracts/crawl";
export { closePrisma, prisma } from "./db/prisma";
export { closeCrawlQueue, getCrawlQueue } from "./queue/crawl.queue";
export { createRedisConnection } from "./queue/redis";
export {
  MAX_CRAWL_URL_LENGTH,
  normalizeCrawlUrl,
  normalizedOrigin,
  UrlNormalizationError,
} from "./url/normalize-url";
export type {
  NormalizeCrawlUrlOptions,
  UrlNormalizationErrorCode,
} from "./url/normalize-url";
