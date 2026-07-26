# Horizontal Scaling Experiment Results

- **Generated:** 2026-07-26 19:19:19 UTC
- **Temporary PostgreSQL database:** `distributed_rag_scaling`
- **Temporary Redis database:** `14`
- **Per-worker BullMQ concurrency:** 5
- **Raw logs and PID files:** `/tmp/distributed-rag-scaling.ZQL6xf`

## Exact workload

| Name | URL | maxPages | maxDepth | renderMode |
|---|---|---:|---:|---|
| Books to Scrape | https://books.toscrape.com/ | 40 | 3 | STATIC |
| Quotes to Scrape | https://quotes.toscrape.com/ | 30 | 3 | STATIC |

Both rounds submitted every crawl concurrently. The benchmark database was dropped, recreated, and migrated before each round, and only Redis DB 14 was flushed. This prevents incremental recrawling from giving Round B a warm-document advantage.

## Comparison

| Workers | Crawls | Completed pages | Failed | Duration seconds | Pages/second |
|---------|--------|-----------------|--------|------------------|--------------|
| 1 | 2 | 64 | 6 | 59.982 | 1.067 |
| 3 | 2 | 64 | 6 | 55.933 | 1.144 |

- **Speedup:** 1.072x (one-worker duration / three-worker duration)
- **Throughput improvement:** 7.2%

## Raw metrics

| Round | Workers | Crawls | Requested cap | Discovered | Completed | Skipped | Failed | Duration (s) | Pages/s | Crawl IDs | Final statuses |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| A | 1 | 2 | 70 | 70 | 64 | 0 | 6 | 59.982 | 1.067 | b3cb66de-e726-4fc0-967a-097321dbb0d0, c98294ae-1457-41b2-b846-56f1ba844c98 | COMPLETED, COMPLETED |
| B | 3 | 2 | 70 | 70 | 64 | 0 | 6 | 55.933 | 1.144 | 96f22611-4cc8-4afe-885c-8f632c7bc96a, f5bdc697-c20f-41a3-b104-6d126e6b0638 | COMPLETED, COMPLETED |

## Interpretation

Each worker was an independent OS process running the same built worker entry point. All workers shared BullMQ through the isolated Redis logical database and persisted to the isolated PostgreSQL database.

HTTP request starts remain globally rate-limited per origin through Redis, and robots.txt is respected. Multiple origins allow useful parallel work, but politeness limits cap the speedup available for each individual origin. A small or negative speedup is therefore an honest result when origin latency, crawl topology, or per-origin delays dominate worker capacity.

## Conclusion

Round B improved measured throughput by 7.2% with a 1.072x duration speedup.
