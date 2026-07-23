-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('QUEUED', 'PROCESSING', 'RETRYING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "crawls" (
    "id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "status" "CrawlStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crawls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "crawl_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "title" TEXT,
    "raw_html" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "http_status" INTEGER NOT NULL,
    "content_type" VARCHAR(255),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crawls_status_idx" ON "crawls"("status");

-- CreateIndex
CREATE UNIQUE INDEX "documents_crawl_id_key" ON "documents"("crawl_id");

-- CreateIndex
CREATE INDEX "documents_content_hash_idx" ON "documents"("content_hash");

-- AddForeignKey
ALTER TABLE "documents"
ADD CONSTRAINT "documents_crawl_id_fkey"
FOREIGN KEY ("crawl_id") REFERENCES "crawls"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

