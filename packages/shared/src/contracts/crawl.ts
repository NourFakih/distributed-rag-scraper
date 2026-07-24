import { z } from "zod";

export const CRAWL_QUEUE_NAME = "crawl" as const;
export const SCRAPE_STATIC_PAGE_JOB = "scrape-static-page" as const;

export const crawlJobDataSchema = z.object({
  crawlPageId: z.string().uuid(),
});

export type CrawlJobData = z.infer<typeof crawlJobDataSchema>;

export interface CrawlJobResult {
  crawlPageId: string;
  documentId: string;
  contentHash: string;
}

export type CrawlJobName = typeof SCRAPE_STATIC_PAGE_JOB;
