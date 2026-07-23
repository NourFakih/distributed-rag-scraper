import { CrawlStatus } from "@prisma/client";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  crawlCreate: vi.fn(),
  crawlFindUnique: vi.fn(),
  crawlUpdate: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@distributed-rag/shared", () => ({
  prisma: {
    crawl: {
      create: sharedMocks.crawlCreate,
      findUnique: sharedMocks.crawlFindUnique,
      update: sharedMocks.crawlUpdate,
    },
  },
  getCrawlQueue: () => ({
    add: sharedMocks.queueAdd,
  }),
  SCRAPE_STATIC_PAGE_JOB: "scrape-static-page",
}));

import { createApp } from "../app";

const crawlId = "9bed41b1-e380-4eec-906e-c56cb52cfe72";
const documentId = "73e9e18c-6074-449f-ad3c-ca333c0e9483";
const createdAt = new Date("2026-07-24T10:00:00.000Z");
const updatedAt = new Date("2026-07-24T10:00:01.000Z");

function queuedCrawl() {
  return {
    id: crawlId,
    url: "https://example.com/page?lang=en",
    status: CrawlStatus.QUEUED,
    attempts: 0,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt,
    updatedAt,
  };
}

describe("crawl API", () => {
  const app = createApp();

  beforeEach(() => {
    sharedMocks.crawlCreate.mockResolvedValue(queuedCrawl());
    sharedMocks.crawlUpdate.mockResolvedValue(queuedCrawl());
    sharedMocks.queueAdd.mockResolvedValue({ id: crawlId });
  });

  it("creates a Crawl, strips the fragment, and enqueues the UUID job", async () => {
    const response = await request(app).post("/api/crawls").send({
      url: "  https://example.com/page?lang=en#section  ",
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      data: {
        id: crawlId,
        url: "https://example.com/page?lang=en",
        status: "QUEUED",
        createdAt: createdAt.toISOString(),
      },
    });
    expect(sharedMocks.crawlCreate).toHaveBeenCalledWith({
      data: {
        url: "https://example.com/page?lang=en",
      },
    });
    expect(sharedMocks.queueAdd).toHaveBeenCalledWith(
      "scrape-static-page",
      {
        crawlId,
        url: "https://example.com/page?lang=en",
      },
      {
        jobId: crawlId,
      },
    );
  });

  it.each([
    ["relative URL", { url: "/relative" }],
    ["non-HTTP URL", { url: "ftp://example.com/file" }],
    ["credentials", { url: "https://user:secret@example.com/" }],
    ["extra field", { url: "https://example.com", depth: 2 }],
    ["malformed URL", { url: "not a url" }],
    ["oversized URL", { url: `https://example.com/${"a".repeat(2_100)}` }],
  ])("returns 422 for %s", async (_label, body) => {
    const response = await request(app).post("/api/crawls").send(body);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(sharedMocks.crawlCreate).not.toHaveBeenCalled();
  });

  it("marks the Crawl failed and returns 503 when enqueueing fails", async () => {
    sharedMocks.queueAdd.mockRejectedValueOnce(new Error("Redis unavailable"));

    const response = await request(app)
      .post("/api/crawls")
      .send({ url: "https://example.com/page?lang=en" });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("QUEUE_UNAVAILABLE");
    expect(sharedMocks.crawlUpdate).toHaveBeenCalledWith({
      where: {
        id: crawlId,
      },
      data: {
        status: CrawlStatus.FAILED,
        errorMessage: "Redis unavailable",
        completedAt: expect.any(Date),
      },
    });
  });

  it("returns a Crawl with its document relation", async () => {
    sharedMocks.crawlFindUnique.mockResolvedValue({
      ...queuedCrawl(),
      status: CrawlStatus.COMPLETED,
      attempts: 1,
      startedAt: createdAt,
      completedAt: updatedAt,
      document: {
        id: documentId,
      },
    });

    const response = await request(app).get(`/api/crawls/${crawlId}`);

    expect(response.status).toBe(200);
    expect(response.body.data.documentId).toBe(documentId);
    expect(response.body.data.status).toBe("COMPLETED");
    expect(response.body.data.attempts).toBe(1);
  });

  it("returns 422 for a malformed Crawl ID", async () => {
    const response = await request(app).get("/api/crawls/not-a-uuid");

    expect(response.status).toBe(422);
    expect(sharedMocks.crawlFindUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing Crawl", async () => {
    sharedMocks.crawlFindUnique.mockResolvedValueOnce(null);

    const response = await request(app).get(`/api/crawls/${crawlId}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("CRAWL_NOT_FOUND");
  });
});

