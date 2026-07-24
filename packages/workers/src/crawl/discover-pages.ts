import { CrawlPageStatus, Prisma } from "@prisma/client";
import { prisma } from "@distributed-rag/shared";

import type { DiscoveredLink } from "../scraping/link-discovery";

export interface DiscoveryParent {
  id: string;
  crawlId: string;
  depth: number;
}

export interface ReservedCrawlPage {
  id: string;
  normalizedUrl: string;
}

export async function reserveDiscoveredPages(
  parent: DiscoveryParent,
  candidates: DiscoveredLink[],
): Promise<ReservedCrawlPage[]> {
  if (candidates.length === 0) {
    return [];
  }

  const uniqueCandidates = [
    ...new Map(
      candidates.map((candidate) => [candidate.normalizedUrl, candidate]),
    ).values(),
  ];

  return prisma.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
        FROM "crawls"
        WHERE "id" = ${parent.crawlId}::uuid
        FOR UPDATE
      `;

      const crawl = await transaction.crawl.findUnique({
        where: {
          id: parent.crawlId,
        },
        select: {
          maxDepth: true,
          maxPages: true,
        },
      });

      if (!crawl || parent.depth >= crawl.maxDepth) {
        return [];
      }

      const normalizedUrls = uniqueCandidates.map(
        (candidate) => candidate.normalizedUrl,
      );
      const existing = await transaction.crawlPage.findMany({
        where: {
          crawlId: parent.crawlId,
          normalizedUrl: {
            in: normalizedUrls,
          },
        },
        select: {
          normalizedUrl: true,
        },
      });
      const existingUrls = new Set(
        existing.map((crawlPage) => crawlPage.normalizedUrl),
      );
      const currentCount = await transaction.crawlPage.count({
        where: {
          crawlId: parent.crawlId,
        },
      });
      const remainingCapacity = Math.max(crawl.maxPages - currentCount, 0);
      const toCreate = uniqueCandidates
        .filter((candidate) => !existingUrls.has(candidate.normalizedUrl))
        .slice(0, remainingCapacity);

      if (toCreate.length > 0) {
        await transaction.crawlPage.createMany({
          data: toCreate.map((candidate) => ({
            crawlId: parent.crawlId,
            url: candidate.url,
            normalizedUrl: candidate.normalizedUrl,
            depth: parent.depth + 1,
            parentPageId: parent.id,
            status: CrawlPageStatus.DISCOVERED,
          })),
          skipDuplicates: true,
        });
      }

      const updatedCount = await transaction.crawlPage.count({
        where: {
          crawlId: parent.crawlId,
        },
      });
      await transaction.crawl.update({
        where: {
          id: parent.crawlId,
        },
        data: {
          discoveredCount: updatedCount,
        },
      });

      return transaction.crawlPage.findMany({
        where: {
          crawlId: parent.crawlId,
          normalizedUrl: {
            in: normalizedUrls,
          },
          status: CrawlPageStatus.DISCOVERED,
        },
        select: {
          id: true,
          normalizedUrl: true,
        },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}
