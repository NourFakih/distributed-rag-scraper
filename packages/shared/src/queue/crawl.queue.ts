import { Queue, type Job } from "bullmq";
import type IORedis from "ioredis";

import {
  CRAWL_QUEUE_NAME,
  type CrawlJobData,
  type CrawlJobName,
  type CrawlJobResult,
} from "../contracts/crawl";
import { createRedisConnection } from "./redis";

type CrawlQueue = Queue<Job<CrawlJobData, CrawlJobResult, CrawlJobName>>;

let crawlQueue: CrawlQueue | undefined;
let crawlQueueConnection: IORedis | undefined;

export function getCrawlQueue(): CrawlQueue {
  if (!crawlQueue) {
    crawlQueueConnection = createRedisConnection("crawl-api");
    crawlQueue = new Queue<
      Job<CrawlJobData, CrawlJobResult, CrawlJobName>
    >(
      CRAWL_QUEUE_NAME,
      {
        connection: crawlQueueConnection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "crawler",
          },
          removeOnComplete: {
            age: 24 * 60 * 60,
            count: 1_000,
          },
          removeOnFail: false,
        },
      },
    );
  }

  return crawlQueue;
}

export async function closeCrawlQueue(): Promise<void> {
  const queue = crawlQueue;
  const connection = crawlQueueConnection;

  crawlQueue = undefined;
  crawlQueueConnection = undefined;

  if (queue) {
    await queue.close();
  }

  if (connection && connection.status !== "end") {
    await connection.quit();
  }
}
