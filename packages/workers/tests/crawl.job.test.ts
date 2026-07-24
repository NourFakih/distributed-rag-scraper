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
  documentUpsert: vi.fn(),
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
        upsert: mocks.documentUpsert,
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

const crawlId = "9bed41b1-e380-4eec-906e-c56cb52cfe72";
const crawlPageId = "0e784632-c9e6-4b9d-afd2-8820eecb428b";
const childPageId = "a974d4a7-0cf7-461f-a78c-ef2a12e068a5";
const documentId = "73e9e18c-6074-449f-ad3c-ca333c0e9483";
const pageUrl = "https://example.com/page";
const content = "Deterministic content";

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
    mocks.scrapeStaticPage.mockResolvedValue({
      url: pageUrl,
      title: "Fixture",
      rawHtml: "<main>Deterministic content</main>",
      content,
      httpStatus: 200,
      contentType: "text/html",
      fetchedAt: new Date("2026-07-24T10:00:00.000Z"),
    });
    mocks.renderJavaScriptPage.mockResolvedValue({
      url: pageUrl,
      title: "Rendered fixture",
      rawHtml: "<main>Deterministic content</main>",
      content,
      httpStatus: 200,
      contentType: "text/html",
      fetchedAt: new Date("2026-07-24T10:00:00.000Z"),
    });
    mocks.documentUpsert.mockResolvedValue({
      id: documentId,
    });
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
      }),
    );
    expect(mocks.crawlPageUpdate).toHaveBeenLastCalledWith({
      where: {
        id: crawlPageId,
      },
      data: {
        status: CrawlPageStatus.COMPLETED,
        error: null,
        failureCategory: null,
        completedAt: expect.any(Date),
      },
    });
    expect(mocks.refreshCrawlState).toHaveBeenCalledWith(crawlId);
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
