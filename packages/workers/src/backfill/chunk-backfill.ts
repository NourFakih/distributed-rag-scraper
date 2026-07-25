import type { PrismaClient } from "@prisma/client";

import { synchronizeDocumentChunks } from "../chunks/synchronize-document-chunks";
import type { BackfillArguments } from "../cli/arguments";

export interface ChunkBackfillSummary {
  documentsInspected: number;
  documentsProcessed: number;
  documentsSkipped: number;
  documentsFailed: number;
  chunksCreated: number;
  chunksRetained: number;
  chunksDeletedOrReplaced: number;
}

export type ChunkBackfillClient = Pick<
  PrismaClient,
  "document" | "$transaction"
>;

export async function runChunkBackfill(
  client: ChunkBackfillClient,
  options: BackfillArguments,
  onDocumentError: (
    documentId: string,
    error: unknown,
  ) => void = (documentId, error) => {
    console.error(`Chunk backfill failed for Document ${documentId}`, error);
  },
): Promise<ChunkBackfillSummary> {
  const summary: ChunkBackfillSummary = {
    documentsInspected: 0,
    documentsProcessed: 0,
    documentsSkipped: 0,
    documentsFailed: 0,
    chunksCreated: 0,
    chunksRetained: 0,
    chunksDeletedOrReplaced: 0,
  };
  let cursor: string | undefined;

  while (
    options.limit === undefined ||
    summary.documentsInspected < options.limit
  ) {
    const remaining =
      options.limit === undefined
        ? options.batchSize
        : Math.min(
            options.batchSize,
            options.limit - summary.documentsInspected,
          );
    const documents = await client.document.findMany({
      take: remaining,
      ...(cursor
        ? {
            cursor: {
              id: cursor,
            },
            skip: 1,
          }
        : {}),
      select: {
        id: true,
        content: true,
      },
      orderBy: {
        id: "asc",
      },
    });
    if (documents.length === 0) {
      break;
    }

    for (const document of documents) {
      cursor = document.id;
      summary.documentsInspected += 1;
      try {
        const synchronized = await client.$transaction((transaction) =>
          synchronizeDocumentChunks(
            transaction,
            document.id,
            document.content,
          ),
        );
        summary.chunksCreated += synchronized.created;
        summary.chunksRetained += synchronized.retained;
        summary.chunksDeletedOrReplaced +=
          synchronized.deletedOrReplaced;
        if (synchronized.synchronized) {
          summary.documentsSkipped += 1;
        } else {
          summary.documentsProcessed += 1;
        }
      } catch (error: unknown) {
        summary.documentsFailed += 1;
        onDocumentError(document.id, error);
      }
    }
  }

  return summary;
}
