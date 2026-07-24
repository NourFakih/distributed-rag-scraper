-- CreateEnum
CREATE TYPE "CrawlPageStatus" AS ENUM (
    'DISCOVERED',
    'QUEUED',
    'PROCESSING',
    'RETRYING',
    'COMPLETED',
    'SKIPPED',
    'FAILED'
);

-- Add the run-level crawl fields as nullable where backfill is required.
ALTER TABLE "crawls"
ADD COLUMN "seed_url" VARCHAR(2048),
ADD COLUMN "normalized_origin" VARCHAR(2048),
ADD COLUMN "max_pages" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN "max_depth" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "discovered_count" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "completed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "skipped_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failed_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "crawls"
SET
    "seed_url" = "url",
    "normalized_origin" = substring("url" from '^[a-z]+://[^/]+');

ALTER TABLE "crawls"
ALTER COLUMN "seed_url" SET NOT NULL,
ALTER COLUMN "normalized_origin" SET NOT NULL;

-- CreateTable
CREATE TABLE "crawl_pages" (
    "id" UUID NOT NULL,
    "crawl_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "normalized_url" VARCHAR(2048) NOT NULL,
    "depth" INTEGER NOT NULL,
    "parent_page_id" UUID,
    "status" "CrawlPageStatus" NOT NULL DEFAULT 'DISCOVERED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "crawl_pages_pkey" PRIMARY KEY ("id")
);

-- Backfill one root page per existing single-page Crawl. Reusing the Crawl UUID
-- avoids requiring a database UUID extension and makes the Document backfill exact.
INSERT INTO "crawl_pages" (
    "id",
    "crawl_id",
    "url",
    "normalized_url",
    "depth",
    "status",
    "attempts",
    "error",
    "created_at",
    "started_at",
    "completed_at"
)
SELECT
    "id",
    "id",
    "url",
    "url",
    0,
    CASE "status"
        WHEN 'QUEUED' THEN 'QUEUED'::"CrawlPageStatus"
        WHEN 'PROCESSING' THEN 'PROCESSING'::"CrawlPageStatus"
        WHEN 'RETRYING' THEN 'RETRYING'::"CrawlPageStatus"
        WHEN 'COMPLETED' THEN 'COMPLETED'::"CrawlPageStatus"
        WHEN 'FAILED' THEN 'FAILED'::"CrawlPageStatus"
    END,
    "attempts",
    "error_message",
    "created_at",
    "started_at",
    "completed_at"
FROM "crawls";

UPDATE "crawls"
SET
    "discovered_count" = 1,
    "completed_count" = CASE WHEN "status" = 'COMPLETED' THEN 1 ELSE 0 END,
    "failed_count" = CASE WHEN "status" = 'FAILED' THEN 1 ELSE 0 END;

-- CreateIndexes
CREATE UNIQUE INDEX "crawl_pages_crawl_id_normalized_url_key"
ON "crawl_pages"("crawl_id", "normalized_url");

CREATE INDEX "crawl_pages_crawl_id_status_idx"
ON "crawl_pages"("crawl_id", "status");

CREATE INDEX "crawl_pages_parent_page_id_idx"
ON "crawl_pages"("parent_page_id");

-- AddForeignKeys
ALTER TABLE "crawl_pages"
ADD CONSTRAINT "crawl_pages_crawl_id_fkey"
FOREIGN KEY ("crawl_id") REFERENCES "crawls"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crawl_pages"
ADD CONSTRAINT "crawl_pages_parent_page_id_fkey"
FOREIGN KEY ("parent_page_id") REFERENCES "crawl_pages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Move each Document from the Crawl relation to its backfilled root CrawlPage.
ALTER TABLE "documents"
ADD COLUMN "crawl_page_id" UUID;

UPDATE "documents"
SET "crawl_page_id" = "crawl_id";

ALTER TABLE "documents"
ALTER COLUMN "crawl_page_id" SET NOT NULL;

ALTER TABLE "documents"
DROP CONSTRAINT "documents_crawl_id_fkey";

DROP INDEX "documents_crawl_id_key";

ALTER TABLE "documents"
DROP COLUMN "crawl_id";

CREATE UNIQUE INDEX "documents_crawl_page_id_key"
ON "documents"("crawl_page_id");

ALTER TABLE "documents"
ADD CONSTRAINT "documents_crawl_page_id_fkey"
FOREIGN KEY ("crawl_page_id") REFERENCES "crawl_pages"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Remove the old single-page Crawl fields after their values have been copied.
ALTER TABLE "crawls"
DROP COLUMN "url",
DROP COLUMN "attempts",
DROP COLUMN "error_message",
DROP COLUMN "started_at";

-- Database-level bounds complement API validation.
ALTER TABLE "crawls"
ADD CONSTRAINT "crawls_max_pages_check"
CHECK ("max_pages" BETWEEN 1 AND 500),
ADD CONSTRAINT "crawls_max_depth_check"
CHECK ("max_depth" BETWEEN 0 AND 10),
ADD CONSTRAINT "crawls_counters_check"
CHECK (
    "discovered_count" >= 0
    AND "completed_count" >= 0
    AND "skipped_count" >= 0
    AND "failed_count" >= 0
    AND "discovered_count" <= "max_pages"
);

ALTER TABLE "crawl_pages"
ADD CONSTRAINT "crawl_pages_depth_check"
CHECK ("depth" BETWEEN 0 AND 10),
ADD CONSTRAINT "crawl_pages_attempts_check"
CHECK ("attempts" >= 0);
