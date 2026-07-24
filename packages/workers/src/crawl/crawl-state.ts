import {
  CrawlPageStatus,
  CrawlStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "@distributed-rag/shared";

const ACTIVE_PAGE_STATUSES: CrawlPageStatus[] = [
  CrawlPageStatus.DISCOVERED,
  CrawlPageStatus.QUEUED,
  CrawlPageStatus.PROCESSING,
  CrawlPageStatus.RETRYING,
];

export async function refreshCrawlState(crawlId: string): Promise<void> {
  await prisma.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
        FROM "crawls"
        WHERE "id" = ${crawlId}::uuid
        FOR UPDATE
      `;

      const crawl = await transaction.crawl.findUnique({
        where: {
          id: crawlId,
        },
        select: {
          completedAt: true,
        },
      });
      if (!crawl) {
        return;
      }

      const grouped = await transaction.crawlPage.groupBy({
        by: ["status"],
        where: {
          crawlId,
        },
        _count: {
          _all: true,
        },
      });
      const counts = new Map(
        grouped.map((group) => [group.status, group._count._all]),
      );
      const count = (status: CrawlPageStatus): number =>
        counts.get(status) ?? 0;
      const activeCount = ACTIVE_PAGE_STATUSES.reduce(
        (total, status) => total + count(status),
        0,
      );
      const terminal = activeCount === 0;

      await transaction.crawl.update({
        where: {
          id: crawlId,
        },
        data: {
          status: terminal ? CrawlStatus.COMPLETED : CrawlStatus.PROCESSING,
          discoveredCount: [...counts.values()].reduce(
            (total, value) => total + value,
            0,
          ),
          completedCount: count(CrawlPageStatus.COMPLETED),
          skippedCount: count(CrawlPageStatus.SKIPPED),
          failedCount: count(CrawlPageStatus.FAILED),
          completedAt: terminal ? (crawl.completedAt ?? new Date()) : null,
        },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}
