# Distributed RAG Scraper

This repository contains the bounded, polite, fault-tolerant static and
optional JavaScript-rendered crawling slices of the distributed RAG scraper
assignment:

```text
POST /api/crawls
  -> PostgreSQL Crawl + root CrawlPage
  -> Redis/BullMQ CrawlPage job
  -> independent worker
  -> cached robots.txt policy
  -> global Redis request-start limiter
  -> DNS/IP and redirect validation
  -> STATIC: safe Axios fetch
     or JAVASCRIPT: reusable Playwright Chromium
  -> shared Cheerio extraction and cleaning
  -> same-origin link discovery
  -> bounded child CrawlPage jobs
  -> normalized content + SHA-256
  -> one PostgreSQL Document per CrawlPage
  -> aggregate crawl/page/document/dead-letter APIs
```

Each run defaults to static rendering, at most 25 pages, and depth 2. React,
pgvector, embeddings, RAG, performance experiments, and the 500-page crawl
remain later phases.

## Stack

- Node.js 24 LTS, TypeScript, npm workspaces, and Turborepo
- Express API
- BullMQ and Redis
- PostgreSQL and Prisma 6.19.3
- Axios and Cheerio
- Playwright 1.61.1 with Chromium only
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
     -d '{"url":"https://example.com/","maxPages":5,"maxDepth":1,"renderMode":"STATIC"}' \
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
  "maxDepth": 2,
  "renderMode": "STATIC"
}
```

The URL must be absolute HTTP/HTTPS, may not contain credentials, and is limited
to 2,048 characters. URL fragments are removed and common downloadable
extensions are rejected. `maxPages` accepts 1–500 and `maxDepth` accepts 0–10;
`renderMode` accepts `STATIC` or `JAVASCRIPT`. Omitting optional fields preserves
the basic request and applies defaults of 25, 2, and `STATIC`. The endpoint
returns `202 Accepted` after the Crawl, root CrawlPage, and BullMQ job exist. If
root queueing fails, it marks the run failed and returns `503`.

### `GET /api/crawls/:id`

Returns the aggregate run status, render mode, limits, counters, root
page/document information, timestamps, and whether completion included
child-page failures. Invalid UUIDs return `422`; unknown UUIDs return `404`.

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
- One render mode is stored on the Crawl and applies to every page in that run.
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

JavaScript rendering launches one lazy Chromium instance per worker process and
reuses it across isolated page contexts. Two contexts may run concurrently by
default. Each navigation waits for `DOMContentLoaded`, an optional configured
selector, and a bounded settling delay. Pages and contexts close in `finally`,
and worker shutdown closes Chromium. Popups, downloads, non-HTTP requests,
unsafe DNS targets, external top-level navigation, and navigation beyond five
hops are blocked. Browser timeouts and crashes enter the existing retry and
dead-letter pipeline.

Renderer settings:

- `CRAWLER_JAVASCRIPT_NAVIGATION_TIMEOUT_MS` defaults to `15000`.
- `CRAWLER_JAVASCRIPT_SETTLE_MS` defaults to `500`.
- `CRAWLER_JAVASCRIPT_WAIT_SELECTOR` is optional and applies to every
  JavaScript-mode page.
- `CRAWLER_JAVASCRIPT_WAIT_SELECTOR_TIMEOUT_MS` defaults to `5000`.
- `CRAWLER_JAVASCRIPT_MAX_CONTEXTS` defaults to `2`.

## Security boundary

This remains a private Codespaces demonstration rather than a public crawling
service. Static mode resolves DNS before each hop, rejects private, loopback,
link-local, multicast, documentation, and other non-public targets, pins the
validated addresses into the Axios request, disables proxy discovery, and
repeats the checks after redirects.

JavaScript mode performs the same URL and DNS/IP checks before navigation and
for intercepted browser requests, but Chromium performs its own connection-time
DNS resolution. Playwright does not expose an equivalent to the Axios pinned
lookup used by static mode, so a DNS result can theoretically change between
validation and Chromium’s connection. JavaScript mode therefore does not claim
the same DNS-rebinding resistance as static mode and must remain private and
isolated. These controls do not replace authentication, authorization, abuse
controls, or a production security review.

## Repository layout

```text
packages/
  api/       Express routes, validation, services, and API tests
  shared/    Prisma, lazy Redis queue, URL normalization, and job contracts
  workers/   bounded discovery, static/JavaScript renderers, worker, and tests
prisma/      schema and committed migration
.devcontainer/
.github/workflows/
docker-compose.yml
```

The original assignment is preserved unchanged in `rag_assignment.txt`.
