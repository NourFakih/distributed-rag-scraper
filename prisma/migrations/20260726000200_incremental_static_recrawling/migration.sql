-- AlterTable
ALTER TABLE "crawl_pages"
ADD COLUMN "not_modified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "reused_document_id" UUID;

-- AlterTable
ALTER TABLE "documents"
ADD COLUMN "etag" TEXT,
ADD COLUMN "last_modified" TEXT,
ADD COLUMN "previous_version_id" UUID;

-- CreateIndexes
CREATE INDEX "crawl_pages_reused_document_id_idx"
ON "crawl_pages"("reused_document_id");

CREATE INDEX "documents_previous_version_id_idx"
ON "documents"("previous_version_id");

-- AddForeignKeys
ALTER TABLE "crawl_pages"
ADD CONSTRAINT "crawl_pages_reused_document_id_fkey"
FOREIGN KEY ("reused_document_id") REFERENCES "documents"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "documents"
ADD CONSTRAINT "documents_previous_version_id_fkey"
FOREIGN KEY ("previous_version_id") REFERENCES "documents"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
