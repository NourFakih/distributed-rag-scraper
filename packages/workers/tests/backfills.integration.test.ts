import { randomUUID } from "node:crypto";

import {
  E5_MODEL_ID,
  E5_MODEL_VERSION,
  prisma,
  type EmbeddingProvider,
} from "@distributed-rag/shared";
import { afterAll, describe, expect, it } from "vitest";

import {
  createEmbeddingBackfillRepository,
  runEmbeddingBackfill,
} from "../src/backfill/embedding-backfill";
import {
  runChunkBackfill,
  type ChunkBackfillClient,
} from "../src/backfill/chunk-backfill";

const describeIntegration =
  process.env.RUN_INTEGRATION_TESTS === "true"
    ? describe
    : describe.skip;

function unitVector(): number[] {
  return [1, ...Array.from({ length: 383 }, () => 0)];
}

const provider: EmbeddingProvider = {
  modelId: E5_MODEL_ID,
  modelVersion: E5_MODEL_VERSION,
  dimension: 384,
  embedPassage: async () => unitVector(),
  embedQuery: async () => unitVector(),
  embedPassages: async (contents) =>
    contents.map(() => unitVector()),
};

describeIntegration("existing-data backfills", () => {
  const crawlIds: string[] = [];

  afterAll(async () => {
    await prisma.crawl.deleteMany({
      where: {
        id: {
          in: crawlIds,
        },
      },
    });
  });

  it("creates missing chunks and persists current embedding metadata", async () => {
    const crawlId = randomUUID();
    const documentId = randomUUID();
    crawlIds.push(crawlId);
    const content =
      "Existing document content that predates deterministic chunk rows.";
    await prisma.crawl.create({
      data: {
        id: crawlId,
        seedUrl: "https://example.com/backfill-fixture",
        normalizedOrigin: "https://example.com",
        pages: {
          create: {
            url: "https://example.com/backfill-fixture",
            normalizedUrl: "https://example.com/backfill-fixture",
            depth: 0,
            document: {
              create: {
                id: documentId,
                url: "https://example.com/backfill-fixture",
                title: "Backfill fixture",
                rawHtml: `<main>${content}</main>`,
                content,
                contentHash: "e".repeat(64),
                httpStatus: 200,
                contentType: "text/html",
              },
            },
          },
        },
      },
    });

    const chunkSummary = await runChunkBackfill(
      {
        document: {
          findMany: async () => [
            {
              id: documentId,
              content,
            },
          ],
        },
        $transaction: (callback) => prisma.$transaction(callback),
      } as unknown as ChunkBackfillClient,
      {
        batchSize: 1,
        limit: 1,
      },
    );
    expect(chunkSummary.documentsProcessed).toBe(1);
    expect(chunkSummary.chunksCreated).toBe(1);

    const persistedChunk = await prisma.chunk.findFirstOrThrow({
      where: {
        documentId,
      },
    });
    const realRepository = createEmbeddingBackfillRepository(prisma);
    const embeddingSummary = await runEmbeddingBackfill(
      {
        batchSize: 1,
        limit: 1,
      },
      {
        repository: {
          listChunksAfter: async (cursor) =>
            cursor
              ? []
              : [
                  {
                    id: persistedChunk.id,
                    content: persistedChunk.content,
                    contentHash: persistedChunk.contentHash,
                    embeddingPresent: false,
                    embeddingModel: null,
                    embeddingVersion: null,
                    embeddedContentHash: null,
                  },
                ],
          persistEmbedding: realRepository.persistEmbedding,
        },
        provider,
        retryDelaysMs: [0, 0],
      },
    );
    expect(embeddingSummary.chunksEmbedded).toBe(1);

    const metadata = await prisma.$queryRaw<
      Array<{
        embeddingPresent: boolean;
        embeddingModel: string;
        embeddingVersion: string;
        embeddedContentHash: string;
      }>
    >`
      SELECT
        ("embedding" IS NOT NULL) AS "embeddingPresent",
        "embedding_model" AS "embeddingModel",
        "embedding_version" AS "embeddingVersion",
        "embedded_content_hash" AS "embeddedContentHash"
      FROM "chunks"
      WHERE "id" = ${persistedChunk.id}::uuid
    `;
    expect(metadata[0]).toEqual({
      embeddingPresent: true,
      embeddingModel: provider.modelId,
      embeddingVersion: provider.modelVersion,
      embeddedContentHash: persistedChunk.contentHash,
    });
  });
});
