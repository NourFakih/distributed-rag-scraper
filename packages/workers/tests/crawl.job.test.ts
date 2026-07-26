import { CrawlPageStatus, RenderMode } from "@prisma/client";
import type {
  CrawlJobData,
  CrawlJobName,
  CrawlJobResult,
} from "@distributed-rag/shared";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  crawlPageFindUnique: vi.fn(),
  crawlPageUpdate: vi.fn(),
  crawlPageUpdateMany: vi.fn(),
  crawlUpdate: vi.fn(),
  documentFindFirst: vi.fn(),
  documentUpsert: vi.fn(),
  chunkFindMany: vi.fn(),
  chunkDeleteMany: vi.fn(),
  chunkCreateMany: vi.fn(),
  deadLetterUpsert: vi.fn(),
  transaction: vi.fn(),
  queueAdd: vi.fn(),
  scrapeStaticPage: vi.fn(),
  renderJavaScriptPage: vi.fn(),
  discoverLinks: vi.fn(),
  reserveDiscoveredPages: vi.fn(),
  refreshCrawlState: vi.fn(),
  robotsCheck: vi.fn(),
}));

vi.mock("@distributed-rag/shared", async () => {
  const { z } = await import("zod");
  return {
    crawlJobDataSchema: z.object({
      crawlPageId: z.string().uuid(),
    }),
    SCRAPE_STATIC_PAGE_JOB: "scrape-static-page",
    getCrawlQueue: () => ({
      add: mocks.queueAdd,
    }),
    prisma: {
      crawlPage: {
        findUnique: mocks.crawlPageFindUnique,
        update: mocks.crawlPageUpdate,
        updateMany: mocks.crawlPageUpdateMany,
      },
      crawl: {
        update: mocks.crawlUpdate,
      },
      document: {
        findFirst: mocks.documentFindFirst,
        upsert: mocks.documentUpsert,
      },
      chunk: {
        findMany: mocks.chunkFindMany,
        deleteMany: mocks.chunkDeleteMany,
        createMany: mocks.chunkCreateMany,
      },
      deadLetter: {
        upsert: mocks.deadLetterUpsert,
      },
      $transaction: mocks.transaction,
    },
  };
});

vi.mock("../src/scraping/static-page.scraper", () => ({
  scrapeStaticPage: mocks.scrapeStaticPage,
}));

vi.mock("../src/scraping/link-discovery", () => ({
  discoverLinks: mocks.discoverLinks,
}));

vi.mock("../src/crawl/discover-pages", () => ({
  reserveDiscoveredPages: mocks.reserveDiscoveredPages,
}));

vi.mock("../src/crawl/crawl-state", () => ({
  refreshCrawlState: mocks.refreshCrawlState,
}));

vi.mock("../src/runtime/crawler-services", () => ({
  getCrawlerServices: () => ({
    config: {
      userAgent: "FixtureBot/1.0",
      defaultIntervalMs: 1,
      javascriptNavigationTimeoutMs: 15_000,
      javascriptSettleMs: 0,
      javascriptWaitSelectorTimeoutMs: 5_000,
      javascriptMaxContexts: 2,
      allowPrivateTestTargets: true,
    },
    httpClient: {},
    robotsService: {
      check: mocks.robotsCheck,
    },
    javascriptRenderer: {
      render: mocks.renderJavaScriptPage,
    },
  }),
}));

import {
  CrawlFailure,
  RobotsExcludedError,
} from "../src/errors/crawl-failure";
import { processCrawlJob } from "../src/jobs/crawl.job";
import { calculateContentHash } from "../src/lib/content-hash";

const crawlId = "9bed41b1-e380-4eec-906e-c56cb52cfe72";
const crawlPageId = "0e784632-c9e6-4b9d-afd2-8820eecb428b";
const childPageId = "a974d4a7-0cf7-461f-a78c-ef2a12e068a5";
const documentId = "73e9e18c-6074-449f-ad3c-ca333c0e9483";
const previousDocumentId = "4c6414e9-342d-4f18-a168-edcf90f8db79";
const pageUrl = "https://example.com/page";
const content = "Deterministic content";
const structuredData = { tables: [] };
const lastModified = "Sat, 26 Jul 2026 10:00:00 GMT";

