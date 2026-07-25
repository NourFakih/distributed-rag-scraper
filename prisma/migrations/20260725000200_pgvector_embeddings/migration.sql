CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "chunks"
  ADD COLUMN "embedding" vector(384),
  ADD COLUMN "embedding_model" VARCHAR(255),
  ADD COLUMN "embedding_version" VARCHAR(255),
  ADD COLUMN "embedded_content_hash" CHAR(64),
  ADD COLUMN "embedded_at" TIMESTAMP(3);

ALTER TABLE "chunks"
  ADD CONSTRAINT "chunks_embedding_metadata_consistency_check"
  CHECK (
    (
      "embedding" IS NULL
      AND "embedding_model" IS NULL
      AND "embedding_version" IS NULL
      AND "embedded_content_hash" IS NULL
      AND "embedded_at" IS NULL
    )
    OR
    (
      "embedding" IS NOT NULL
      AND "embedding_model" IS NOT NULL
      AND "embedding_version" IS NOT NULL
      AND "embedded_content_hash" IS NOT NULL
      AND "embedded_at" IS NOT NULL
    )
  );

CREATE INDEX "chunks_embedding_cosine_hnsw_idx"
  ON "chunks"
  USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;
