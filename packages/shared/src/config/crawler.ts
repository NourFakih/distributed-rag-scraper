import { z } from "zod";

export const DEFAULT_CRAWLER_USER_AGENT =
  "DistributedRagScraper/0.1 (+https://github.com/NourFakih/distributed-rag-scraper)";
export const DEFAULT_DOMAIN_INTERVAL_MS = 1_000;
export const DEFAULT_JAVASCRIPT_NAVIGATION_TIMEOUT_MS = 15_000;
export const DEFAULT_JAVASCRIPT_SETTLE_MS = 500;
export const DEFAULT_JAVASCRIPT_WAIT_SELECTOR_TIMEOUT_MS = 5_000;
export const DEFAULT_JAVASCRIPT_MAX_CONTEXTS = 2;
export const MAX_ROBOTS_CACHE_TTL_SECONDS = 24 * 60 * 60;

const crawlerEnvironmentSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    CRAWLER_USER_AGENT: z
      .string()
      .trim()
      .min(1)
      .default(DEFAULT_CRAWLER_USER_AGENT),
    CRAWLER_DEFAULT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(60_000)
      .default(DEFAULT_DOMAIN_INTERVAL_MS),
    CRAWLER_JAVASCRIPT_NAVIGATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(DEFAULT_JAVASCRIPT_NAVIGATION_TIMEOUT_MS),
    CRAWLER_JAVASCRIPT_SETTLE_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(5_000)
      .default(DEFAULT_JAVASCRIPT_SETTLE_MS),
    CRAWLER_JAVASCRIPT_WAIT_SELECTOR: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === ""
          ? undefined
          : value,
      z.string().trim().min(1).max(512).optional(),
    ),
    CRAWLER_JAVASCRIPT_WAIT_SELECTOR_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(DEFAULT_JAVASCRIPT_WAIT_SELECTOR_TIMEOUT_MS),
    CRAWLER_JAVASCRIPT_MAX_CONTEXTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(DEFAULT_JAVASCRIPT_MAX_CONTEXTS),
    CRAWLER_ALLOW_PRIVATE_TEST_TARGETS: z
      .enum(["true", "false"])
      .default("false"),
  })
  .superRefine((environment, context) => {
    if (
      environment.CRAWLER_ALLOW_PRIVATE_TEST_TARGETS === "true" &&
      environment.NODE_ENV !== "test"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CRAWLER_ALLOW_PRIVATE_TEST_TARGETS"],
        message:
          "Private crawler targets may only be enabled when NODE_ENV=test",
      });
    }
  });

export interface CrawlerConfig {
  userAgent: string;
  defaultIntervalMs: number;
  javascriptNavigationTimeoutMs: number;
  javascriptSettleMs: number;
  javascriptWaitSelector?: string;
  javascriptWaitSelectorTimeoutMs: number;
  javascriptMaxContexts: number;
  allowPrivateTestTargets: boolean;
}

export function loadCrawlerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CrawlerConfig {
  const parsed = crawlerEnvironmentSchema.parse(environment);

  return {
    userAgent: parsed.CRAWLER_USER_AGENT,
    defaultIntervalMs: parsed.CRAWLER_DEFAULT_INTERVAL_MS,
    javascriptNavigationTimeoutMs:
      parsed.CRAWLER_JAVASCRIPT_NAVIGATION_TIMEOUT_MS,
    javascriptSettleMs: parsed.CRAWLER_JAVASCRIPT_SETTLE_MS,
    javascriptWaitSelector: parsed.CRAWLER_JAVASCRIPT_WAIT_SELECTOR,
    javascriptWaitSelectorTimeoutMs:
      parsed.CRAWLER_JAVASCRIPT_WAIT_SELECTOR_TIMEOUT_MS,
    javascriptMaxContexts: parsed.CRAWLER_JAVASCRIPT_MAX_CONTEXTS,
    allowPrivateTestTargets:
      parsed.CRAWLER_ALLOW_PRIVATE_TEST_TARGETS === "true",
  };
}
