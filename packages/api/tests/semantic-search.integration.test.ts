import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import {
  E5_MODEL_ID,
  E5_MODEL_VERSION,
  embeddingToSqlVector,
  prisma,
  type EmbeddingProvider,
} from "@distributed-rag/shared";
import { afterAll, describe, expect, it } from "vitest";

import { semanticSearch } from "../src/services/search.service";

const describeIntegration =
  process.env.RUN_INTEGRATION_TESTS === "true"
    ? describe
    : describe.skip;

function vector(first: number, second: number): number[] {
  return [
    first,
    second,
    ...Array.from({ length: 382 }, () => 0),
  ];
}

const provider: EmbeddingProvider = {
  modelId: E5_MODEL_ID,
  modelVersion: E5_MODEL_VERSION,
  dimension: 384,
  embedQuery: async () => vector(1, 0),
  embedPassage: async () => vector(1, 0),
  embedPassages: async (contents) =>
    contents.map(() => vector(1, 0)),
};

describeIntegration("pgvector semantic search", () => {
  const crawlIds: string[] = [];

  afterAll(async () => {
    if (crawlIds.length > 0) {
      await prisma.crawl.deleteMany({
        where: {
          id: {
            in: crawlIds,
          },
        },
      });
    }
  });

  it("enables pgvector, ranks controlled vectors, and excludes stale rows", async () => {
    const extensions = await prisma.$queryRaw<
      Array<{ extversion: string }>
    >`SELECT "extversion" FROM "pg_extension" WHERE "extname" = 'vector'`;
    expect(extensions[0]?.extversion).toMatch(/^0\.8\./u);

    const crawlId = randomUUID();
    const pageId = randomUUID();
    const documentId = randomUUID();
    crawlIds.push(crawlId);
    await prisma.crawl.create({
      data: {
        id: crawlId,
        seedUrl: "https://example.com/vector-fixture",
        normalizedOrigin: "https://example.com",
        pages: {
          create: {
            id: pageId,
            url: "https://example.com/vector-fixture",
            normalizedUrl: "https://example.com/vector-fixture",
            depth: 0,
            document: {
              create: {
                id: documentId,
                url: "https://example.com/vector-fixture",
                title: "Vector fixture",
                rawHtml: "<main>alpha beta stale</main>",
                content: "alpha beta stale",
                contentHash: "f".repeat(64),
                httpStatus: 200,
                contentType: "text/html",
                chunks: {
                  create: [
                    {
                      chunkIndex: 0,
                      content: "alpha",
                      contentHash: "a".repeat(64),
                      startOffset: 0,
                      endOffset: 5,
                    },
                    {
                      chunkIndex: 1,
                      content: "beta",
                      contentHash: "b".repeat(64),
                      startOffset: 6,
                      endOffset: 10,
                    },
                    {
                      chunkIndex: 2,
                      content: "stale",
                      contentHash: "c".repeat(64),
                      startOffset: 11,
                      endOffset: 16,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      include: {
        pages: {
          include: {
            document: {
              include: {
                chunks: {
                  orderBy: {
                    chunkIndex: "asc",
                  },
                },
              },
            },
          },
        },
      },
    });
    const chunks = await prisma.chunk.findMany({
      where: {
        documentId,
      },
      orderBy: {
        chunkIndex: "asc",
      },
    });

    const fixtures = [
      {
        chunk: chunks[0]!,
        embedding: vector(1, 0),
        embeddedHash: chunks[0]!.contentHash,
      },
      {
        chunk: chunks[1]!,
        embedding: vector(0.8, 0.6),
        embeddedHash: chunks[1]!.contentHash,
      },
      {
        chunk: chunks[2]!,
        embedding: vector(1, 0),
        embeddedHash: "d".repeat(64),
      },
    ];
    for (const fixture of fixtures) {
      await prisma.$executeRaw(
        Prisma.sql`
          UPDATE "chunks"
          SET
            "embedding" = ${embeddingToSqlVector(fixture.embedding)}::vector,
            "embedding_model" = ${provider.modelId},
            "embedding_version" = ${provider.modelVersion},
            "embedded_content_hash" = ${fixture.embeddedHash},
            "embedded_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${fixture.chunk.id}::uuid
        `,
      );
    }

    const response = await semanticSearch(
      "alpha",
      10,
      provider,
      prisma,
    );

    expect(response.results.map((result) => result.chunkIndex)).toEqual([
      0,
      1,
    ]);
    expect(response.results[0]?.similarity).toBeCloseTo(1);
    expect(response.results[1]?.similarity).toBeCloseTo(0.8);
    expect(response.results).toHaveLength(2);
  });
});
