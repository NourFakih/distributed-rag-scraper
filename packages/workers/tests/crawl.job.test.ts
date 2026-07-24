import { CrawlPageStatus } from "@prisma/client";
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
  transaction: vi.fn(),
  queueAdd: vi.fn(),
  scrapeStaticPage: vi.fn(),
  discoverLinks: vi.fn(),
  reserveDiscoveredPages: vi.fn(),
  refreshCrawlState: vi.fn(),
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
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    document,
    crawl: {
      id: crawlId,
      normalizedOrigin: "https://example.com",
      maxDepth: 2,
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
    mocks.documentUpsert.mockResolvedValue({
      id: documentId,
    });
    mocks.discoverLinks.mockReturnValue([]);
    mocks.reserveDiscoveredPages.mockResolvedValue([]);
    mocks.refreshCrawlState.mockResolvedValue(undefined);
    mocks.queueAdd.mockResolvedValue({ id: childPageId });
    mocks.transaction.mockImplementation(
      async (
        callback: (transaction: {
          crawlPage: { update: typeof mocks.crawlPageUpdate };
          crawl: { update: typeof mocks.crawlUpdate };
        }) => Promise<unknown>,
      ) =>
        callback({
          crawlPage: {
            update: mocks.crawlPageUpdate,
          },
          crawl: {
            update: mocks.crawlUpdate,
          },
        }),
    );
  });

  it("persists one Document and completes the CrawlPage", async () => {
    const result = await processCrawlJob(createJob());

    expect(result).toMatchObject({
      crawlPageId,
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
      documentId,
      contentHash: "a".repeat(64),
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
    expect(mocks.refreshCrawlState).toHaveBeenCalledWith(crawlId);
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
        completedAt: null,
      },
    });
  });

  it("marks the final failure as FAILED with a bounded message", async () => {
    mocks.scrapeStaticPage.mockRejectedValueOnce(
      new Error(`terminal-${"x".repeat(3_000)}`),
    );

    await expect(processCrawlJob(createJob(2))).rejects.toThrow("terminal");

    const finalUpdate = mocks.crawlPageUpdate.mock.calls.at(-1)?.[0];
    expect(finalUpdate.data.status).toBe(CrawlPageStatus.FAILED);
    expect(finalUpdate.data.error).toHaveLength(2_000);
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
  });

  it("does not retry a job whose CrawlPage no longer exists", async () => {
    mocks.crawlPageFindUnique.mockResolvedValueOnce(null);

    await expect(processCrawlJob(createJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
  });
});