const previousDocument = {
  id: previousDocumentId,
  url: pageUrl,
  rawHtml:
    '<main>Deterministic content<a href="/child">Child</a></main>',
  contentHash: calculateContentHash(content),
  etag: '"version-1"',
  lastModified,
};

function createJob(attemptsMade = 0): Job<
  CrawlJobData,
  CrawlJobResult,
  CrawlJobName
> {
  return {
    id: crawlPageId,
    data: {
      crawlPageId,
    },
    attemptsMade,
    opts: {
      attempts: 3,
    },
  } as unknown as Job<CrawlJobData, CrawlJobResult, CrawlJobName>;
}

function crawlPageRecord(
  status: CrawlPageStatus = CrawlPageStatus.QUEUED,
  document: { id: string; contentHash: string } | null = null,
) {
  return {
    id: crawlPageId,
    crawlId,
    url: pageUrl,
    normalizedUrl: pageUrl,
    depth: 0,
    parentPageId: null,
    status,
    attempts: 0,
    error: null,
    failureCategory: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    document,
    reusedDocument: null,
    notModified: false,
    reusedDocumentId: null,
    deadLetter: null,
    crawl: {
      id: crawlId,
      normalizedOrigin: "https://example.com",
      maxDepth: 2,
      renderMode: RenderMode.STATIC,
    },
  };
}

