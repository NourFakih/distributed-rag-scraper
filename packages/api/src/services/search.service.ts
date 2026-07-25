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

import type { SearchMode } from "../schemas/search.schemas";

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

export interface KeywordSearchResult {
  chunkId: string;
  documentId: string;
  url: string;
  title: string | null;
  chunkIndex: number;
  excerpt: string;
  relevance: number;
}

export interface KeywordSearchResponse {
  query: string;
  resultCount: number;
  results: KeywordSearchResult[];
}

export type SearchResponse =
  | (SemanticSearchResponse & { mode: "semantic" })
  | (KeywordSearchResponse & { mode: "keyword" });

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

export async function keywordSearch(
  query: string,
  limit: number,
  client: Pick<PrismaClient, "$queryRaw"> = prisma,
): Promise<KeywordSearchResponse> {
  const rows = await client.$queryRaw<KeywordSearchResult[]>(
    Prisma.sql`
      WITH search_query AS (
        SELECT plainto_tsquery('simple', ${query}) AS value
      ),
      searchable_chunks AS (
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
            setweight(
              to_tsvector('simple', COALESCE(document."title", '')),
              'A'
            ) ||
            setweight(to_tsvector('simple', chunk."content"), 'B') ||
            setweight(to_tsvector('simple', document."url"), 'C')
          ) AS search_vector
        FROM "chunks" AS chunk
        INNER JOIN "documents" AS document
          ON document."id" = chunk."document_id"
      )
      SELECT
        searchable_chunks."chunkId",
        searchable_chunks."documentId",
        searchable_chunks."url",
        searchable_chunks."title",
        searchable_chunks."chunkIndex",
        searchable_chunks."excerpt",
        ts_rank_cd(
          searchable_chunks.search_vector,
          search_query.value
        )::double precision AS "relevance"
      FROM searchable_chunks
      CROSS JOIN search_query
      WHERE searchable_chunks.search_vector @@ search_query.value
      ORDER BY "relevance" DESC, searchable_chunks."chunkId" ASC
      LIMIT ${limit}
    `,
  );

  return {
    query,
    resultCount: rows.length,
    results: rows,
  };
}

export async function searchDocuments(
  query: string,
  limit: number,
  mode: SearchMode = "semantic",
): Promise<SearchResponse> {
  if (mode === "keyword") {
    return {
      ...(await keywordSearch(query, limit)),
      mode,
    };
  }

  return {
    ...(await semanticSearch(query, limit)),
    mode,
  };
}
