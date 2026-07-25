import type { Prisma } from "@prisma/client";

import {
  chunkText,
  type DocumentChunk,
} from "../processing/chunk-text";

export interface ChunkSynchronizationSummary {
  synchronized: boolean;
  created: number;
  retained: number;
  deletedOrReplaced: number;
}

type PersistedChunk = Pick<
  DocumentChunk,
  | "chunkIndex"
  | "content"
  | "contentHash"
  | "startOffset"
  | "endOffset"
>;

function chunksMatch(
  persistedChunks: PersistedChunk[],
  expectedChunks: DocumentChunk[],
): boolean {
  return (
    persistedChunks.length === expectedChunks.length &&
    persistedChunks.every((persisted, index) => {
      const expected = expectedChunks[index];
      return (
        expected !== undefined &&
        persisted.chunkIndex === expected.chunkIndex &&
        persisted.content === expected.content &&
        persisted.contentHash === expected.contentHash &&
        persisted.startOffset === expected.startOffset &&
        persisted.endOffset === expected.endOffset
      );
    })
  );
}

export async function synchronizeDocumentChunks(
  transaction: Prisma.TransactionClient,
  documentId: string,
  content: string,
): Promise<ChunkSynchronizationSummary> {
  const expectedChunks = chunkText(content);
  const persistedChunks = await transaction.chunk.findMany({
    where: {
      documentId,
    },
    select: {
      chunkIndex: true,
      content: true,
      contentHash: true,
      startOffset: true,
      endOffset: true,
    },
    orderBy: {
      chunkIndex: "asc",
    },
  });

  if (chunksMatch(persistedChunks, expectedChunks)) {
    return {
      synchronized: true,
      created: 0,
      retained: persistedChunks.length,
      deletedOrReplaced: 0,
    };
  }

  const deleted = await transaction.chunk.deleteMany({
    where: {
      documentId,
    },
  });
  if (expectedChunks.length > 0) {
    await transaction.chunk.createMany({
      data: expectedChunks.map((chunk) => ({
        documentId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentHash: chunk.contentHash,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      })),
    });
  }

  return {
    synchronized: false,
    created: expectedChunks.length,
    retained: 0,
    deletedOrReplaced: deleted.count,
  };
}
