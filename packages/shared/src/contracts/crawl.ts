import { z } from "zod";

export const CRAWL_QUEUE_NAME = "crawl" as const;
export const SCRAPE_STATIC_PAGE_JOB = "scrape-static-page" as const;

export const crawlJobDataSchema = z.object({
  crawlPageId: z.string().uuid(),
});

export type CrawlJobData = z.infer<typeof crawlJobDataSchema>;

export interface CompletedCrawlJobResult {
  crawlPageId: string;
  outcome: "COMPLETED";
  documentId: string;
  contentHash: string;
}

export interface RobotsSkippedCrawlJobResult {
  crawlPageId: string;
  outcome: "SKIPPED_ROBOTS";
}

export type CrawlJobResult =
  | CompletedCrawlJobResult
  | RobotsSkippedCrawlJobResult;

export type CrawlJobName = typeof SCRAPE_STATIC_PAGE_JOB;
