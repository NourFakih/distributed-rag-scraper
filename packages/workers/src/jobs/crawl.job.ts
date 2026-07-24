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
import {
  boundedFailureMessage,
  persistTerminalFailure,
} from "../crawl/dead-letter";
import { reserveDiscoveredPages } from "../crawl/discover-pages";
import {
  asCrawlFailure,
  RobotsExcludedError,
} from "../errors/crawl-failure";
import { calculateContentHash } from "../lib/content-hash";
import {
  getCrawlerServices,
  type CrawlerServices,
} from "../runtime/crawler-services";
import { discoverLinks } from "../scraping/link-discovery";
import { scrapeStaticPage } from "../scraping/static-page.scraper";

function isFinalAttempt(
  job: Job<CrawlJobData, CrawlJobResult, CrawlJobName>,
): boolean {
  const maximumAttempts = job.opts.attempts ?? 1;
  return job.attemptsMade + 1 >= maximumAttempts;
}

async function markRobotsSkipped(
  crawlPageId: string,
  crawlId: string,
): Promise<CrawlJobResult> {
  await prisma.crawlPage.update({
    where: {
      id: crawlPageId,
    },
    data: {
      status: CrawlPageStatus.SKIPPED_ROBOTS,
      error: "Blocked by robots.txt",
      failureCategory: null,
      completedAt: new Date(),
    },
  });
  await refreshCrawlState(crawlId);
  return {
    crawlPageId,
    outcome: "SKIPPED_ROBOTS",
  };
}

export async function processCrawlJob(
  job: Job<CrawlJobData, CrawlJobResult, CrawlJobName>,
): Promise<CrawlJobResult> {
  return processCrawlJobWithServices(job, getCrawlerServices());
}

export async function processCrawlJobWithServices(
  job: Job<CrawlJobData, CrawlJobResult, CrawlJobName>,
  services: CrawlerServices,
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
      deadLetter: true,
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
      outcome: "COMPLETED",
      documentId: crawlPage.document.id,
      contentHash: crawlPage.document.contentHash,
    };
  }
  if (crawlPage.status === CrawlPageStatus.SKIPPED_ROBOTS) {
    await refreshCrawlState(crawlPage.crawlId);
    return {
      crawlPageId,
      outcome: "SKIPPED_ROBOTS",
    };
  }
  if (
    crawlPage.status === CrawlPageStatus.FAILED &&
    crawlPage.deadLetter
  ) {
    throw new UnrecoverableError(
      `CrawlPage ${crawlPageId} already failed terminally`,
    );
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
        failureCategory: null,
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
    const robotsDecision = await services.robotsService.check(
      crawlPage.url,
      crawlPage.crawl.normalizedOrigin,
    );
    if (!robotsDecision.allowed) {
      return markRobotsSkipped(crawlPageId, crawlPage.crawlId);
    }

    const page = await scrapeStaticPage(
      crawlPage.url,
      crawlPage.crawl.normalizedOrigin,
      services.httpClient,
      robotsDecision.crawlDelayMs,
      (redirectUrl) =>
        services.robotsService.check(
          redirectUrl,
          crawlPage.crawl.normalizedOrigin,
        ),
    );
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
        failureCategory: null,
        completedAt: new Date(),
      },
    });
    await refreshCrawlState(crawlPage.crawlId);

    return {
      crawlPageId,
      outcome: "COMPLETED",
      documentId: document.id,
      contentHash,
    };
  } catch (error: unknown) {
    if (error instanceof RobotsExcludedError) {
      return markRobotsSkipped(crawlPageId, crawlPage.crawlId);
    }

    const failure = asCrawlFailure(error);
    const terminal = !failure.retryable || isFinalAttempt(job);

    try {
      if (terminal) {
        await persistTerminalFailure(crawlPage, job, failure);
      } else {
        await prisma.crawlPage.update({
          where: {
            id: crawlPageId,
          },
          data: {
            status: CrawlPageStatus.RETRYING,
            error: boundedFailureMessage(failure),
            failureCategory: failure.category,
            completedAt: null,
          },
        });
      }
      await refreshCrawlState(crawlPage.crawlId);
    } catch (stateError: unknown) {
      console.error(
        `Unable to persist failure state for CrawlPage ${crawlPageId}`,
        stateError,
      );
    }

    if (!failure.retryable) {
      throw new UnrecoverableError(
        `${failure.category}: ${boundedFailureMessage(failure)}`,
      );
    }
    throw failure;
  }
}