describe("processCrawlJob", () => {
  beforeEach(() => {
    mocks.crawlPageFindUnique.mockResolvedValue(crawlPageRecord());
    mocks.crawlPageUpdate.mockResolvedValue(crawlPageRecord());
    mocks.crawlPageUpdateMany.mockResolvedValue({ count: 1 });
    mocks.crawlUpdate.mockResolvedValue({});
    mocks.documentFindFirst.mockResolvedValue(null);
    mocks.scrapeStaticPage.mockResolvedValue({
      notModified: false,
      url: pageUrl,
      title: "Fixture",
      rawHtml: "<main>Deterministic content</main>",
      content,
      structuredData,
      etag: '"version-1"',
      lastModified,
      httpStatus: 200,
      contentType: "text/html",
      fetchedAt: new Date("2026-07-24T10:00:00.000Z"),
    });
    mocks.renderJavaScriptPage.mockResolvedValue({
      url: pageUrl,
      title: "Rendered fixture",
      rawHtml: "<main>Deterministic content</main>",
      content,
      structuredData,
      httpStatus: 200,
      contentType: "text/html",
      fetchedAt: new Date("2026-07-24T10:00:00.000Z"),
    });
    mocks.documentUpsert.mockResolvedValue({
      id: documentId,
    });
    mocks.chunkFindMany.mockResolvedValue([]);
    mocks.chunkDeleteMany.mockResolvedValue({ count: 0 });
    mocks.chunkCreateMany.mockResolvedValue({ count: 1 });
    mocks.deadLetterUpsert.mockResolvedValue({
      id: "ded1ed00-0000-4000-8000-000000000001",
    });
    mocks.discoverLinks.mockReturnValue([]);
    mocks.reserveDiscoveredPages.mockResolvedValue([]);
    mocks.refreshCrawlState.mockResolvedValue(undefined);
    mocks.queueAdd.mockResolvedValue({ id: childPageId });
    mocks.robotsCheck.mockResolvedValue({
      allowed: true,
      crawlDelayMs: 2_000,
    });
    mocks.transaction.mockImplementation(
      async (
        callback: (transaction: {
          crawlPage: {
            update: typeof mocks.crawlPageUpdate;
            updateMany: typeof mocks.crawlPageUpdateMany;
          };
          crawl: { update: typeof mocks.crawlUpdate };
          document: { upsert: typeof mocks.documentUpsert };
          chunk: {
            findMany: typeof mocks.chunkFindMany;
            deleteMany: typeof mocks.chunkDeleteMany;
            createMany: typeof mocks.chunkCreateMany;
          };
          deadLetter: { upsert: typeof mocks.deadLetterUpsert };
        }) => Promise<unknown>,
      ) =>
        callback({
          crawlPage: {
            update: mocks.crawlPageUpdate,
            updateMany: mocks.crawlPageUpdateMany,
          },
          crawl: {
            update: mocks.crawlUpdate,
          },
          document: {
            upsert: mocks.documentUpsert,
          },
          chunk: {
            findMany: mocks.chunkFindMany,
            deleteMany: mocks.chunkDeleteMany,
            createMany: mocks.chunkCreateMany,
          },
          deadLetter: {
            upsert: mocks.deadLetterUpsert,
          },
        }),
    );
  });

  it("persists one Document and completes the CrawlPage", async () => {
    const result = await processCrawlJob(createJob());

    expect(result).toMatchObject({
      crawlPageId,
      outcome: "COMPLETED",
      documentId,
    });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.crawlPageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: crawlPageId,
        },
        data: expect.objectContaining({
          status: CrawlPageStatus.PROCESSING,
          attempts: {
            increment: 1,
          },
        }),
      }),
    );
    expect(mocks.documentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          crawlPageId,
        },
        create: expect.objectContaining({ structuredData }),
        update: expect.objectContaining({ structuredData }),
      }),
    );
    expect(mocks.documentFindFirst).toHaveBeenCalledWith({
      where: {
        crawlPageId: {
          not: crawlPageId,
        },
        crawlPage: {
          normalizedUrl: pageUrl,
        },
      },
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        url: true,
        rawHtml: true,
        contentHash: true,
        etag: true,
        lastModified: true,
      },
    });
    expect(mocks.documentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          etag: '"version-1"',
          lastModified,
          previousVersionId: null,
        }),
      }),
    );
    expect(mocks.chunkFindMany).toHaveBeenCalledWith({
      where: {
        documentId,
      },
      select: {
        chunkIndex: true,
        content: true,
        contentHash: true,
        startOffset: true,
        endOffset: true,
      },
      orderBy: {
        chunkIndex: "asc",
      },
    });
    expect(mocks.chunkDeleteMany).toHaveBeenCalledWith({
      where: {
        documentId,
      },
    });
    expect(mocks.chunkCreateMany).toHaveBeenCalledWith({
      data: [
        {
          documentId,
          chunkIndex: 0,
          content,
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          startOffset: 0,
          endOffset: content.length,
        },
      ],
    });
    expect(mocks.crawlPageUpdate).toHaveBeenLastCalledWith({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.COMPLETED,
        notModified: false,
        reusedDocumentId: null,
        error: null,
        failureCategory: null,
        completedAt: expect.any(Date),
      },
    });
    expect(mocks.refreshCrawlState).toHaveBeenCalledWith(crawlId);
  });

  it("leaves identical persisted chunks untouched during reprocessing", async () => {
    mocks.chunkFindMany.mockResolvedValueOnce([
      {
        chunkIndex: 0,
        content,
        contentHash: calculateContentHash(content),
        startOffset: 0,
        endOffset: content.length,
      },
    ]);

    await processCrawlJob(createJob());

    expect(mocks.chunkDeleteMany).not.toHaveBeenCalled();
    expect(mocks.chunkCreateMany).not.toHaveBeenCalled();
  });

  it("replaces stale chunks when reprocessed content changes", async () => {
    mocks.chunkFindMany.mockResolvedValueOnce([
      {
        chunkIndex: 0,
        content: "Stale content",
        contentHash: calculateContentHash("Stale content"),
        startOffset: 0,
        endOffset: "Stale content".length,
      },
    ]);

    await processCrawlJob(createJob());

    expect(mocks.chunkDeleteMany).toHaveBeenCalledWith({
      where: {
        documentId,
      },
    });
    expect(mocks.chunkCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          documentId,
          chunkIndex: 0,
          content,
          contentHash: calculateContentHash(content),
        }),
      ],
    });
  });

  it("returns the existing Document for an already completed CrawlPage", async () => {
    mocks.crawlPageFindUnique.mockResolvedValueOnce(
      crawlPageRecord(CrawlPageStatus.COMPLETED, {
        id: documentId,
        contentHash: "a".repeat(64),
      }),
    );

    await expect(processCrawlJob(createJob())).resolves.toEqual({
      crawlPageId,
      outcome: "COMPLETED",
      documentId,
      contentHash: "a".repeat(64),
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
    expect(mocks.refreshCrawlState).toHaveBeenCalledWith(crawlId);
  });

  it("returns the reused Document for an already completed unchanged CrawlPage", async () => {
    mocks.crawlPageFindUnique.mockResolvedValueOnce({
      ...crawlPageRecord(CrawlPageStatus.COMPLETED),
      notModified: true,
      reusedDocumentId: previousDocumentId,
      reusedDocument: previousDocument,
    });

    await expect(processCrawlJob(createJob())).resolves.toEqual({
      crawlPageId,
      outcome: "COMPLETED",
      documentId: previousDocumentId,
      contentHash: previousDocument.contentHash,
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
  });

  it("sends validators, reuses a 304 Document, and discovers previous links", async () => {
    mocks.documentFindFirst.mockResolvedValueOnce(previousDocument);
    mocks.scrapeStaticPage.mockResolvedValueOnce({
      notModified: true,
      url: pageUrl,
      httpStatus: 304,
      etag: '"version-1"',
      lastModified,
      fetchedAt: new Date("2026-07-26T11:00:00.000Z"),
    });
    mocks.discoverLinks.mockReturnValueOnce([
      {
        url: "https://example.com/child",
        normalizedUrl: "https://example.com/child",
      },
    ]);
    mocks.reserveDiscoveredPages.mockResolvedValueOnce([
      {
        id: childPageId,
        normalizedUrl: "https://example.com/child",
      },
    ]);

    await expect(processCrawlJob(createJob())).resolves.toEqual({
      crawlPageId,
      outcome: "COMPLETED",
      documentId: previousDocumentId,
      contentHash: previousDocument.contentHash,
    });
    expect(mocks.scrapeStaticPage).toHaveBeenCalledWith(
      pageUrl,
      "https://example.com",
      expect.any(Object),
      2_000,
      expect.any(Function),
      {
        etag: '"version-1"',
        lastModified,
      },
    );
    expect(mocks.discoverLinks).toHaveBeenCalledWith(
      previousDocument.rawHtml,
      previousDocument.url,
      "https://example.com",
    );
    expect(mocks.documentUpsert).not.toHaveBeenCalled();
    expect(mocks.chunkFindMany).not.toHaveBeenCalled();
    expect(mocks.crawlPageUpdate).toHaveBeenLastCalledWith({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.COMPLETED,
        notModified: true,
        reusedDocumentId: previousDocumentId,
        error: null,
        failureCategory: null,
        completedAt: expect.any(Date),
      },
    });
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "scrape-static-page",
      { crawlPageId: childPageId },
      { jobId: childPageId },
    );
  });

  it("reuses the previous Document when a 200 response has the same hash", async () => {
    mocks.documentFindFirst.mockResolvedValueOnce(previousDocument);

    await expect(processCrawlJob(createJob())).resolves.toMatchObject({
      outcome: "COMPLETED",
      documentId: previousDocumentId,
      contentHash: previousDocument.contentHash,
    });
    expect(mocks.documentUpsert).not.toHaveBeenCalled();
    expect(mocks.chunkFindMany).not.toHaveBeenCalled();
    expect(mocks.crawlPageUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notModified: true,
          reusedDocumentId: previousDocumentId,
        }),
      }),
    );
  });

  it("creates a linked version and new chunks when static content changes", async () => {
    const changedContent = "Changed deterministic content";
    mocks.documentFindFirst.mockResolvedValueOnce(previousDocument);
    mocks.scrapeStaticPage.mockResolvedValueOnce({
      notModified: false,
      url: pageUrl,
      title: "Changed fixture",
      rawHtml: `<main>${changedContent}</main>`,
      content: changedContent,
      structuredData,
      etag: '"version-2"',
      lastModified: "Sat, 26 Jul 2026 11:00:00 GMT",
      httpStatus: 200,
      contentType: "text/html",
      fetchedAt: new Date("2026-07-26T11:00:00.000Z"),
    });

    const result = await processCrawlJob(createJob());

    expect(result.contentHash).toBe(calculateContentHash(changedContent));
    expect(result.contentHash).not.toBe(previousDocument.contentHash);
    expect(mocks.documentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          previousVersionId: previousDocumentId,
          etag: '"version-2"',
          lastModified: "Sat, 26 Jul 2026 11:00:00 GMT",
        }),
      }),
    );
    expect(mocks.chunkCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          documentId,
          content: changedContent,
          contentHash: calculateContentHash(changedContent),
        }),
      ],
    });
  });

  it("fails permanently when HTTP 304 has no previous Document", async () => {
    mocks.scrapeStaticPage.mockResolvedValueOnce({
      notModified: true,
      url: pageUrl,
      httpStatus: 304,
      etag: null,
      lastModified: null,
      fetchedAt: new Date("2026-07-26T11:00:00.000Z"),
    });

    await expect(processCrawlJob(createJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
      message: expect.stringContaining(
        "HTTP 304 without a previous document",
      ),
    });
    expect(mocks.documentUpsert).not.toHaveBeenCalled();
    expect(mocks.chunkFindMany).not.toHaveBeenCalled();
    expect(mocks.deadLetterUpsert).toHaveBeenCalledTimes(1);
  });

  it("uses JavaScript rendering while preserving the shared persistence path", async () => {
    mocks.crawlPageFindUnique.mockResolvedValueOnce({
      ...crawlPageRecord(),
      crawl: {
        ...crawlPageRecord().crawl,
        renderMode: RenderMode.JAVASCRIPT,
      },
    });

    await expect(processCrawlJob(createJob())).resolves.toMatchObject({
      outcome: "COMPLETED",
      documentId,
    });
    expect(mocks.renderJavaScriptPage).toHaveBeenCalledWith({
      url: pageUrl,
      allowedOrigin: "https://example.com",
      crawlDelayMs: 2_000,
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
    expect(mocks.documentFindFirst).not.toHaveBeenCalled();
    expect(mocks.documentUpsert).toHaveBeenCalledTimes(1);
  });

  it("marks a robots exclusion SKIPPED_ROBOTS without a dead letter", async () => {
    mocks.robotsCheck.mockResolvedValueOnce({
      allowed: false,
    });

    await expect(processCrawlJob(createJob())).resolves.toEqual({
      crawlPageId,
      outcome: "SKIPPED_ROBOTS",
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
    expect(mocks.deadLetterUpsert).not.toHaveBeenCalled();
    expect(mocks.crawlPageUpdate).toHaveBeenLastCalledWith({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.SKIPPED_ROBOTS,
        error: "Blocked by robots.txt",
        failureCategory: null,
        completedAt: expect.any(Date),
      },
    });
  });

  it("marks a robots-blocked redirect target without a dead letter", async () => {
    mocks.scrapeStaticPage.mockRejectedValueOnce(
      new RobotsExcludedError("https://example.com/private"),
    );

    await expect(processCrawlJob(createJob())).resolves.toEqual({
      crawlPageId,
      outcome: "SKIPPED_ROBOTS",
    });
    expect(mocks.deadLetterUpsert).not.toHaveBeenCalled();
    expect(mocks.crawlPageUpdate).toHaveBeenLastCalledWith({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.SKIPPED_ROBOTS,
        error: "Blocked by robots.txt",
        failureCategory: null,
        completedAt: expect.any(Date),
      },
    });
  });

  it("discovers and queues child pages using CrawlPage UUID job IDs", async () => {
    mocks.discoverLinks.mockReturnValue([
      {
        url: "https://example.com/child",
        normalizedUrl: "https://example.com/child",
      },
    ]);
    mocks.reserveDiscoveredPages.mockResolvedValue([
      {
        id: childPageId,
        normalizedUrl: "https://example.com/child",
      },
    ]);

    await processCrawlJob(createJob());

    expect(mocks.reserveDiscoveredPages).toHaveBeenCalledWith(
      {
        id: crawlPageId,
        crawlId,
        depth: 0,
      },
      expect.any(Array),
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "scrape-static-page",
      {
        crawlPageId: childPageId,
      },
      {
        jobId: childPageId,
      },
    );
    expect(mocks.crawlPageUpdateMany).toHaveBeenCalledWith({
      where: {
        id: childPageId,
        status: CrawlPageStatus.DISCOVERED,
      },
      data: {
        status: CrawlPageStatus.QUEUED,
      },
    });
  });

  it("does not discover links when the page is on the depth boundary", async () => {
    mocks.crawlPageFindUnique.mockResolvedValueOnce({
      ...crawlPageRecord(),
      depth: 2,
    });

    await processCrawlJob(createJob());

    expect(mocks.discoverLinks).not.toHaveBeenCalled();
    expect(mocks.reserveDiscoveredPages).not.toHaveBeenCalled();
  });

  it("marks a retryable failure as RETRYING and rethrows it", async () => {
    mocks.scrapeStaticPage.mockRejectedValueOnce(new Error("temporary timeout"));

    await expect(processCrawlJob(createJob(0))).rejects.toThrow(
      "temporary timeout",
    );

    expect(mocks.crawlPageUpdate).toHaveBeenLastCalledWith({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.RETRYING,
        error: "temporary timeout",
        failureCategory: "UNKNOWN",
        completedAt: null,
      },
    });
  });

  it("creates exactly one durable dead letter on the final attempt", async () => {
    mocks.scrapeStaticPage.mockRejectedValueOnce(
      new CrawlFailure(
        "HTTP_503",
        `terminal-${"x".repeat(3_000)}`,
        true,
      ),
    );

    await expect(processCrawlJob(createJob(2))).rejects.toThrow("terminal");

    const finalUpdate = mocks.crawlPageUpdate.mock.calls.at(-1)?.[0];
    expect(finalUpdate.data.status).toBe(CrawlPageStatus.FAILED);
    expect(finalUpdate.data.error).toHaveLength(2_000);
    expect(finalUpdate.data.failureCategory).toBe("HTTP_503");
    expect(finalUpdate.data.completedAt).toBeInstanceOf(Date);
    expect(mocks.crawlPageUpdateMany).toHaveBeenCalledWith({
      where: {
        parentPageId: crawlPageId,
        status: CrawlPageStatus.DISCOVERED,
      },
      data: {
        status: CrawlPageStatus.SKIPPED,
        error: "Parent page failed before this page could be queued",
        completedAt: expect.any(Date),
      },
    });
    expect(mocks.deadLetterUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.deadLetterUpsert).toHaveBeenCalledWith({
      where: {
        crawlPageId,
      },
      create: expect.objectContaining({
        crawlId,
        crawlPageId,
        jobId: crawlPageId,
        failureCategory: "HTTP_503",
        attemptCount: 3,
      }),
      update: {},
    });
  });

  it("does not duplicate a dead letter on idempotent redelivery", async () => {
    mocks.crawlPageFindUnique.mockResolvedValueOnce({
      ...crawlPageRecord(CrawlPageStatus.FAILED),
      deadLetter: {
        id: "ded1ed00-0000-4000-8000-000000000001",
      },
    });

    await expect(processCrawlJob(createJob(2))).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(mocks.deadLetterUpsert).not.toHaveBeenCalled();
  });

  it("does not retry a permanent crawler failure", async () => {
    mocks.scrapeStaticPage.mockRejectedValueOnce(
      new CrawlFailure(
        "UNSUPPORTED_CONTENT_TYPE",
        "not HTML",
        false,
      ),
    );

    await expect(processCrawlJob(createJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(mocks.deadLetterUpsert).toHaveBeenCalledTimes(1);
  });

  it("does not retry a job whose CrawlPage no longer exists", async () => {
    mocks.crawlPageFindUnique.mockResolvedValueOnce(null);

    await expect(processCrawlJob(createJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
  });
});
