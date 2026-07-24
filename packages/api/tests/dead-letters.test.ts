import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  crawlFindUnique: vi.fn(),
  deadLetterFindMany: vi.fn(),
  deadLetterFindUnique: vi.fn(),
  deadLetterCount: vi.fn(),
}));

vi.mock("@distributed-rag/shared", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@distributed-rag/shared",
  );
  return {
    ...actual,
    prisma: {
      $transaction: mocks.transaction,
      crawl: {
        findUnique: mocks.crawlFindUnique,
      },
      deadLetter: {
        findMany: mocks.deadLetterFindMany,
        findUnique: mocks.deadLetterFindUnique,
        count: mocks.deadLetterCount,
      },
    },
  };
});

import { createApp } from "../app";

const crawlId = "9bed41b1-e380-4eec-906e-c56cb52cfe72";
const crawlPageId = "0e784632-c9e6-4b9d-afd2-8820eecb428b";
const deadLetterId = "ded1ed00-0000-4000-8000-000000000001";
const failedAt = new Date("2026-07-24T12:00:00.000Z");

function deadLetter() {
  return {
    id: deadLetterId,
    crawlId,
    crawlPageId,
    jobId: crawlPageId,
    url: "https://example.com/page",
    jobPayload: JSON.stringify({
      crawlPageId,
    }),
    failureCategory: "HTTP_503",
    errorMessage: "Service unavailable",
    attemptCount: 3,
    failedAt,
  };
}

describe("dead-letter API", () => {
  const app = createApp();

  beforeEach(() => {
    mocks.crawlFindUnique.mockResolvedValue({ id: crawlId });
    mocks.deadLetterFindMany.mockResolvedValue([deadLetter()]);
    mocks.deadLetterFindUnique.mockResolvedValue(deadLetter());
    mocks.deadLetterCount.mockResolvedValue(1);
    mocks.transaction.mockImplementation(
      async (operations: Promise<unknown>[]) => Promise.all(operations),
    );
  });

  it("returns paginated crawl dead letters as inspectable payloads", async () => {
    const response = await request(app).get(
      `/api/crawls/${crawlId}/dead-letters?page=1&pageSize=10`,
    );

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });
    expect(response.body.data[0]).toMatchObject({
      id: deadLetterId,
      crawlId,
      crawlPageId,
      jobPayload: {
        crawlPageId,
      },
      failureCategory: "HTTP_503",
      attemptCount: 3,
    });
  });

  it("returns a dead letter by ID", async () => {
    const response = await request(app).get(
      `/api/dead-letters/${deadLetterId}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.errorMessage).toBe("Service unavailable");
  });

  it("validates IDs and returns 404 for missing records", async () => {
    expect(
      (await request(app).get("/api/dead-letters/not-a-uuid")).status,
    ).toBe(422);

    mocks.deadLetterFindUnique.mockResolvedValueOnce(null);
    const missing = await request(app).get(
      `/api/dead-letters/${deadLetterId}`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("DEAD_LETTER_NOT_FOUND");

    mocks.crawlFindUnique.mockResolvedValueOnce(null);
    const missingCrawl = await request(app).get(
      `/api/crawls/${crawlId}/dead-letters`,
    );
    expect(missingCrawl.status).toBe(404);
  });
});
