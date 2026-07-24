# Distributed RAG Scraper

This repository contains the bounded, polite, fault-tolerant static-crawling
slice of the distributed RAG scraper assignment:

```text
POST /api/crawls
  -> PostgreSQL Crawl + root CrawlPage
  -> Redis/BullMQ CrawlPage job
  -> independent worker
  -> cached robots.txt policy
  -> global Redis request-start limiter
  -> DNS/IP and redirect validation
  -> Axios + Cheerio static-page extraction
  -> same-origin link discovery
  -> bounded child CrawlPage jobs
  -> normalized content + SHA-256
  -> one PostgreSQL Document per CrawlPage
  -> aggregate crawl/page/document/dead-letter APIs
```

Each run defaults to at most 25 pages and depth 2. React, Playwright, pgvector,
embeddings, RAG, performance experiments, and the 500-page crawl remain later
phases.

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
     -d '{"url":"https://example.com/","maxPages":5,"maxDepth":1}' \
     http://localhost:3000/api/crawls
   ```

4. Copy the returned Crawl UUID and inspect it:

   ```bash
   curl http://localhost:3000/api/crawls/COPY_CRAWL_ID_HERE
   ```

5. Inspect every page in the bounded run:

   ```bash
   curl "http://localhost:3000/api/crawls/COPY_CRAWL_ID_HERE/pages?page=1&pageSize=25"
   ```

6. After the status becomes `COMPLETED`, copy a `documentId`:

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
NODE_ENV=test \
CRAWLER_ALLOW_PRIVATE_TEST_TARGETS=true \
RUN_INTEGRATION_TESTS=true \
npm test
```

GitHub Actions supplies deterministic PostgreSQL and Redis service containers.
The test-only private-target switch is rejected outside `NODE_ENV=test`.
Crawler tests never access a public website: they use committed or local HTTP
fixtures.

## API contract

### `POST /api/crawls`

Strict JSON body:

```json
{
  "url": "https://example.com/docs/",
  "maxPages": 25,
  "maxDepth": 2
}
```

The URL must be absolute HTTP/HTTPS, may not contain credentials, and is limited
to 2,048 characters. URL fragments are removed and common downloadable
extensions are rejected. `maxPages` accepts 1–500 and `maxDepth` accepts 0–10;
omitting both preserves the basic request and applies defaults of 25 and 2. The
endpoint returns `202 Accepted` after the Crawl, root CrawlPage, and BullMQ job
exist. If root queueing fails, it marks the run failed and returns `503`.

### `GET /api/crawls/:id`

Returns the aggregate run status, limits, counters, root page/document
information, timestamps, and whether completion included child-page failures.
Invalid UUIDs return `422`; unknown UUIDs return `404`.

### `GET /api/crawls/:id/pages`

Returns CrawlPage metadata without raw HTML. `page` defaults to 1 and `pageSize`
defaults to 25 with a maximum of 100. Each result includes depth, parent,
status, attempts, bounded error, timestamps, and optional `documentId`.

### `GET /api/crawls/:id/dead-letters`

Returns terminal technical failures for one Crawl with the original bounded job
payload, failure category, bounded error message, attempt count, and failure
time. It uses the same `page` and `pageSize` pagination as the page list.
Robots exclusions do not create dead letters.

### `GET /api/dead-letters/:id`

Returns one inspectable dead letter. Replay is intentionally not part of this
stage.

### `GET /api/documents/:id`

Returns the owning Crawl/CrawlPage IDs, source URL, title, raw HTML, normalized
content, lowercase SHA-256, HTTP metadata, and timestamps. Invalid UUIDs return
`422`; unknown UUIDs return `404`.

## Worker guarantees

- The API and worker are separate deployable processes and containers.
- Each job operates on a CrawlPage UUID and uses that UUID as `jobId`.
- A job gets three attempts. Retryable HTTP, network, rate-limiter, and robots
  failures honor a valid `Retry-After` value, then use bounded exponential
  backoff.
- Page state changes through `DISCOVERED`, `QUEUED`, `PROCESSING`, optionally
  `RETRYING`, and then a terminal state. Robots exclusions use
  `SKIPPED_ROBOTS`.
- A unique `crawlPageId` on Document plus an upsert makes redelivery idempotent.
- A unique `crawlPageId` on DeadLetter plus an upsert makes terminal-failure
  redelivery idempotent.
- The unique `(crawlId, normalizedUrl)` database key prevents duplicate pages.
- Discovery locks the Crawl row while checking remaining capacity, so
  concurrent workers cannot exceed `maxPages`.
- The aggregate Crawl becomes `COMPLETED` only after no page remains active,
  and its counters distinguish policy skips from technical failures.
- Terminally failed BullMQ jobs remain inspectable.

Before each page fetch, workers share a per-origin robots policy cached in Redis
for at most 24 hours. A 2xx robots response is enforced, 4xx means allow, and
5xx/network failures fail closed and retry. The configured user agent is used
for both robots matching and page requests. Robots `Crawl-delay` can only
increase the global delay.

The global Redis limiter atomically spaces request starts by hostname and
effective port across all workers. `CRAWLER_DEFAULT_INTERVAL_MS` defaults to
1000 and must be an integer from 1 through 60000. Robots fetches, page fetches,
and every redirect hop use the limiter.

Static fetching has a 15-second timeout, a five-redirect limit, and a 2 MiB
limit, and requires a successful HTML/XHTML response. Redirects are manual:
every hop remains on the exact seed origin, passes DNS/IP validation, observes
robots policy, and is rate-limited. Cleaning removes executable, navigation,
page-chrome, and embedded-media elements; it prefers `main`, then `article`,
then `body`. Link extraction uses the raw HTML and final response URL, honors
valid same-origin `<base>` values and `nofollow`, and excludes external,
non-HTTP, malformed, empty, duplicate, and downloadable links.

## Security boundary

This remains a private Codespaces demonstration rather than a public crawling
service. The worker resolves DNS before each hop, rejects private, loopback,
link-local, multicast, documentation, and other non-public targets, pins the
validated addresses into the request, disables proxy discovery, and repeats the
checks after redirects. These controls materially reduce SSRF risk but do not
replace authentication, authorization, deployment isolation, abuse controls,
or a production security review.

## Repository layout

```text
packages/
  api/       Express routes, validation, services, and API tests
  shared/    Prisma, lazy Redis queue, URL normalization, and job contracts
  workers/   bounded discovery, static scraper, cleaner, worker, and tests
prisma/      schema and committed migration
.devcontainer/
.github/workflows/
docker-compose.yml
```

The original assignment is preserved unchanged in `rag_assignment.txt`.
