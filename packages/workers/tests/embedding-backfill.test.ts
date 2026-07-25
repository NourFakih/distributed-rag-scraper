import type { EmbeddingProvider } from "@distributed-rag/shared";
import { describe, expect, it, vi } from "vitest";

import {
  needsEmbedding,
  runEmbeddingBackfill,
  type EmbeddingBackfillChunk,
} from "../src/backfill/embedding-backfill";

const provider: EmbeddingProvider = {
  modelId: "fixture-e5",
  modelVersion: "version-2",
  dimension: 2,
  embedPassage: vi.fn(async () => [1, 0]),
  embedQuery: vi.fn(async () => [1, 0]),
  embedPassages: vi.fn(async (contents) =>
    contents.map(() => [1, 0]),
  ),
};

function chunk(
  overrides: Partial<EmbeddingBackfillChunk> = {},
): EmbeddingBackfillChunk {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    content: "content",
    contentHash: "a".repeat(64),
    embeddingPresent: true,
    embeddingModel: provider.modelId,
    embeddingVersion: provider.modelVersion,
    embeddedContentHash: "a".repeat(64),
    ...overrides,
  };
}

describe("embedding backfill", () => {
  it("detects missing, changed-content, and changed-model embeddings", () => {
    expect(needsEmbedding(chunk(), provider)).toBe(false);
    expect(
      needsEmbedding(
        chunk({
          embeddingPresent: false,
        }),
        provider,
      ),
    ).toBe(true);
    expect(
      needsEmbedding(
        chunk({
          embeddedContentHash: "b".repeat(64),
        }),
        provider,
      ),
    ).toBe(true);
    expect(
      needsEmbedding(
        chunk({
          embeddingVersion: "version-1",
        }),
        provider,
      ),
    ).toBe(true);
  });

  it("skips current rows and persists stale rows idempotently", async () => {
    const stale = chunk({
      id: "00000000-0000-4000-8000-000000000002",
      embeddingPresent: false,
      embeddingModel: null,
      embeddingVersion: null,
      embeddedContentHash: null,
    });
    const listChunksAfter = vi
      .fn()
      .mockResolvedValueOnce([chunk(), stale])
      .mockResolvedValueOnce([]);
    const persistEmbedding = vi.fn(async () => true);

    const summary = await runEmbeddingBackfill(
      {
        batchSize: 2,
      },
      {
        repository: {
          listChunksAfter,
          persistEmbedding,
        },
        provider,
        retryDelaysMs: [0, 0],
        now: vi
          .fn()
          .mockReturnValueOnce(1_000)
          .mockReturnValueOnce(1_025),
      },
    );

    expect(summary).toEqual({
      chunksInspected: 2,
      chunksEmbedded: 1,
      chunksSkipped: 1,
      chunksFailed: 0,
      batchesCompleted: 1,
      elapsedMs: 25,
    });
    expect(provider.embedPassages).toHaveBeenCalledWith(["content"]);
    expect(persistEmbedding).toHaveBeenCalledWith(
      stale,
      [1, 0],
      provider,
    );
  });

  it("retries a failed batch, falls back per chunk, and continues safely", async () => {
    const stale = chunk({
      embeddingPresent: false,
      embeddingModel: null,
      embeddingVersion: null,
      embeddedContentHash: null,
    });
    const failingProvider: EmbeddingProvider = {
      ...provider,
      embedPassages: vi.fn(async () => {
        throw new Error("batch failed");
      }),
      embedPassage: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce([1, 0]),
    };

    const summary = await runEmbeddingBackfill(
      {
        batchSize: 1,
        limit: 1,
      },
      {
        repository: {
          listChunksAfter: vi.fn(async () => [stale]),
          persistEmbedding: vi.fn(async () => true),
        },
        provider: failingProvider,
        retryDelaysMs: [0, 0],
      },
    );

    expect(failingProvider.embedPassages).toHaveBeenCalledTimes(3);
    expect(failingProvider.embedPassage).toHaveBeenCalledTimes(2);
    expect(summary.chunksEmbedded).toBe(1);
    expect(summary.chunksFailed).toBe(0);
  });
});
