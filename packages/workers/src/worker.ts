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
    },
  );

  worker.on("completed", (job, result) => {
    console.log(
      `Completed CrawlPage ${result.crawlPageId} as document ${result.documentId}`,
    );
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
      await closeCrawlQueue();
      if (connection.status !== "end") {
        await connection.quit();
      }
    },
  };
}
