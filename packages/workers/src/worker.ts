import {
  CRAWL_QUEUE_NAME,
  closeCrawlQueue,
  createRedisConnection,
  type CrawlJobData,
  type CrawlJobName,
  type CrawlJobResult,
} from "@distributed-rag/shared";
import { Worker } from "bullmq";
import type IORedis from "ioredis";

import { processCrawlJob } from "./jobs/crawl.job";
import { calculateBackoffDelay } from "./retry/retry-policy";
import { closeCrawlerServices } from "./runtime/crawler-services";

export interface CrawlWorkerRuntime {
  worker: Worker<CrawlJobData, CrawlJobResult, CrawlJobName>;
  connection: IORedis;
  close: () => Promise<void>;
}

export function createCrawlWorker(): CrawlWorkerRuntime {
  const connection = createRedisConnection("crawl-worker");
  const worker = new Worker<CrawlJobData, CrawlJobResult, CrawlJobName>(
    CRAWL_QUEUE_NAME,
    processCrawlJob,
    {
      connection,
      concurrency: Number.parseInt(process.env.WORKER_CONCURRENCY ?? "5", 10),
      settings: {
        backoffStrategy: (attemptsMade, type, error) => {
          if (type !== "crawler") {
            throw new Error(`Unknown backoff strategy: ${type ?? "missing"}`);
          }
          return calculateBackoffDelay(attemptsMade, error);
        },
      },
    },
  );

  worker.on("completed", (job, result) => {
    if (result.outcome === "COMPLETED") {
      console.log(
        `Completed CrawlPage ${result.crawlPageId} as document ${result.documentId}`,
      );
      return;
    }
    console.log(`Skipped CrawlPage ${result.crawlPageId} due to robots.txt`);
  });

  worker.on("failed", (job, error) => {
    console.error(
      `Crawl job ${job?.id ?? "unknown"} failed on attempt ${
        (job?.attemptsMade ?? 0) + 1
      }`,
      error,
    );
  });

  return {
    worker,
    connection,
    close: async () => {
      await worker.close();
      await Promise.all([closeCrawlQueue(), closeCrawlerServices()]);
      if (connection.status !== "end") {
        await connection.quit();
      }
    },
  };
}
