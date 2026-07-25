export {
  CRAWL_QUEUE_NAME,
  SCRAPE_STATIC_PAGE_JOB,
  crawlJobDataSchema,
} from "./contracts/crawl";
export type {
  CompletedCrawlJobResult,
  CrawlJobData,
  CrawlJobName,
  CrawlJobResult,
  RobotsSkippedCrawlJobResult,
} from "./contracts/crawl";
export {
  DEFAULT_CRAWLER_USER_AGENT,
  DEFAULT_DOMAIN_INTERVAL_MS,
  DEFAULT_JAVASCRIPT_MAX_CONTEXTS,
  DEFAULT_JAVASCRIPT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_JAVASCRIPT_SETTLE_MS,
  DEFAULT_JAVASCRIPT_WAIT_SELECTOR_TIMEOUT_MS,
  loadCrawlerConfig,
  MAX_ROBOTS_CACHE_TTL_SECONDS,
} from "./config/crawler";
export type { CrawlerConfig } from "./config/crawler";
export { closePrisma, prisma } from "./db/prisma";
export {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  E5_EMBEDDING_DIMENSION,
  E5_INFERENCE_LIBRARY_VERSION,
  E5_MODEL_ID,
  E5_MODEL_REVISION,
  E5_MODEL_VERSION,
  formatE5Passage,
  formatE5Query,
  getEmbeddingProvider,
  MAX_EMBEDDING_BATCH_SIZE,
  MultilingualE5Provider,
  resetEmbeddingProviderForTests,
} from "./embedding/e5-provider";
export {
  EmbeddingConfigurationError,
  EmbeddingInferenceError,
  EmbeddingModelLoadError,
} from "./embedding/embedding-provider";
export type {
  EmbeddingProvider,
} from "./embedding/embedding-provider";
export {
  embeddingToSqlVector,
  NORMALIZED_VECTOR_TOLERANCE,
  normalizeEmbedding,
} from "./embedding/vector";
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
