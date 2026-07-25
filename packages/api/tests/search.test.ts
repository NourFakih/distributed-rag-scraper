import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  embedQuery: vi.fn(),
}));

type SharedExports = Record<string, unknown>;

vi.mock("@distributed-rag/shared", async () => {
  const actual = await vi.importActual<SharedExports>(
    "@distributed-rag/shared",
  );
  return {
    ...actual,
    getEmbeddingProvider: () => ({
      modelId: "fixture-e5",
      modelVersion: "fixture-v1",
      dimension: 384,
      embedQuery: sharedMocks.embedQuery,
    }),
    prisma: {
      $queryRaw: sharedMocks.queryRaw,
    },
  };
});

import { createApp } from "../app";

const firstResult = {
  chunkId: "00000000-0000-4000-8000-000000000001",
  documentId: "00000000-0000-4000-8000-000000000010",
  url: "https://example.com/guide",
  title: "Guide",
  chunkIndex: 0,
  excerpt: "Deterministic crawling guide",
  similarity: 0.93,
};

describe("semantic search API", () => {
  const app = createApp();

  beforeEach(() => {
    sharedMocks.embedQuery.mockResolvedValue([
      1,
      ...Array.from({ length: 383 }, () => 0),
    ]);
    sharedMocks.queryRaw.mockResolvedValue([firstResult]);
  });

  it("returns the stable response without raw vectors", async () => {
    const response = await request(app).get(
      "/api/search?q=%20crawler%20&limit=1",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        query: "crawler",
        activeEmbeddingModel: {
          id: "fixture-e5",
          version: "fixture-v1",
          dimension: 384,
        },
        resultCount: 1,
        results: [firstResult],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("embedding");
    expect(sharedMocks.embedQuery).toHaveBeenCalledWith("crawler");
  });

  it("returns HTTP 200 and no results for an empty index", async () => {
    sharedMocks.queryRaw.mockResolvedValueOnce([]);

    const response = await request(app).get("/api/search?q=missing");

    expect(response.status).toBe(200);
    expect(response.body.data.resultCount).toBe(0);
    expect(response.body.data.results).toEqual([]);
  });

  it.each([
    "/api/search",
    "/api/search?q=%20%20",
    `/api/search?q=${"x".repeat(513)}`,
    "/api/search?q=valid&limit=0",
    "/api/search?q=valid&limit=21",
    "/api/search?q=valid&limit=1.5",
    "/api/search?q=valid&limit=nope",
  ])("returns the standard 422 validation shape for %s", async (url) => {
    const response = await request(app).get(url);

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
    });
    expect(sharedMocks.embedQuery).not.toHaveBeenCalled();
  });

  it("uses the default result limit", async () => {
    await request(app).get("/api/search?q=valid");

    const sql = sharedMocks.queryRaw.mock.calls[0]?.[0] as {
      values: unknown[];
    };
    expect(sql.values.at(-1)).toBe(5);
  });

  it("uses cosine ordering with deterministic Chunk-ID tie-breaking", async () => {
    await request(app).get("/api/search?q=valid&limit=2");

    const sql = sharedMocks.queryRaw.mock.calls[0]?.[0] as {
      strings: string[];
    };
    const statement = sql.strings.join("?");
    expect(statement).toContain('chunk."embedding" <=>');
    expect(statement).toMatch(
      /ORDER BY[\s\S]*chunk\."embedding"[\s\S]*ASC,[\s\S]*chunk\."id" ASC/u,
    );
  });
});
