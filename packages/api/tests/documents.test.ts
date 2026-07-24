import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  documentFindUnique: vi.fn(),
}));

vi.mock("@distributed-rag/shared", () => ({
  prisma: {
    document: {
      findUnique: sharedMocks.documentFindUnique,
    },
  },
  getCrawlQueue: vi.fn(),
  SCRAPE_STATIC_PAGE_JOB: "scrape-static-page",
}));

import { createApp } from "../app";

const documentId = "73e9e18c-6074-449f-ad3c-ca333c0e9483";
const crawlId = "9bed41b1-e380-4eec-906e-c56cb52cfe72";
const crawlPageId = "0e784632-c9e6-4b9d-afd2-8820eecb428b";
const timestamp = new Date("2026-07-24T10:00:00.000Z");

describe("document API", () => {
  const app = createApp();

  beforeEach(() => {
    sharedMocks.documentFindUnique.mockResolvedValue({
      id: documentId,
      crawlPageId,
      url: "https://example.com/page",
      title: "Fixture",
      rawHtml: "<main><p>Fixture content</p></main>",
      content: "Fixture content",
      contentHash:
        "20aa0fc8b31ef2e4d79f7df96534d4a8d3cf181ddf736e74febf429425f005cd",
      httpStatus: 200,
      contentType: "text/html; charset=utf-8",
      fetchedAt: timestamp,
      createdAt: timestamp,
      crawlPage: {
        crawlId,
      },
    });
  });

  it("returns the persisted raw and normalized document", async () => {
    const response = await request(app).get(`/api/documents/${documentId}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: documentId,
      crawlId,
      crawlPageId,
      rawHtml: "<main><p>Fixture content</p></main>",
      content: "Fixture content",
      httpStatus: 200,
    });
    expect(response.body.data.contentHash).toHaveLength(64);
  });

  it("returns 422 for a malformed Document ID", async () => {
    const response = await request(app).get("/api/documents/not-a-uuid");

    expect(response.status).toBe(422);
    expect(sharedMocks.documentFindUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing Document", async () => {
    sharedMocks.documentFindUnique.mockResolvedValueOnce(null);

    const response = await request(app).get(`/api/documents/${documentId}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("DOCUMENT_NOT_FOUND");
  });
});
