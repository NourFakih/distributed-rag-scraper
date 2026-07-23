import { CrawlStatus } from "@prisma/client";
import {
  getCrawlQueue,
  prisma,
  SCRAPE_STATIC_PAGE_JOB,
} from "@distributed-rag/shared";

import { AppError } from "../middleware/error-handler";

const MAX_ERROR_MESSAGE_LENGTH = 2_000;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export async function createCrawl(url: string) {
  const crawl = await prisma.crawl.create({
    data: {
      url,
    },
  });

  try {
    await getCrawlQueue().add(
      SCRAPE_STATIC_PAGE_JOB,
      {
        crawlId: crawl.id,
        url: crawl.url,
      },
      {
        jobId: crawl.id,
      },
    );
  } catch (error: unknown) {
    await prisma.crawl.update({
      where: {
        id: crawl.id,
      },
      data: {
        status: CrawlStatus.FAILED,
        errorMessage: errorMessage(error),
        completedAt: new Date(),
      },
    });

    throw new AppError(
      503,
      "QUEUE_UNAVAILABLE",
      "The crawl could not be queued; please retry later",
    );
  }

  return crawl;
}

export async function getCrawlById(id: string) {
  const crawl = await prisma.crawl.findUnique({
    where: {
      id,
    },
    include: {
      document: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!crawl) {
    throw new AppError(404, "CRAWL_NOT_FOUND", "Crawl was not found");
  }

  return crawl;
}

