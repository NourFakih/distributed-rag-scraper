import {
  CrawlPageStatus,
  CrawlStatus,
  RenderMode,
} from "@prisma/client";
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
  CrawlFailure,
  RobotsExcludedError,
} from "../errors/crawl-failure";
import { calculateContentHash } from "../lib/content-hash";
import type { ProcessedPage } from "../processing/process-page";
import {
  getCrawlerServices,
  type CrawlerServices,
} from "../runtime/crawler-services";
import { synchronizeDocumentChunks } from "../chunks/synchronize-document-chunks";
import { discoverLinks } from "../scraping/link-discovery";
import { scrapeStaticPage } from "../scraping/static-page.scraper";

interface DiscoverySource {
  rawHtml: string;
  url: string;
}

interface DiscoveryContext {
  crawlPageId: string;
  crawlId: string;
  depth: number;
  maxDepth: number;
  normalizedOrigin: string;
}

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

async function findPreviousDocument(
  crawlPageId: string,
  normalizedUrl: string,
) {
  return prisma.document.findFirst({
    where: {
      crawlPageId: {
        not: crawlPageId,
      },
      crawlPage: {
        normalizedUrl,
      },
    },
    orderBy: [
      {
        fetchedAt: "desc",
      },
      {
        id: "desc",
      },
    ],
    select: {
      id: true,
      url: true,
      rawHtml: true,
      contentHash: true,
      etag: true,
      lastModified: true,
    },
  });
}

async function discoverAndQueueChildren(
  context: DiscoveryContext,
  source: DiscoverySource,
): Promise<void> {
  if (context.depth >= context.maxDepth) {
    return;
  }

  const candidates = discoverLinks(
    source.rawHtml,
    source.url,
    context.normalizedOrigin,
  );
  const discoveredPages = await reserveDiscoveredPages(
    {
      id: context.crawlPageId,
      crawlId: context.crawlId,
      depth: context.depth,
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

async function completeWithReusedDocument(
  context: DiscoveryContext,
  previousDocument: NonNullable<
    Awaited<ReturnType<typeof findPreviousDocument>>
  >,
): Promise<CrawlJobResult> {
  await discoverAndQueueChildren(context, previousDocument);
  await prisma.crawlPage.update({
    where: {
      id: context.crawlPageId,
    },
    data: {
      status: CrawlPageStatus.COMPLETED,
      notModified: true,
      reusedDocumentId: previousDocument.id,
      error: null,
      failureCategory: null,
      completedAt: new Date(),
    },
  });
  await refreshCrawlState(context.crawlId);

  return {
    crawlPageId: context.crawlPageId,
    outcome: "COMPLETED",
    documentId: previousDocument.id,
    contentHash: previousDocument.contentHash,
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
      reusedDocument: true,
      deadLetter: true,
    },
  });

  if (!crawlPage) {
    throw new UnrecoverableError(`CrawlPage ${crawlPageId} does not exist`);
  }

  const completedDocument =
    crawlPage.document ?? crawlPage.reusedDocument;
  if (
    crawlPage.status === CrawlPageStatus.COMPLETED &&
    completedDocument
  ) {
    await refreshCrawlState(crawlPage.crawlId);
    return {
      crawlPageId,
      outcome: "COMPLETED",
      documentId: completedDocument.id,
      contentHash: completedDocument.contentHash,
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

    const discoveryContext: DiscoveryContext = {
      crawlPageId: crawlPage.id,
      crawlId: crawlPage.crawlId,
      depth: crawlPage.depth,
      maxDepth: crawlPage.crawl.maxDepth,
      normalizedOrigin: crawlPage.crawl.normalizedOrigin,
    };
    let page: ProcessedPage;
    let etag: string | null = null;
    let lastModified: string | null = null;
    let previousDocument: Awaited<
      ReturnType<typeof findPreviousDocument>
    > = null;

    if (crawlPage.crawl.renderMode === RenderMode.JAVASCRIPT) {
      page = await services.javascriptRenderer.render({
        url: crawlPage.url,
        allowedOrigin: crawlPage.crawl.normalizedOrigin,
        crawlDelayMs: robotsDecision.crawlDelayMs,
      });
    } else {
      previousDocument = await findPreviousDocument(
        crawlPage.id,
        crawlPage.normalizedUrl,
      );
      const staticPage = await scrapeStaticPage(
        crawlPage.url,
        crawlPage.crawl.normalizedOrigin,
        services.httpClient,
        robotsDecision.crawlDelayMs,
        (redirectUrl) =>
          services.robotsService.check(
            redirectUrl,
            crawlPage.crawl.normalizedOrigin,
          ),
        {
          etag: previousDocument?.etag ?? undefined,
          lastModified: previousDocument?.lastModified ?? undefined,
        },
      );

      if (staticPage.notModified) {
        if (!previousDocument) {
          throw new CrawlFailure(
            "HTTP_PERMANENT",
            "Static page returned HTTP 304 without a previous document",
            false,
          );
        }
        return await completeWithReusedDocument(
          discoveryContext,
          previousDocument,
        );
      }

      page = staticPage;
      etag = staticPage.etag;
      lastModified = staticPage.lastModified;
    }
    const contentHash = calculateContentHash(page.content);

    if (
      previousDocument &&
      previousDocument.contentHash === contentHash
    ) {
      return await completeWithReusedDocument(
        discoveryContext,
        previousDocument,
      );
    }

    const document = await prisma.$transaction(async (transaction) => {
      const persistedDocument = await transaction.document.upsert({
        where: {
          crawlPageId,
        },
        create: {
          crawlPageId,
          url: page.url,
          title: page.title,
          rawHtml: page.rawHtml,
          content: page.content,
          structuredData: page.structuredData,
          contentHash,
          etag,
          lastModified,
          previousVersionId: previousDocument?.id ?? null,
          httpStatus: page.httpStatus,
          contentType: page.contentType,
          fetchedAt: page.fetchedAt,
        },
        update: {
          url: page.url,
          title: page.title,
          rawHtml: page.rawHtml,
          content: page.content,
          structuredData: page.structuredData,
          contentHash,
          etag,
          lastModified,
          previousVersionId: previousDocument?.id ?? null,
          httpStatus: page.httpStatus,
          contentType: page.contentType,
          fetchedAt: page.fetchedAt,
        },
      });

      await synchronizeDocumentChunks(
        transaction,
        persistedDocument.id,
        page.content,
      );

      return persistedDocument;
    });

    await discoverAndQueueChildren(discoveryContext, page);

    await prisma.crawlPage.update({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.COMPLETED,
        notModified: false,
        reusedDocumentId: null,
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
