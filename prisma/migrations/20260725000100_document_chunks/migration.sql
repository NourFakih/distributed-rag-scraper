-- CreateTable
CREATE TABLE "chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chunks_chunk_index_check" CHECK ("chunk_index" >= 0),
    CONSTRAINT "chunks_start_offset_check" CHECK ("start_offset" >= 0),
    CONSTRAINT "chunks_offset_order_check" CHECK ("end_offset" > "start_offset"),
    CONSTRAINT "chunks_content_not_empty_check" CHECK (char_length("content") > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "chunks_document_id_chunk_index_key"
ON "chunks"("document_id", "chunk_index");

-- AddForeignKey
ALTER TABLE "chunks"
ADD CONSTRAINT "chunks_document_id_fkey"
FOREIGN KEY ("document_id") REFERENCES "documents"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
