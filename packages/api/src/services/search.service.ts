import { Prisma, type PrismaClient } from "@prisma/client";
import {
  E5_EMBEDDING_DIMENSION,
  EmbeddingConfigurationError,
  embeddingToSqlVector,
  getEmbeddingProvider,
  normalizeEmbedding,
  prisma,
  type EmbeddingProvider,
} from "@distributed-rag/shared";

export const SEARCH_EXCERPT_LENGTH = 500;

export interface SemanticSearchResult {
  chunkId: string;
  documentId: string;
  url: string;
  title: string | null;
  chunkIndex: number;
  excerpt: string;
  similarity: number;
}

export interface SemanticSearchResponse {
  query: string;
  activeEmbeddingModel: {
    id: string;
    version: string;
    dimension: number;
  };
  resultCount: number;
  results: SemanticSearchResult[];
}

export async function semanticSearch(
  query: string,
  limit: number,
  provider: EmbeddingProvider = getEmbeddingProvider(),
  client: Pick<PrismaClient, "$queryRaw"> = prisma,
): Promise<SemanticSearchResponse> {
  if (provider.dimension !== E5_EMBEDDING_DIMENSION) {
    throw new EmbeddingConfigurationError(
      `Active provider dimension ${provider.dimension} does not match database vector dimension ${E5_EMBEDDING_DIMENSION}`,
    );
  }
  const queryVector = embeddingToSqlVector(
    normalizeEmbedding(
      await provider.embedQuery(query),
      E5_EMBEDDING_DIMENSION,
    ),
  );
  const rows = await client.$queryRaw<SemanticSearchResult[]>(
    Prisma.sql`
      SELECT
        chunk."id" AS "chunkId",
        chunk."document_id" AS "documentId",
        document."url",
        document."title",
        chunk."chunk_index" AS "chunkIndex",
        LEFT(
          chunk."content",
          CAST(${SEARCH_EXCERPT_LENGTH} AS integer)
        ) AS "excerpt",
        (
          1 - (
            chunk."embedding" <=>
            ${queryVector}::vector
          )
        )::double precision AS "similarity"
      FROM "chunks" AS chunk
      INNER JOIN "documents" AS document
        ON document."id" = chunk."document_id"
      WHERE chunk."embedding" IS NOT NULL
        AND chunk."embedding_model" = ${provider.modelId}
        AND chunk."embedding_version" = ${provider.modelVersion}
        AND chunk."embedded_content_hash" = chunk."content_hash"
      ORDER BY
        chunk."embedding" <=> ${queryVector}::vector ASC,
        chunk."id" ASC
      LIMIT ${limit}
    `,
  );

  return {
    query,
    activeEmbeddingModel: {
      id: provider.modelId,
      version: provider.modelVersion,
      dimension: provider.dimension,
    },
    resultCount: rows.length,
    results: rows,
  };
}
