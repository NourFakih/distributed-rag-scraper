import { Prisma, type PrismaClient } from "@prisma/client";
import {
  E5_EMBEDDING_DIMENSION,
  EmbeddingConfigurationError,
  embeddingToSqlVector,
  normalizeEmbedding,
  type EmbeddingProvider,
} from "@distributed-rag/shared";

import type { BackfillArguments } from "../cli/arguments";

export const EMBEDDING_RETRY_ATTEMPTS = 3;

export interface EmbeddingBackfillChunk {
  id: string;
  content: string;
  contentHash: string;
  embeddingPresent: boolean;
  embeddingModel: string | null;
  embeddingVersion: string | null;
  embeddedContentHash: string | null;
}

export interface EmbeddingBackfillSummary {
  chunksInspected: number;
  chunksEmbedded: number;
  chunksSkipped: number;
  chunksFailed: number;
  batchesCompleted: number;
  elapsedMs: number;
}

export interface EmbeddingBackfillRepository {
  listChunksAfter(
    cursor: string | undefined,
    take: number,
  ): Promise<EmbeddingBackfillChunk[]>;
  persistEmbedding(
    chunk: EmbeddingBackfillChunk,
    vector: readonly number[],
    provider: EmbeddingProvider,
  ): Promise<boolean>;
}

export function createEmbeddingBackfillRepository(
  client: PrismaClient,
): EmbeddingBackfillRepository {
  return {
    listChunksAfter: async (cursor, take) =>
      client.$queryRaw<EmbeddingBackfillChunk[]>(
        Prisma.sql`
          SELECT
            "id",
            "content",
            "content_hash" AS "contentHash",
            ("embedding" IS NOT NULL) AS "embeddingPresent",
            "embedding_model" AS "embeddingModel",
            "embedding_version" AS "embeddingVersion",
            "embedded_content_hash" AS "embeddedContentHash"
          FROM "chunks"
          WHERE (
            ${cursor ?? null}::uuid IS NULL
            OR "id" > ${cursor ?? null}::uuid
          )
          ORDER BY "id" ASC
          LIMIT ${take}
        `,
      ),
    persistEmbedding: async (chunk, vector, provider) => {
      if (provider.dimension !== E5_EMBEDDING_DIMENSION) {
        throw new EmbeddingConfigurationError(
          `Active provider dimension ${provider.dimension} does not match database vector dimension ${E5_EMBEDDING_DIMENSION}`,
        );
      }
      const storageVector = normalizeEmbedding(
        vector,
        E5_EMBEDDING_DIMENSION,
      );
      const updated = await client.$executeRaw(
        Prisma.sql`
          UPDATE "chunks"
          SET
            "embedding" = ${embeddingToSqlVector(storageVector)}::vector,
            "embedding_model" = ${provider.modelId},
            "embedding_version" = ${provider.modelVersion},
            "embedded_content_hash" = ${chunk.contentHash},
            "embedded_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${chunk.id}::uuid
            AND "content_hash" = ${chunk.contentHash}
        `,
      );
      return updated === 1;
    },
  };
}

export function needsEmbedding(
  chunk: EmbeddingBackfillChunk,
  provider: EmbeddingProvider,
): boolean {
  return (
    !chunk.embeddingPresent ||
    chunk.embeddingModel !== provider.modelId ||
    chunk.embeddingVersion !== provider.modelVersion ||
    chunk.embeddedContentHash !== chunk.contentHash
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function retry<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < EMBEDDING_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      const delay = delaysMs[attempt];
      if (
        attempt + 1 < EMBEDDING_RETRY_ATTEMPTS &&
        delay !== undefined &&
        delay > 0
      ) {
        await wait(delay);
      }
    }
  }
  throw lastError;
}

export interface EmbeddingBackfillDependencies {
  repository: EmbeddingBackfillRepository;
  provider: EmbeddingProvider;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  onChunkError?: (chunkId: string, error: unknown) => void;
}

export async function runEmbeddingBackfill(
  options: BackfillArguments,
  dependencies: EmbeddingBackfillDependencies,
): Promise<EmbeddingBackfillSummary> {
  const startedAt = (dependencies.now ?? Date.now)();
  const summary: EmbeddingBackfillSummary = {
    chunksInspected: 0,
    chunksEmbedded: 0,
    chunksSkipped: 0,
    chunksFailed: 0,
    batchesCompleted: 0,
    elapsedMs: 0,
  };
  const delays = dependencies.retryDelaysMs ?? [250, 500];
  let cursor: string | undefined;

  while (
    options.limit === undefined ||
    summary.chunksInspected < options.limit
  ) {
    const remaining =
      options.limit === undefined
        ? options.batchSize
        : Math.min(
            options.batchSize,
            options.limit - summary.chunksInspected,
          );
    const chunks = await dependencies.repository.listChunksAfter(
      cursor,
      remaining,
    );
    if (chunks.length === 0) {
      break;
    }
    cursor = chunks.at(-1)?.id;
    summary.chunksInspected += chunks.length;

    const staleChunks = chunks.filter((chunk) =>
      needsEmbedding(chunk, dependencies.provider),
    );
    summary.chunksSkipped += chunks.length - staleChunks.length;
    if (staleChunks.length === 0) {
      continue;
    }

    let vectors: Array<number[] | undefined>;
    try {
      const batchVectors = await retry(
        () =>
          dependencies.provider.embedPassages(
            staleChunks.map((chunk) => chunk.content),
          ),
        delays,
      );
      if (batchVectors.length !== staleChunks.length) {
        throw new Error(
          `Embedding provider returned ${batchVectors.length} vectors for ${staleChunks.length} chunks`,
        );
      }
      vectors = batchVectors;
    } catch (batchError: unknown) {
      vectors = [];
      for (const [index, chunk] of staleChunks.entries()) {
        try {
          vectors[index] = await retry(
            () => dependencies.provider.embedPassage(chunk.content),
            delays,
          );
        } catch (error: unknown) {
          summary.chunksFailed += 1;
          (dependencies.onChunkError ??
            ((chunkId, chunkError) => {
              console.error(
                `Embedding backfill failed for Chunk ${chunkId}`,
                chunkError,
              );
            }))(chunk.id, error ?? batchError);
        }
      }
    }
    summary.batchesCompleted += 1;

    for (const [index, chunk] of staleChunks.entries()) {
      const vector = vectors[index];
      if (!vector) {
        continue;
      }
      try {
        const persisted =
          await dependencies.repository.persistEmbedding(
            chunk,
            vector,
            dependencies.provider,
          );
        if (persisted) {
          summary.chunksEmbedded += 1;
        } else {
          summary.chunksSkipped += 1;
        }
      } catch (error: unknown) {
        summary.chunksFailed += 1;
        (dependencies.onChunkError ??
          ((chunkId, chunkError) => {
            console.error(
              `Embedding persistence failed for Chunk ${chunkId}`,
              chunkError,
            );
          }))(chunk.id, error);
      }
    }
  }

  summary.elapsedMs = (dependencies.now ?? Date.now)() - startedAt;
  return summary;
}
