import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { synchronizeDocumentChunks } from "../src/chunks/synchronize-document-chunks";
import { chunkText } from "../src/processing/chunk-text";

function transactionWith(
  persisted: ReturnType<typeof chunkText>,
): {
  transaction: Prisma.TransactionClient;
  deleteMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
} {
  const deleteMany = vi.fn(async () => ({
    count: persisted.length,
  }));
  const createMany = vi.fn(async () => ({
    count: 1,
  }));
  return {
    transaction: {
      chunk: {
        findMany: vi.fn(async () => persisted),
        deleteMany,
        createMany,
      },
    } as unknown as Prisma.TransactionClient,
    deleteMany,
    createMany,
  };
}

describe("synchronizeDocumentChunks", () => {
  it("retains synchronized chunks idempotently", async () => {
    const content = "Already synchronized content";
    const persisted = chunkText(content);
    const { transaction, deleteMany, createMany } =
      transactionWith(persisted);

    await expect(
      synchronizeDocumentChunks(transaction, "document-id", content),
    ).resolves.toEqual({
      synchronized: true,
      created: 0,
      retained: 1,
      deletedOrReplaced: 0,
    });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("replaces stale chunks and reports counts", async () => {
    const { transaction, deleteMany, createMany } = transactionWith(
      chunkText("stale"),
    );

    await expect(
      synchronizeDocumentChunks(
        transaction,
        "document-id",
        "replacement",
      ),
    ).resolves.toEqual({
      synchronized: false,
      created: 1,
      retained: 0,
      deletedOrReplaced: 1,
    });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
  });
});
