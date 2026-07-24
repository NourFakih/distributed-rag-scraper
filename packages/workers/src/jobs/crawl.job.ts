import { CrawlPageStatus, CrawlStatus } from "@prisma/client";
import {
  crawlJobDataSchema,
  getCrawlQueue,
  prisma,
  SCRAPE_STATIC_PAGE_JOB,
  type CrawlJobData,
  type CrawlJobName,
  type CrawlJobResult,
} from "@distributed-rag/shared";
import { UnrecoverableError, type Job } from "bullmq";

import { refreshCrawlState } from "../crawl/crawl-state";
import { reserveDiscoveredPages } from "../crawl/discover-pages";
import { calculateContentHash } from "../lib/content-hash";
import { discoverLinks } from "../scraping/link-discovery";
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

  const { crawlPageId } = parsedData.data;
  const crawlPage = await prisma.crawlPage.findUnique({
    where: {
      id: crawlPageId,
    },
    include: {
      crawl: true,
      document: true,
    },
  });

  if (!crawlPage) {
    throw new UnrecoverableError(`CrawlPage ${crawlPageId} does not exist`);
  }

  if (
    crawlPage.status === CrawlPageStatus.COMPLETED &&
    crawlPage.document
  ) {
    await refreshCrawlState(crawlPage.crawlId);
    return {
      crawlPageId,
      documentId: crawlPage.document.id,
      contentHash: crawlPage.document.contentHash,
    };
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.crawlPage.update({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.PROCESSING,
        attempts: {
          increment: 1,
        },
        startedAt: crawlPage.startedAt ?? new Date(),
        completedAt: null,
        error: null,
      },
    });
    await transaction.crawl.update({
      where: {
        id: crawlPage.crawlId,
      },
      data: {
        status: CrawlStatus.PROCESSING,
        completedAt: null,
      },
    });
  });

  try {
    const page = await scrapeStaticPage(crawlPage.url);
    const contentHash = calculateContentHash(page.content);

    const document = await prisma.document.upsert({
      where: {
        crawlPageId,
      },
      create: {
        crawlPageId,
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

    if (crawlPage.depth < crawlPage.crawl.maxDepth) {
      const candidates = discoverLinks(
        page.rawHtml,
        page.url,
        crawlPage.crawl.normalizedOrigin,
      );
      const discoveredPages = await reserveDiscoveredPages(
        {
          id: crawlPage.id,
          crawlId: crawlPage.crawlId,
          depth: crawlPage.depth,
        },
        candidates,
      );

      for (const discoveredPage of discoveredPages) {
        await getCrawlQueue().add(
          SCRAPE_STATIC_PAGE_JOB,
          {
            crawlPageId: discoveredPage.id,
          },
          {
            jobId: discoveredPage.id,
          },
        );
        await prisma.crawlPage.updateMany({
          where: {
            id: discoveredPage.id,
            status: CrawlPageStatus.DISCOVERED,
          },
          data: {
            status: CrawlPageStatus.QUEUED,
          },
        });
      }
    }

    await prisma.crawlPage.update({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.COMPLETED,
        error: null,
        completedAt: new Date(),
      },
    });
    await refreshCrawlState(crawlPage.crawlId);

    return {
      crawlPageId,
      documentId: document.id,
      contentHash,
    };
  } catch (error: unknown) {
    const finalAttempt = isFinalAttempt(job);

    await prisma.crawlPage
      .update({
        where: {
          id: crawlPageId,
        },
        data: {
          status: finalAttempt
            ? CrawlPageStatus.FAILED
            : CrawlPageStatus.RETRYING,
          error: boundedErrorMessage(error),
          completedAt: finalAttempt ? new Date() : null,
        },
      })
      .then(async () => {
        if (finalAttempt) {
          await prisma.crawlPage.updateMany({
            where: {
              parentPageId: crawlPageId,
              status: CrawlPageStatus.DISCOVERED,
            },
            data: {
              status: CrawlPageStatus.SKIPPED,
              error: "Parent page failed before this page could be queued",
              completedAt: new Date(),
            },
          });
        }

        await refreshCrawlState(crawlPage.crawlId);
      })
      .catch((stateError: unknown) => {
        console.error(
          `Unable to persist failure state for CrawlPage ${crawlPageId}`,
          stateError,
        );
      });

    throw error;
  }
}
