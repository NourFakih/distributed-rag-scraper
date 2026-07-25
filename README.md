# Distributed RAG Scraper

This repository contains the bounded, polite, fault-tolerant crawler and its
local multilingual semantic indexing and retrieval pipeline:

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
  -> deterministic overlapping Chunk rows per Document
  -> local multilingual E5 passage embeddings
  -> PostgreSQL pgvector cosine index
  -> semantic-search API
  -> aggregate crawl/page/document/dead-letter APIs
```

Each run defaults to static rendering, at most 25 pages, and depth 2. LLM
answer generation, cited RAG answers, React, reranking, hybrid search,
performance experiments, and the 500-page crawl remain later phases.

## Stack

- Node.js 24 LTS, TypeScript, npm workspaces, and Turborepo
- Express API
- BullMQ and Redis
- PostgreSQL 16, pgvector 0.8.2, and Prisma 6.19.3
- Transformers.js 4.2.0 and `intfloat/multilingual-e5-small`
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

Stop the stack with `docker compose down`. Named PostgreSQL, Redis, and model
cache volumes preserve database records, queue state, and model files between
restarts. Do not use `docker compose down --volumes` when preserving crawler
or index data matters.

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

Normal tests mock the embedding inference boundary and never download the E5
model. Service-backed tests additionally require PostgreSQL/pgvector and Redis:

```bash
RUN_INTEGRATION_TESTS=true npm test
```

The optional real-model smoke test downloads and executes the pinned model:

```bash
npm run test:model
```

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

### `GET /api/search`

`q` is required, trimmed, non-empty, and limited to 512 characters. `limit`
defaults to 5 and accepts integers from 1 through 20:

```bash
curl --get http://localhost:3000/api/search \
  --data-urlencode "q=How does the crawler respect robots.txt?" \
  --data-urlencode "limit=5"
```

Example response:

```json
{
  "data": {
    "query": "How does the crawler respect robots.txt?",
    "activeEmbeddingModel": {
      "id": "intfloat/multilingual-e5-small",
      "version": "hf:614241f622f53c4eeff9890bdc4f31cfecc418b3|transformers.js:4.2.0|fp32|mean|l2:v1",
      "dimension": 384
    },
    "resultCount": 1,
    "results": [
      {
        "chunkId": "CHUNK_UUID",
        "documentId": "DOCUMENT_UUID",
        "url": "https://example.com/guide",
        "title": "Crawler guide",
        "chunkIndex": 2,
        "excerpt": "The worker checks robots.txt before fetching...",
        "similarity": 0.91
      }
    ]
  }
}
```

The API never returns raw vectors. An empty or not-yet-embedded index is not an
error: it returns HTTP 200, `resultCount: 0`, and `results: []`.

## Document chunking

Every successfully persisted Document is split deterministically by the worker
into chunks targeting approximately 1,000 characters with approximately 150
characters of overlap. The splitter prefers paragraph, line, and whitespace
boundaries. Chunk offsets use inclusive starts and exclusive ends, so
`document.content.slice(startOffset, endOffset)` reproduces the stored chunk
exactly. Each chunk stores its own lowercase SHA-256 content hash.

Document upsert, stale-chunk deletion, and replacement-chunk insertion share
one PostgreSQL transaction. The unique `(documentId, chunkIndex)` key prevents
duplicate positions, and deleting a Document cascades to its chunks. The same
synchronizer is used by live crawl processing and the backfill. Unchanged rows
retain valid embeddings; changed content transactionally replaces stale chunks,
whose new rows begin without embeddings.

After starting the Compose stack and completing a crawl, inspect chunk counts:

```bash
docker compose exec postgres \
  psql -U postgres -d distributed_rag \
  -c 'SELECT document_id, COUNT(*) AS chunks FROM chunks GROUP BY document_id ORDER BY document_id;'
```

Inspect one document's ordered chunks:

```bash
docker compose exec postgres \
  psql -U postgres -d distributed_rag \
  -c "SELECT chunk_index, start_offset, end_offset, content_hash FROM chunks WHERE document_id = 'COPY_DOCUMENT_ID_HERE' ORDER BY chunk_index;"
