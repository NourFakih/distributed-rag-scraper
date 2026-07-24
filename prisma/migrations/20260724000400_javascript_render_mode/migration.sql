-- CreateEnum
CREATE TYPE "RenderMode" AS ENUM ('STATIC', 'JAVASCRIPT');

-- Existing Crawl rows retain the current static behavior.
ALTER TABLE "crawls"
ADD COLUMN "render_mode" "RenderMode" NOT NULL DEFAULT 'STATIC';
