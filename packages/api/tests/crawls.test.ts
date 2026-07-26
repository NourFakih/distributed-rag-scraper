import {
  CrawlPageStatus,
  CrawlStatus,
  RenderMode,
} from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  crawlCreate: vi.fn(),
  crawlFindUnique: vi.fn(),
  crawlUpdate: vi.fn(),
  crawlPageCreate: vi.fn(),
  crawlPageUpdate: vi.fn(),
  crawlPageFindMany: vi.fn(),
  crawlPageCount: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@distributed-rag/shared", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@distributed-rag/shared",
  );

  return {
    ...actual,
    prisma: {
      $transaction: sharedMocks.transaction,
      crawl: {
        create: sharedMocks.crawlCreate,
        findUnique: sharedMocks.crawlFindUnique,
        update: sharedMocks.crawlUpdate,
      },
      crawlPage: {
        create: sharedMocks.crawlPageCreate,
        update: sharedMocks.crawlPageUpdate,
        findMany: sharedMocks.crawlPageFindMany,
        count: sharedMocks.crawlPageCount,
      },
    },
    getCrawlQueue: () => ({
      add: sharedMocks.queueAdd,
    }),
  };
});

import { createApp } from "../app";

const crawlId = "9bed41b1-e380-4eec-906e-c56cb52cfe72";
const rootPageId = "0e784632-c9e6-4b9d-afd2-8820eecb428b";
const childPageId = "a974d4a7-0cf7-461f-a78c-ef2a12e068a5";
const documentId = "73e9e18c-6074-449f-ad3c-ca333c0e9483";
const createdAt = new Date("2026-07-24T10:00:00.000Z");
const updatedAt = new Date("2026-07-24T10:00:01.000Z");
const seedUrl = "https://example.com/page?lang=en";

function queuedCrawl() {
  return {
    id: crawlId,
    seedUrl,
    normalizedOrigin: "https://example.com",
    renderMode: RenderMode.STATIC,
    status: CrawlStatus.QUEUED,
    maxPages: 25,
    maxDepth: 2,
    discoveredCount: 1,
    completedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    completedAt: null,
    createdAt,
    updatedAt,
  };
}

function rootPage() {
  return {
    id: rootPageId,
    crawlId,
    url: seedUrl,
    normalizedUrl: seedUrl,
    depth: 0,
    parentPageId: null,
    status: CrawlPageStatus.QUEUED,
    attempts: 0,
    error: null,
    failureCategory: null,
    notModified: false,
    reusedDocumentId: null,
    createdAt,
    startedAt: null,
    completedAt: null,
    document: null,
  };
}

