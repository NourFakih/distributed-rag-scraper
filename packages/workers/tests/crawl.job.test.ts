import { CrawlStatus } from "@prisma/client";
import type {
  CrawlJobData,
  CrawlJobName,
  CrawlJobResult,
} from "@distributed-rag/shared";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  crawlFindUnique: vi.fn(),
  crawlUpdate: vi.fn(),
  documentUpsert: vi.fn(),
  transactionCrawlUpdate: vi.fn(),
  transaction: vi.fn(),
  scrapeStaticPage: vi.fn(),
}));

vi.mock("@distributed-rag/shared", async () => {
  const { z } = await import("zod");
  return {
    crawlJobDataSchema: z.object({
      crawlId: z.string().uuid(),
      url: z.string().url(),
    }),
    prisma: {
      crawl: {
        findUnique: mocks.crawlFindUnique,
        update: mocks.crawlUpdate,
      },
      $transaction: mocks.transaction,
    },
  };
});

vi.mock("../src/scraping/static-page.scraper", () => ({
  scrapeStaticPage: mocks.scrapeStaticPage,
}));

import { processCrawlJob } from "../src/jobs/crawl.job";

const crawlId = "9bed41b1-e380-4eec-906e-c56cb52cfe72";
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
      crawlId,
      url: pageUrl,
    },
    attemptsMade,
    opts: {
      attempts: 3,
    },
  } as unknown as Job<CrawlJobData, CrawlJobResult, CrawlJobName>;
}

function crawlRecord(
  status: CrawlStatus = CrawlStatus.QUEUED,
  document: { id: string; contentHash: string } | null = null,
) {
  return {
    id: crawlId,
    url: pageUrl,
    status,
    attempts: 0,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    document,
  };
}

describe("processCrawlJob", () => {
  beforeEach(() => {
    mocks.crawlFindUnique.mockResolvedValue(crawlRecord());
    mocks.crawlUpdate.mockResolvedValue(crawlRecord());
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
    mocks.transactionCrawlUpdate.mockResolvedValue(crawlRecord());
    mocks.transaction.mockImplementation(
      async (
        callback: (transaction: {
          document: { upsert: typeof mocks.documentUpsert };
          crawl: { update: typeof mocks.transactionCrawlUpdate };
        }) => Promise<unknown>,
      ) =>
        callback({
          document: {
            upsert: mocks.documentUpsert,
          },
          crawl: {
            update: mocks.transactionCrawlUpdate,
          },
        }),
    );
  });

  it("persists one Document and completes the Crawl transactionally", async () => {
    const result = await processCrawlJob(createJob());

    expect(result.documentId).toBe(documentId);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.crawlUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: crawlId,
        },
        data: expect.objectContaining({
          status: CrawlStatus.PROCESSING,
          attempts: {
            increment: 1,
          },
        }),
      }),
    );
    expect(mocks.documentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          crawlId,
        },
      }),
    );
    expect(mocks.transactionCrawlUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CrawlStatus.COMPLETED,
        }),
      }),
    );
  });

  it("returns the existing Document for an already completed Crawl", async () => {
    mocks.crawlFindUnique.mockResolvedValueOnce(
      crawlRecord(CrawlStatus.COMPLETED, {
        id: documentId,
        contentHash: "a".repeat(64),
      }),
    );

    await expect(processCrawlJob(createJob())).resolves.toEqual({
      documentId,
      contentHash: "a".repeat(64),
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
    expect(mocks.crawlUpdate).not.toHaveBeenCalled();
  });

  it("marks a retryable failure as RETRYING and rethrows it", async () => {
    mocks.scrapeStaticPage.mockRejectedValueOnce(new Error("temporary timeout"));

    await expect(processCrawlJob(createJob(0))).rejects.toThrow(
      "temporary timeout",
    );

    expect(mocks.crawlUpdate).toHaveBeenLastCalledWith({
      where: {
        id: crawlId,
      },
      data: {
        status: CrawlStatus.RETRYING,
        errorMessage: "temporary timeout",
        completedAt: null,
      },
    });
  });

  it("marks the final failure as FAILED with a bounded message", async () => {
    mocks.scrapeStaticPage.mockRejectedValueOnce(
      new Error(`terminal-${"x".repeat(3_000)}`),
    );

    await expect(processCrawlJob(createJob(2))).rejects.toThrow("terminal");

    const finalUpdate = mocks.crawlUpdate.mock.calls.at(-1)?.[0];
    expect(finalUpdate.data.status).toBe(CrawlStatus.FAILED);
    expect(finalUpdate.data.errorMessage).toHaveLength(2_000);
    expect(finalUpdate.data.completedAt).toBeInstanceOf(Date);
  });

  it("does not retry a job whose Crawl no longer exists", async () => {
    mocks.crawlFindUnique.mockResolvedValueOnce(null);

    await expect(processCrawlJob(createJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
    });
    expect(mocks.scrapeStaticPage).not.toHaveBeenCalled();
  });
});

