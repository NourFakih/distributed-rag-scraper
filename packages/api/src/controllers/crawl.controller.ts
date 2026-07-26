import type { Request, Response } from "express";

import type {
  CrawlPagesQuery,
  CreateCrawlBody,
} from "../schemas/crawl.schemas";
import {
  createCrawl,
  getCrawlById,
  getCrawlPages,
} from "../services/crawl.service";

export async function createCrawlController(
  request: Request,
  response: Response,
): Promise<void> {
  const { url, maxPages, maxDepth, renderMode } =
    request.body as CreateCrawlBody;
  const { crawl, rootPage } = await createCrawl(
    url,
    maxPages,
    maxDepth,
    renderMode,
  );

  response.status(202).json({
    data: {
      id: crawl.id,
      url: crawl.seedUrl,
      seedUrl: crawl.seedUrl,
      status: crawl.status,
      maxPages: crawl.maxPages,
      maxDepth: crawl.maxDepth,
      renderMode: crawl.renderMode,
      rootPageId: rootPage.id,
      createdAt: crawl.createdAt,
    },
  });
}

export async function getCrawlController(
  request: Request,
  response: Response,
): Promise<void> {
  const crawl = await getCrawlById(request.params.id!);
  const rootPage = crawl.pages[0] ?? null;
  const rootDocumentId =
    rootPage?.document?.id ?? rootPage?.reusedDocumentId ?? null;

  response.status(200).json({
    data: {
      id: crawl.id,
      url: crawl.seedUrl,
      seedUrl: crawl.seedUrl,
      normalizedOrigin: crawl.normalizedOrigin,
      renderMode: crawl.renderMode,
      status: crawl.status,
      limits: {
        maxPages: crawl.maxPages,
        maxDepth: crawl.maxDepth,
      },
      counters: {
        discovered: crawl.discoveredCount,
        completed: crawl.completedCount,
        skipped: crawl.skippedCount,
        failed: crawl.failedCount,
      },
      attempts: rootPage?.attempts ?? 0,
      errorMessage: rootPage?.error ?? null,
      failureCategory: rootPage?.failureCategory ?? null,
      documentId: rootDocumentId,
      notModified: rootPage?.notModified ?? false,
      reusedDocumentId: rootPage?.reusedDocumentId ?? null,
      rootPage: rootPage
        ? {
            id: rootPage.id,
            url: rootPage.url,
            normalizedUrl: rootPage.normalizedUrl,
            status: rootPage.status,
            failureCategory: rootPage.failureCategory,
            documentId: rootDocumentId,
            notModified: rootPage.notModified,
            reusedDocumentId: rootPage.reusedDocumentId,
          }
        : null,
      completedWithFailures:
        crawl.status === "COMPLETED" && crawl.failedCount > 0,
      startedAt: rootPage?.startedAt ?? null,
      completedAt: crawl.completedAt,
      createdAt: crawl.createdAt,
      updatedAt: crawl.updatedAt,
    },
  });
}

export async function getCrawlPagesController(
  request: Request,
  response: Response,
): Promise<void> {
  const { page, pageSize } = request.query as unknown as CrawlPagesQuery;
  const result = await getCrawlPages(request.params.id!, page, pageSize);

  response.status(200).json({
    data: result.pages.map((crawlPage) => ({
      id: crawlPage.id,
      crawlId: crawlPage.crawlId,
      url: crawlPage.url,
      normalizedUrl: crawlPage.normalizedUrl,
      depth: crawlPage.depth,
      parentPageId: crawlPage.parentPageId,
      status: crawlPage.status,
      attempts: crawlPage.attempts,
      error: crawlPage.error,
      failureCategory: crawlPage.failureCategory,
      documentId:
        crawlPage.document?.id ?? crawlPage.reusedDocumentId ?? null,
      notModified: crawlPage.notModified,
      reusedDocumentId: crawlPage.reusedDocumentId,
      createdAt: crawlPage.createdAt,
      startedAt: crawlPage.startedAt,
      completedAt: crawlPage.completedAt,
    })),
    pagination: result.pagination,
  });
}
