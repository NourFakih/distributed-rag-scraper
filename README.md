# Distributed RAG Scraper

This repository contains the first verified vertical slice of the distributed
RAG scraper assignment:

```text
POST /api/crawls
  -> PostgreSQL Crawl row
  -> Redis/BullMQ job
  -> independent worker
  -> Axios + Cheerio static-page extraction
  -> normalized content + SHA-256
  -> PostgreSQL Document row
  -> GET crawl/document APIs
```

The implementation is intentionally limited to one static HTML page per crawl.
React, Playwright, recursive crawling, robots enforcement, pgvector, embeddings,
RAG, and the 500-page experiment are later phases.

## Stack

- Node.js 24 LTS, TypeScript, npm workspaces, and Turborepo
- Express API
- BullMQ and Redis
- PostgreSQL and Prisma 6.19.3
- Axios and Cheerio
- Vitest and Supertest
- Docker Compose in GitHub Codespaces
- GitHub Actions for quality checks and separate image builds

## Run in GitHub Codespaces

1. Open the repository in a new Codespace. The devcontainer installs npm
   dependencies and generates Prisma Client.
2. Start the complete stack:

   ```bash
   docker compose up --build
   ```

3. In a second terminal, submit a safe static page:

   ```bash
   curl -i \
     -H "Content-Type: application/json" \
     -d '{"url":"https://example.com/"}' \
     http://localhost:3000/api/crawls
   ```

4. Copy the returned Crawl UUID and inspect it:

   ```bash
   curl http://localhost:3000/api/crawls/COPY_CRAWL_ID_HERE
   ```

5. After the status becomes `COMPLETED`, copy `documentId`:

   ```bash
   curl http://localhost:3000/api/documents/COPY_DOCUMENT_ID_HERE
   ```

Stop the stack with `docker compose down`. Named PostgreSQL and Redis volumes
preserve data between restarts.

## Develop without local Docker

Local Docker is not required. Run all infrastructure and the live demonstration
inside Codespaces. Pure unit/API tests can run anywhere with Node 24:

```bash
npm ci
npm run prisma:generate
npm run lint
npm run build
npm test
```

The real PostgreSQL/Redis pipeline test is enabled when its service URLs exist:

```bash
RUN_INTEGRATION_TESTS=true npm test
```

GitHub Actions supplies deterministic PostgreSQL and Redis service containers.
The scraper tests never access an external website: they use the committed
fixture at `packages/workers/tests/fixtures/static-page.html`.

## API contract

### `POST /api/crawls`

Strict JSON body:

```json
{
  "url": "https://example.com/page"
}
```

The URL must be absolute HTTP/HTTPS, may not contain credentials, and is limited
to 2,048 characters. URL fragments are removed. The endpoint returns
`202 Accepted` after the Crawl row and BullMQ job exist. If queueing fails, it
marks the Crawl `FAILED` and returns `503`.

### `GET /api/crawls/:id`

Returns URL, status, attempts, a bounded error, related `documentId`, and all
Crawl timestamps. Invalid UUIDs return `422`; unknown UUIDs return `404`.

### `GET /api/documents/:id`

Returns source URL, title, raw HTML, normalized content, lowercase SHA-256,
HTTP metadata, and timestamps. Invalid UUIDs return `422`; unknown UUIDs return
`404`.

## Worker guarantees

- The API and worker are separate deployable processes and containers.
- Each job uses the Crawl UUID as `jobId`.
- A job gets three attempts with exponential backoff starting at one second.
- Crawl state changes through `QUEUED`, `PROCESSING`, optionally `RETRYING`,
  and then `COMPLETED` or `FAILED`.
- A unique `crawlId` on Document plus an upsert makes redelivery idempotent.
- Document persistence and Crawl completion occur in one database transaction.
- Terminally failed BullMQ jobs remain inspectable.

Static fetching has a 15-second timeout, five-redirect limit, 2 MiB limit, and
requires a successful HTML/XHTML response. Cleaning removes executable,
navigation, page-chrome, and embedded-media elements; it prefers `main`, then
`article`, then `body`.

## Security boundary

This first slice is for a private Codespaces demonstration. URL validation does
not yet include DNS resolution, redirect-by-redirect address checks, or private
network blocking, so the API must not be publicly exposed. Complete SSRF
protection, robots.txt enforcement, per-domain throttling, and terms-of-service
adapters belong to the compliance/crawler phase.

## Repository layout

```text
packages/
  api/       Express routes, validation, services, and API tests
  shared/    Prisma singleton, lazy Redis queue, and job contracts
  workers/   static scraper, cleaner, hasher, worker, and pipeline tests
prisma/      schema and committed migration
.devcontainer/
.github/workflows/
docker-compose.yml
```

The original assignment is preserved unchanged in `rag_assignment.txt`.