describe("crawl API", () => {
  const app = createApp();

  beforeEach(() => {
    sharedMocks.crawlCreate.mockResolvedValue(queuedCrawl());
    sharedMocks.crawlPageCreate.mockResolvedValue(rootPage());
    sharedMocks.crawlUpdate.mockResolvedValue(queuedCrawl());
    sharedMocks.crawlPageUpdate.mockResolvedValue(rootPage());
    sharedMocks.queueAdd.mockResolvedValue({ id: rootPageId });
    sharedMocks.transaction.mockImplementation(
      async (
        operation:
          | Promise<unknown>[]
          | ((
              transaction: {
                crawl: {
                  create: typeof sharedMocks.crawlCreate;
                  update: typeof sharedMocks.crawlUpdate;
                };
                crawlPage: {
                  create: typeof sharedMocks.crawlPageCreate;
                  update: typeof sharedMocks.crawlPageUpdate;
                };
              },
            ) => Promise<unknown>),
      ) => {
        if (Array.isArray(operation)) {
          return Promise.all(operation);
        }

        return operation({
          crawl: {
            create: sharedMocks.crawlCreate,
            update: sharedMocks.crawlUpdate,
          },
          crawlPage: {
            create: sharedMocks.crawlPageCreate,
            update: sharedMocks.crawlPageUpdate,
          },
        });
      },
    );
  });

  it("keeps the basic request, applies defaults, and queues the root page", async () => {
    const response = await request(app).post("/api/crawls").send({
      url: "  https://example.com/page?lang=en#section  ",
    });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      id: crawlId,
      url: seedUrl,
      seedUrl,
      status: "QUEUED",
      maxPages: 25,
      maxDepth: 2,
      renderMode: "STATIC",
      rootPageId,
    });
    expect(sharedMocks.crawlCreate).toHaveBeenCalledWith({
      data: {
        seedUrl,
        normalizedOrigin: "https://example.com",
        maxPages: 25,
        maxDepth: 2,
        renderMode: RenderMode.STATIC,
      },
    });
    expect(sharedMocks.crawlPageCreate).toHaveBeenCalledWith({
      data: {
        crawlId,
        url: seedUrl,
        normalizedUrl: seedUrl,
        depth: 0,
        status: CrawlPageStatus.QUEUED,
      },
    });
    expect(sharedMocks.queueAdd).toHaveBeenCalledWith(
      "scrape-static-page",
      {
        crawlPageId: rootPageId,
      },
      {
        jobId: rootPageId,
      },
    );
  });

  it("accepts explicit crawl bounds", async () => {
    const response = await request(app).post("/api/crawls").send({
      url: seedUrl,
      maxPages: 100,
      maxDepth: 4,
    });

    expect(response.status).toBe(202);
    expect(sharedMocks.crawlCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        maxPages: 100,
        maxDepth: 4,
      }),
    });
  });

  it("accepts JAVASCRIPT rendering and returns it from crawl APIs", async () => {
    sharedMocks.crawlCreate.mockResolvedValueOnce({
      ...queuedCrawl(),
      renderMode: RenderMode.JAVASCRIPT,
    });
    sharedMocks.crawlFindUnique.mockResolvedValueOnce({
      ...queuedCrawl(),
      renderMode: RenderMode.JAVASCRIPT,
      pages: [rootPage()],
    });

    const created = await request(app).post("/api/crawls").send({
      url: seedUrl,
      renderMode: "JAVASCRIPT",
    });
    const retrieved = await request(app).get(`/api/crawls/${crawlId}`);

    expect(created.status).toBe(202);
    expect(created.body.data.renderMode).toBe("JAVASCRIPT");
    expect(retrieved.body.data.renderMode).toBe("JAVASCRIPT");
    expect(sharedMocks.crawlCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        renderMode: RenderMode.JAVASCRIPT,
      }),
    });
  });

  it.each([
    ["relative URL", { url: "/relative" }],
    ["non-HTTP URL", { url: "ftp://example.com/file" }],
    ["credentials", { url: "https://user:secret@example.com/" }],
    ["downloadable seed", { url: "https://example.com/manual.pdf" }],
    ["extra field", { url: "https://example.com", depth: 2 }],
    ["malformed URL", { url: "not a url" }],
    ["oversized URL", { url: `https://example.com/${"a".repeat(2_100)}` }],
    ["maxPages below range", { url: seedUrl, maxPages: 0 }],
    ["maxPages above range", { url: seedUrl, maxPages: 501 }],
    ["maxDepth below range", { url: seedUrl, maxDepth: -1 }],
    ["maxDepth above range", { url: seedUrl, maxDepth: 11 }],
    ["invalid renderMode", { url: seedUrl, renderMode: "AUTO" }],
  ])("returns 422 for %s", async (_label, body) => {
    const response = await request(app).post("/api/crawls").send(body);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(sharedMocks.crawlCreate).not.toHaveBeenCalled();
  });

  it("marks the root page and Crawl failed when enqueueing fails", async () => {
    sharedMocks.queueAdd.mockRejectedValueOnce(new Error("Redis unavailable"));

    const response = await request(app)
      .post("/api/crawls")
      .send({ url: seedUrl });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("QUEUE_UNAVAILABLE");
    expect(sharedMocks.crawlPageUpdate).toHaveBeenCalledWith({
      where: {
        id: rootPageId,
      },
      data: {
        status: CrawlPageStatus.FAILED,
        error: "Redis unavailable",
        completedAt: expect.any(Date),
      },
    });
    expect(sharedMocks.crawlUpdate).toHaveBeenCalledWith({
      where: {
        id: crawlId,
      },
      data: {
        status: CrawlStatus.FAILED,
        failedCount: 1,
        completedAt: expect.any(Date),
      },
    });
  });

  it("returns aggregate limits, counters, and root page information", async () => {
    sharedMocks.crawlFindUnique.mockResolvedValue({
      ...queuedCrawl(),
      status: CrawlStatus.COMPLETED,
      completedCount: 1,
      failedCount: 1,
      completedAt: updatedAt,
      pages: [
        {
          ...rootPage(),
          status: CrawlPageStatus.COMPLETED,
          attempts: 1,
          startedAt: createdAt,
          completedAt: updatedAt,
          document: {
            id: documentId,
          },
        },
      ],
    });

    const response = await request(app).get(`/api/crawls/${crawlId}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "COMPLETED",
      renderMode: "STATIC",
      limits: {
        maxPages: 25,
        maxDepth: 2,
      },
      counters: {
        discovered: 1,
        completed: 1,
        skipped: 0,
        failed: 1,
      },
      documentId,
      completedWithFailures: true,
      rootPage: {
        id: rootPageId,
        documentId,
      },
    });
  });

  it("exposes reused document metadata for an unchanged root page", async () => {
    sharedMocks.crawlFindUnique.mockResolvedValue({
      ...queuedCrawl(),
      status: CrawlStatus.COMPLETED,
      completedCount: 1,
      pages: [
        {
          ...rootPage(),
          status: CrawlPageStatus.COMPLETED,
          notModified: true,
          reusedDocumentId: documentId,
        },
      ],
    });

    const response = await request(app).get(`/api/crawls/${crawlId}`);

    expect(response.body.data).toMatchObject({
      documentId,
      notModified: true,
      reusedDocumentId: documentId,
      rootPage: {
        documentId,
        notModified: true,
        reusedDocumentId: documentId,
      },
    });
  });

  it("returns a paginated page list without raw HTML", async () => {
    sharedMocks.crawlFindUnique.mockResolvedValue({ id: crawlId });
    sharedMocks.crawlPageFindMany.mockResolvedValue([
      {
        ...rootPage(),
        id: childPageId,
        depth: 1,
        parentPageId: rootPageId,
      },
    ]);
    sharedMocks.crawlPageCount.mockResolvedValue(3);

    const response = await request(app).get(
      `/api/crawls/${crawlId}/pages?page=2&pageSize=1`,
    );

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 2,
      pageSize: 1,
      total: 3,
      totalPages: 3,
    });
    expect(response.body.data[0]).not.toHaveProperty("rawHtml");
    expect(response.body.data[0]).toMatchObject({
      notModified: false,
      reusedDocumentId: null,
    });
    expect(sharedMocks.crawlPageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 1,
        take: 1,
      }),
    );
  });

  it("returns 422 for malformed Crawl IDs and pagination", async () => {
    expect(
      (await request(app).get("/api/crawls/not-a-uuid")).status,
    ).toBe(422);
    expect(
      (
        await request(app).get(
          `/api/crawls/${crawlId}/pages?page=0&pageSize=101`,
        )
      ).status,
    ).toBe(422);
  });

  it("returns 404 for a missing Crawl and missing page-list Crawl", async () => {
    sharedMocks.crawlFindUnique.mockResolvedValue(null);

    const crawlResponse = await request(app).get(`/api/crawls/${crawlId}`);
    const pagesResponse = await request(app).get(
      `/api/crawls/${crawlId}/pages`,
    );

    expect(crawlResponse.status).toBe(404);
    expect(pagesResponse.status).toBe(404);
  });
});
