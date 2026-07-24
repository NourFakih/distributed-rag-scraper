import { z } from "zod";

export const DEFAULT_CRAWLER_USER_AGENT =
  "DistributedRagScraper/0.1 (+https://github.com/NourFakih/distributed-rag-scraper)";
export const DEFAULT_DOMAIN_INTERVAL_MS = 1_000;
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
  allowPrivateTestTargets: boolean;
}

export function loadCrawlerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CrawlerConfig {
  const parsed = crawlerEnvironmentSchema.parse(environment);

  return {
    userAgent: parsed.CRAWLER_USER_AGENT,
    defaultIntervalMs: parsed.CRAWLER_DEFAULT_INTERVAL_MS,
    allowPrivateTestTargets:
      parsed.CRAWLER_ALLOW_PRIVATE_TEST_TARGETS === "true",
  };
}
