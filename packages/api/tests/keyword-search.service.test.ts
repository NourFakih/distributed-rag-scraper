import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { keywordSearch } from "../src/services/search.service";

describe("keywordSearch", () => {
  it("returns ranked keyword rows without changing their deterministic order", async () => {
    const rows = [
      {
        chunkId: "00000000-0000-4000-8000-000000000001",
        documentId: "00000000-0000-4000-8000-000000000010",
        url: "https://example.com/books",
        title: "Book prices",
        chunkIndex: 0,
        excerpt: "A first book price.",
        relevance: 0.8,
      },
      {
        chunkId: "00000000-0000-4000-8000-000000000002",
        documentId: "00000000-0000-4000-8000-000000000020",
        url: "https://example.com/catalog",
        title: "Catalog",
        chunkIndex: 2,
        excerpt: "Another book price.",
        relevance: 0.6,
      },
    ];
    const queryRaw = vi.fn(async () => rows);

    await expect(
      keywordSearch(
        "book price",
        2,
        {
          $queryRaw: queryRaw,
        } as unknown as Pick<PrismaClient, "$queryRaw">,
      ),
    ).resolves.toEqual({
      query: "book price",
      resultCount: 2,
      results: rows,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns a stable empty result", async () => {
    await expect(
      keywordSearch(
        "missing",
        5,
        {
          $queryRaw: vi.fn(async () => []),
        } as unknown as Pick<PrismaClient, "$queryRaw">,
      ),
    ).resolves.toEqual({
      query: "missing",
      resultCount: 0,
      results: [],
    });
  });
});
