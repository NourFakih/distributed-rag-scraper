import { CrawlStatus } from "@prisma/client";
import {
  crawlJobDataSchema,
  prisma,
  type CrawlJobData,
  type CrawlJobName,
  type CrawlJobResult,
} from "@distributed-rag/shared";
import { UnrecoverableError, type Job } from "bullmq";

import { calculateContentHash } from "../lib/content-hash";
import { scrapeStaticPage } from "../scraping/static-page.scraper";

const MAX_ERROR_MESSAGE_LENGTH = 2_000;

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function isFinalAttempt(
  job: Job<CrawlJobData, CrawlJobResult, CrawlJobName>,
): boolean {
  const maximumAttempts = job.opts.attempts ?? 1;
  return job.attemptsMade + 1 >= maximumAttempts;
}

export async function processCrawlJob(
  job: Job<CrawlJobData, CrawlJobResult, CrawlJobName>,
): Promise<CrawlJobResult> {
  const parsedData = crawlJobDataSchema.safeParse(job.data);
  if (!parsedData.success) {
    throw new UnrecoverableError("Crawl job data is invalid");
  }

  const { crawlId, url } = parsedData.data;
  const crawl = await prisma.crawl.findUnique({
    where: {
      id: crawlId,
    },
    include: {
      document: true,
    },
  });

  if (!crawl) {
    throw new UnrecoverableError(`Crawl ${crawlId} does not exist`);
  }

  if (crawl.status === CrawlStatus.COMPLETED && crawl.document) {
    return {
      documentId: crawl.document.id,
      contentHash: crawl.document.contentHash,
    };
  }

  await prisma.crawl.update({
    where: {
      id: crawlId,
    },
    data: {
      status: CrawlStatus.PROCESSING,
      attempts: {
        increment: 1,
      },
      startedAt: crawl.startedAt ?? new Date(),
      completedAt: null,
      errorMessage: null,
    },
  });

  try {
    const page = await scrapeStaticPage(url);
    const contentHash = calculateContentHash(page.content);

    const document = await prisma.$transaction(async (transaction) => {
      const persistedDocument = await transaction.document.upsert({
        where: {
          crawlId,
        },
        create: {
          crawlId,
          url: page.url,
          title: page.title,
          rawHtml: page.rawHtml,
          content: page.content,
          contentHash,
          httpStatus: page.httpStatus,
          contentType: page.contentType,
          fetchedAt: page.fetchedAt,
        },
        update: {
          url: page.url,
          title: page.title,
          rawHtml: page.rawHtml,
          content: page.content,
          contentHash,
          httpStatus: page.httpStatus,
          contentType: page.contentType,
          fetchedAt: page.fetchedAt,
        },
      });

      await transaction.crawl.update({
        where: {
          id: crawlId,
        },
        data: {
          status: CrawlStatus.COMPLETED,
          errorMessage: null,
          completedAt: new Date(),
        },
      });

      return persistedDocument;
    });

    return {
      documentId: document.id,
      contentHash,
    };
  } catch (error: unknown) {
    const finalAttempt = isFinalAttempt(job);

    await prisma.crawl
      .update({
        where: {
          id: crawlId,
        },
        data: {
          status: finalAttempt
            ? CrawlStatus.FAILED
            : CrawlStatus.RETRYING,
          errorMessage: boundedErrorMessage(error),
          completedAt: finalAttempt ? new Date() : null,
        },
      })
      .catch((stateError: unknown) => {
        console.error(
          `Unable to persist failure state for crawl ${crawlId}`,
          stateError,
        );
      });

    throw error;
  }
}

