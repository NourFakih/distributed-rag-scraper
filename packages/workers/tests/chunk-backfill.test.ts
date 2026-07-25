import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  runChunkBackfill,
  type ChunkBackfillClient,
} from "../src/backfill/chunk-backfill";
import { chunkText } from "../src/processing/chunk-text";

function transactionFor(
  chunks: ReturnType<typeof chunkText>,
): Prisma.TransactionClient {
  return {
    chunk: {
      findMany: vi.fn(async () => chunks),
      deleteMany: vi.fn(async () => ({
        count: chunks.length,
      })),
      createMany: vi.fn(async ({ data }) => ({
        count: Array.isArray(data) ? data.length : 0,
      })),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("runChunkBackfill", () => {
  it("uses cursor batches, skips synchronized documents, and is resumable", async () => {
    const firstContent = "already synchronized";
    const secondContent = "requires chunks";
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000001",
          content: firstContent,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000002",
          content: secondContent,
        },
      ])
      .mockResolvedValueOnce([]);
    const transactions = [
      transactionFor(chunkText(firstContent)),
      transactionFor([]),
    ];
    const transaction = vi.fn(async (callback) =>
      callback(transactions.shift()),
    );
    const client = {
      document: {
        findMany,
      },
      $transaction: transaction,
    } as unknown as ChunkBackfillClient;

    await expect(
      runChunkBackfill(client, {
        batchSize: 1,
      }),
    ).resolves.toEqual({
      documentsInspected: 2,
      documentsProcessed: 1,
      documentsSkipped: 1,
      documentsFailed: 0,
      chunksCreated: 1,
      chunksRetained: 1,
      chunksDeletedOrReplaced: 0,
    });
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: {
          id: "00000000-0000-4000-8000-000000000001",
        },
        skip: 1,
      }),
    );
  });

  it("continues after one document fails and honors the limit", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000001",
        content: "first",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        content: "second",
      },
    ]);
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("document failure"))
      .mockImplementationOnce(async (callback) =>
        callback(transactionFor([])),
      );
    const onError = vi.fn();

    const summary = await runChunkBackfill(
      {
        document: {
          findMany,
        },
        $transaction: transaction,
      } as unknown as ChunkBackfillClient,
      {
        batchSize: 10,
        limit: 2,
      },
      onError,
    );

    expect(summary.documentsFailed).toBe(1);
    expect(summary.documentsProcessed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