```

Backfill Documents created before chunking was introduced:

```bash
npm run chunks:backfill -- --batch-size 25 --limit 500
```

With the Compose runtime, invoke the already-built worker command:

```bash
docker compose run --rm worker \
  node packages/workers/dist/src/cli/chunks-backfill.js \
  --batch-size 25 --limit 500
```

Both flags require positive integers. `--batch-size` defaults to 25 and is
bounded at 500; `--limit` is optional. Cursor pagination, per-Document
transactions, and error isolation make the command safe to stop and rerun. Its
summary reports inspected, processed, skipped, and failed Documents plus
created, retained, and replaced chunks.

## Local embeddings and pgvector

The committed migration enables the `vector` extension and adds nullable
`vector(384)` storage plus model, model-version, embedded-content-hash, and
timestamp metadata to each Chunk. Existing Documents and Chunks remain in
place and initially have no embedding. A partial HNSW index with
`vector_cosine_ops` indexes only non-null vectors. HNSW keeps retrieval
practical as the index grows; it is approximate, while the final SQL ordering
is deterministic by cosine similarity descending and Chunk UUID ascending.

The pinned model is
[`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small)
at revision `614241f622f53c4eeff9890bdc4f31cfecc418b3`, executed locally through
Transformers.js 4.2.0. It produces 384-dimensional embeddings. The provider
adds `passage: ` to chunks and `query: ` to searches, removes an existing E5
prefix before applying the correct one, mean-pools, L2-normalizes, and verifies
dimension, finiteness, and unit magnitude before a vector can be stored or
queried.

An embedding is current only when all of these match:

- a vector exists;
- `embedding_model` is the active model ID;
- `embedding_version` is the pinned model revision, inference library,
  precision, pooling, normalization, and provider-contract version;
- `embedded_content_hash` equals the Chunk's current `content_hash`.

Backfill missing or stale embeddings:

```bash
npm run embeddings:backfill -- --batch-size 16 --limit 100
```

Or use the worker image and shared Compose model cache:

```bash
docker compose run --rm worker \
  node packages/workers/dist/src/cli/embeddings-backfill.js \
  --batch-size 16 --limit 100
```

The CLI uses cursor pagination, bounded inference batches, three bounded
attempts, a per-Chunk fallback after a failed batch, and a content-hash
condition on update. It never overwrites a newer Chunk after concurrent
content change and is safe to resume. The final summary includes inspected,
embedded, skipped, and failed Chunks, completed batches, and elapsed time.

`MODEL_CACHE_DIR` is explicit. Compose mounts the persistent `model-cache`
volume at `/models/cache` into both API and worker containers, so query and
backfill processes reuse downloaded files. `EMBEDDING_BATCH_SIZE` defaults to
16 (maximum 64), and `EMBEDDING_ALLOW_REMOTE_MODELS=false` forces cache-only
startup. The API loads the model only on the first semantic query; crawler-only
worker operation does not initialize it.

The pinned fp32 ONNX weights are about 470 MB, and tokenizer/config files bring
the first download to roughly 493 MB. Budget approximately 0.7-1.2 GB of
runtime memory per process that actually loads the model, depending on the
platform and batch size. First use includes download plus model initialization
and can take tens of seconds; later starts reuse the volume but still pay model
initialization time. The 512-token E5 input limit means very long character
chunks may be token-truncated; the current approximately 1,000-character
chunker reduces but does not eliminate that risk.

Apply and verify the pgvector migration in Codespaces:

```bash
docker compose up -d postgres redis
docker compose run --rm migrate
docker compose exec postgres \
  psql -U postgres -d distributed_rag -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

The Compose PostgreSQL service uses
`pgvector/pgvector:0.8.2-pg16-bookworm` and retains the existing
`postgres-data` volume and database settings.

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
- Document writes atomically replace their deterministic chunks, and the
  unique `(documentId, chunkIndex)` key prevents duplicate chunks.
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
  shared/    Prisma, Redis queue, URL contracts, and local embedding provider
  workers/   crawling, rendering, chunk synchronization, backfills, and tests
prisma/      schema and committed migration
.devcontainer/
.github/workflows/
docker-compose.yml
```

The original assignment is preserved unchanged in `rag_assignment.txt`.
