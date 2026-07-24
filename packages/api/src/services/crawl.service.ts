import {
  CrawlPageStatus,
  CrawlStatus,
  type RenderMode,
} from "@prisma/client";
import {
  getCrawlQueue,
  normalizedOrigin,
  prisma,
  SCRAPE_STATIC_PAGE_JOB,
} from "@distributed-rag/shared";

import { AppError } from "../middleware/error-handler";

const MAX_ERROR_MESSAGE_LENGTH = 2_000;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export async function createCrawl(
  seedUrl: string,
  maxPages: number,
  maxDepth: number,
  renderMode: RenderMode,
) {
  const created = await prisma.$transaction(async (transaction) => {
    const crawl = await transaction.crawl.create({
      data: {
        seedUrl,
        normalizedOrigin: normalizedOrigin(seedUrl),
        maxPages,
        maxDepth,
        renderMode,
      },
    });

    const rootPage = await transaction.crawlPage.create({
      data: {
        crawlId: crawl.id,
        url: seedUrl,
        normalizedUrl: seedUrl,
        depth: 0,
        status: CrawlPageStatus.QUEUED,
      },
    });

    return {
      crawl,
      rootPage,
    };
  });

  try {
    await getCrawlQueue().add(
      SCRAPE_STATIC_PAGE_JOB,
      {
        crawlPageId: created.rootPage.id,
      },
      {
        jobId: created.rootPage.id,
      },
    );
  } catch (error: unknown) {
    await prisma.$transaction(async (transaction) => {
      const completedAt = new Date();
      await transaction.crawlPage.update({
        where: {
          id: created.rootPage.id,
        },
        data: {
          status: CrawlPageStatus.FAILED,
          error: errorMessage(error),
          completedAt,
        },
      });
      await transaction.crawl.update({
        where: {
          id: created.crawl.id,
        },
        data: {
          status: CrawlStatus.FAILED,
          failedCount: 1,
          completedAt,
        },
      });
    });

    throw new AppError(
      503,
      "QUEUE_UNAVAILABLE",
      "The crawl could not be queued; please retry later",
    );
  }

  return created;
}

export async function getCrawlById(id: string) {
  const crawl = await prisma.crawl.findUnique({
    where: {
      id,
    },
    include: {
      pages: {
        where: {
          depth: 0,
        },
        orderBy: {
          createdAt: "asc",
        },
        take: 1,
        include: {
          document: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!crawl) {
    throw new AppError(404, "CRAWL_NOT_FOUND", "Crawl was not found");
  }

  return crawl;
}

export async function getCrawlPages(
  id: string,
  page: number,
  pageSize: number,
) {
  const crawl = await prisma.crawl.findUnique({
    where: {
      id,
    },
    select: {
      id: true,
    },
  });

  if (!crawl) {
    throw new AppError(404, "CRAWL_NOT_FOUND", "Crawl was not found");
  }

  const [pages, total] = await prisma.$transaction([
    prisma.crawlPage.findMany({
      where: {
        crawlId: id,
      },
      orderBy: [
        {
          createdAt: "asc",
        },
        {
          id: "asc",
        },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        document: {
          select: {
            id: true,
          },
        },
      },
    }),
    prisma.crawlPage.count({
      where: {
        crawlId: id,
      },
    }),
  ]);

  return {
    pages,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}
