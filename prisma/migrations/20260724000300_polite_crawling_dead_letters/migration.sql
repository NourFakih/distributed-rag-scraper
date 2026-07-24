-- AddEnumValue
ALTER TYPE "CrawlPageStatus" ADD VALUE 'SKIPPED_ROBOTS';

-- Preserve the final typed failure directly on CrawlPage.
ALTER TABLE "crawl_pages"
ADD COLUMN "failure_category" VARCHAR(64);

-- CreateTable
CREATE TABLE "dead_letters" (
    "id" UUID NOT NULL,
    "crawl_id" UUID NOT NULL,
    "crawl_page_id" UUID NOT NULL,
    "job_id" VARCHAR(255) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "job_payload" TEXT NOT NULL,
    "failure_category" VARCHAR(64) NOT NULL,
    "error_message" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL,
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dead_letters_attempt_count_check" CHECK ("attempt_count" >= 1),
    CONSTRAINT "dead_letters_job_payload_size_check" CHECK (char_length("job_payload") <= 8192),
    CONSTRAINT "dead_letters_error_message_size_check" CHECK (char_length("error_message") <= 2000)
);

-- CreateIndexes
CREATE UNIQUE INDEX "dead_letters_crawl_page_id_key"
ON "dead_letters"("crawl_page_id");

CREATE INDEX "dead_letters_crawl_id_failed_at_idx"
ON "dead_letters"("crawl_id", "failed_at");

-- AddForeignKeys
ALTER TABLE "dead_letters"
ADD CONSTRAINT "dead_letters_crawl_id_fkey"
FOREIGN KEY ("crawl_id") REFERENCES "crawls"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dead_letters"
ADD CONSTRAINT "dead_letters_crawl_page_id_fkey"
FOREIGN KEY ("crawl_page_id") REFERENCES "crawl_pages"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
