import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  closeCrawlQueue,
  closePrisma,
  getCrawlQueue,
  prisma,
  SCRAPE_STATIC_PAGE_JOB,
  type CrawlJobData,
  type CrawlJobName,
  type CrawlJobResult,
} from "@distributed-rag/shared";
import { CrawlPageStatus, CrawlStatus } from "@prisma/client";
import type { Job } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../api/app";
import { processCrawlJob } from "../src/jobs/crawl.job";
import { reserveDiscoveredPages } from "../src/crawl/discover-pages";
import {
  createCrawlWorker,
  type CrawlWorkerRuntime,
} from "../src/worker";
import { EXPECTED_FIXTURE_CONTENT, FIXTURE_HTML } from "./fixture";

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

async function waitForStatus(
  app: ReturnType<typeof createApp>,
  crawlId: string,
  terminalStatuses: string[],
): Promise<{ data: Record<string, unknown>; observed: Set<string> }> {
  const deadline = Date.now() + 15_000;
  const observed = new Set<string>();

  while (Date.now() < deadline) {
    const response = await request(app).get(`/api/crawls/${crawlId}`);
    const status = String(response.body.data.status);
    observed.add(status);

    if (terminalStatuses.includes(status)) {
      return {
        data: response.body.data as Record<string, unknown>,
        observed,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for crawl ${crawlId}`);
}

describe.runIf(runIntegrationTests)("static crawl vertical slice", () => {
  const app = createApp();
  let fixtureServer: Server;
  let fixtureBaseUrl: string;
  let workerRuntime: CrawlWorkerRuntime;

  beforeAll(async () => {
    fixtureServer = createServer((requestMessage, response) => {
      if (requestMessage.url === "/non-html") {
        response.writeHead(200, {
          "content-type": "application/json",
        });
        response.end('{"message":"not HTML"}');
        return;
      }

      const graphPages: Record<string, string> = {
        "/graph/": `
          <html><head><title>Graph root</title></head><body><main>
            <h1>Graph root</h1>
            <p>Root content.</p>
            <a href="child-a">Child A</a>
            <a href="./child-a#duplicate">Child A duplicate</a>
            <a href="/graph/child-b">Child B</a>
            <a href="https://outside.example/page">External</a>
            <a href="mailto:team@example.com">Email</a>
            <a href="/graph/manual.pdf">Download</a>
            <a href="/graph/private" rel="nofollow">Private</a>
          </main></body></html>
        `,
        "/graph/child-a": `
          <html><head><title>Child A</title></head><body><main>
            <h1>Child A</h1><p>First child.</p>
            <a href="grandchild">Grandchild</a>
          </main></body></html>
        `,
        "/graph/child-b": `
          <html><head><title>Child B</title></head><body><main>
            <h1>Child B</h1><p>Second child.</p>
          </main></body></html>
        `,
        "/graph/grandchild": `
          <html><head><title>Grandchild</title></head><body><main>
            <h1>Grandchild</h1><p>Depth two.</p>
          </main></body></html>
        `,
      };
      const graphPage = graphPages[requestMessage.url ?? ""];
      if (graphPage) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(graphPage);
        return;
      }

      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(FIXTURE_HTML);
    });

    await new Promise<void>((resolve) => {
      fixtureServer.listen(0, "127.0.0.1", resolve);
    });
    const address = fixtureServer.address() as AddressInfo;
    fixtureBaseUrl = `http://127.0.0.1:${address.port}`;

    await prisma.$connect();
    await prisma.document.deleteMany();
    await prisma.crawl.deleteMany();
    await getCrawlQueue().obliterate({ force: true });
    workerRuntime = createCrawlWorker();
    await workerRuntime.worker.waitUntilReady();
  });

  afterAll(async () => {
    await workerRuntime.close();
    await closeCrawlQueue();
    await closePrisma();
    await new Promise<void>((resolve, reject) => {
      fixtureServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("queues, processes, persists, retrieves, and idempotently redelivers", async () => {
    const created = await request(app)
      .post("/api/crawls")
      .send({
        url: `${fixtureBaseUrl}/fixture#ignored-fragment`,
        maxDepth: 0,
      });

    expect(created.status).toBe(202);
    expect(created.body.data.status).toBe("QUEUED");
    const crawlId = String(created.body.data.id);

    const completed = await waitForStatus(app, crawlId, ["COMPLETED"]);
    expect(completed.data.attempts).toBe(1);
    const documentId = String(completed.data.documentId);
    const rootPageId = String(
      (completed.data.rootPage as Record<string, unknown>).id,
    );

    const documentResponse = await request(app).get(
      `/api/documents/${documentId}`,
    );
    expect(documentResponse.status).toBe(200);
    expect(documentResponse.body.data.content).toBe(
      EXPECTED_FIXTURE_CONTENT,
    );
    expect(documentResponse.body.data.rawHtml).toBe(FIXTURE_HTML);
    expect(documentResponse.body.data.contentHash).toMatch(/^[a-f0-9]{64}$/);

    await processCrawlJob({
      data: {
        crawlPageId: rootPageId,
      },
      attemptsMade: 0,
      opts: {
        attempts: 3,
      },
    } as unknown as Job<CrawlJobData, CrawlJobResult, CrawlJobName>);

    await expect(
      prisma.document.count({
        where: {
          crawlPage: {
            crawlId,
          },
        },
      }),
    ).resolves.toBe(1);
  });

  it("reports terminal page failures while completing the aggregate Crawl", async () => {
    const created = await request(app)
      .post("/api/crawls")
      .send({ url: `${fixtureBaseUrl}/non-html` });
    const crawlId = String(created.body.data.id);

    const failed = await waitForStatus(app, crawlId, ["COMPLETED"]);

    expect(failed.data.status).toBe("COMPLETED");
    expect(failed.data.attempts).toBe(3);
    expect(failed.data.errorMessage).toContain("Unsupported content type");
    expect(failed.data.completedWithFailures).toBe(true);
    expect(failed.data.counters).toMatchObject({
      failed: 1,
    });

    const rootPageId = String(
      (failed.data.rootPage as Record<string, unknown>).id,
    );
    const job = await getCrawlQueue().getJob(rootPageId);
    expect(job?.name).toBe(SCRAPE_STATIC_PAGE_JOB);
    expect(await job?.getState()).toBe("failed");
  });

  it("completes a deterministic multi-page fixture graph", async () => {
    const created = await request(app).post("/api/crawls").send({
      url: `${fixtureBaseUrl}/graph/`,
      maxPages: 10,
      maxDepth: 2,
    });
    const crawlId = String(created.body.data.id);

    const completed = await waitForStatus(app, crawlId, ["COMPLETED"]);
    expect(completed.data.counters).toEqual({
      discovered: 4,
      completed: 4,
      skipped: 0,
      failed: 0,
    });
    expect(completed.data.completedWithFailures).toBe(false);

    const pagesResponse = await request(app).get(
      `/api/crawls/${crawlId}/pages?page=1&pageSize=10`,
    );
    expect(pagesResponse.status).toBe(200);
    expect(pagesResponse.body.pagination.total).toBe(4);
    expect(
      pagesResponse.body.data.map(
        (page: { normalizedUrl: string }) => page.normalizedUrl,
      ),
    ).toEqual(
      expect.arrayContaining([
        `${fixtureBaseUrl}/graph/`,
        `${fixtureBaseUrl}/graph/child-a`,
        `${fixtureBaseUrl}/graph/child-b`,
        `${fixtureBaseUrl}/graph/grandchild`,
      ]),
    );
    expect(
      pagesResponse.body.data.every(
        (page: Record<string, unknown>) => !("rawHtml" in page),
      ),
    ).toBe(true);
    await expect(
      prisma.document.count({
        where: {
          crawlPage: {
            crawlId,
          },
        },
      }),
    ).resolves.toBe(4);
  });

  it("honors maxDepth zero and the configured depth boundary", async () => {
    const depthZero = await request(app).post("/api/crawls").send({
      url: `${fixtureBaseUrl}/graph/`,
      maxPages: 10,
      maxDepth: 0,
    });
    const depthZeroId = String(depthZero.body.data.id);
    const depthZeroCompleted = await waitForStatus(app, depthZeroId, [
      "COMPLETED",
    ]);
    expect(
      (depthZeroCompleted.data.counters as Record<string, number>).discovered,
    ).toBe(1);

    const depthOne = await request(app).post("/api/crawls").send({
      url: `${fixtureBaseUrl}/graph/`,
      maxPages: 10,
      maxDepth: 1,
    });
    const depthOneId = String(depthOne.body.data.id);
    const depthOneCompleted = await waitForStatus(app, depthOneId, [
      "COMPLETED",
    ]);
    expect(
      (depthOneCompleted.data.counters as Record<string, number>).discovered,
    ).toBe(3);
    await expect(
      prisma.crawlPage.count({
        where: {
          crawlId: depthOneId,
          depth: 2,
        },
      }),
    ).resolves.toBe(0);
  });

  it("never exceeds maxPages while processing a link-rich page", async () => {
    const created = await request(app).post("/api/crawls").send({
      url: `${fixtureBaseUrl}/graph/`,
      maxPages: 2,
      maxDepth: 2,
    });
    const crawlId = String(created.body.data.id);
    const completed = await waitForStatus(app, crawlId, ["COMPLETED"]);

    expect(
      (completed.data.counters as Record<string, number>).discovered,
    ).toBe(2);
    await expect(
      prisma.crawlPage.count({
        where: {
          crawlId,
        },
      }),
    ).resolves.toBe(2);
  });

  it("serializes concurrent discovery and never reserves beyond maxPages", async () => {
    const crawl = await prisma.crawl.create({
      data: {
        seedUrl: `${fixtureBaseUrl}/concurrent-root`,
        normalizedOrigin: fixtureBaseUrl,
        status: CrawlStatus.PROCESSING,
        maxPages: 5,
        maxDepth: 2,
        discoveredCount: 2,
        pages: {
          create: [
            {
              url: `${fixtureBaseUrl}/parent-a`,
              normalizedUrl: `${fixtureBaseUrl}/parent-a`,
              depth: 0,
              status: CrawlPageStatus.PROCESSING,
            },
            {
              url: `${fixtureBaseUrl}/parent-b`,
              normalizedUrl: `${fixtureBaseUrl}/parent-b`,
              depth: 0,
              status: CrawlPageStatus.PROCESSING,
            },
          ],
        },
      },
      include: {
        pages: true,
      },
    });

    const candidates = (prefix: string) =>
      Array.from({ length: 5 }, (_value, index) => {
        const normalizedUrl = `${fixtureBaseUrl}/${prefix}-${index}`;
        return {
          url: normalizedUrl,
          normalizedUrl,
        };
      });

    await Promise.all([
      reserveDiscoveredPages(crawl.pages[0]!, candidates("a")),
      reserveDiscoveredPages(crawl.pages[1]!, candidates("b")),
    ]);

    await expect(
      prisma.crawlPage.count({
        where: {
          crawlId: crawl.id,
        },
      }),
    ).resolves.toBe(5);
  });

  it("does not duplicate children when a parent discovery is retried", async () => {
    const crawl = await prisma.crawl.create({
      data: {
        seedUrl: `${fixtureBaseUrl}/retry-parent`,
        normalizedOrigin: fixtureBaseUrl,
        status: CrawlStatus.PROCESSING,
        maxPages: 10,
        maxDepth: 2,
        pages: {
          create: {
            url: `${fixtureBaseUrl}/retry-parent`,
            normalizedUrl: `${fixtureBaseUrl}/retry-parent`,
            depth: 0,
            status: CrawlPageStatus.PROCESSING,
          },
        },
      },
      include: {
        pages: true,
      },
    });
    const candidates = ["one", "two"].map((suffix) => ({
      url: `${fixtureBaseUrl}/retry-${suffix}`,
      normalizedUrl: `${fixtureBaseUrl}/retry-${suffix}`,
    }));

    await reserveDiscoveredPages(crawl.pages[0]!, candidates);
    await reserveDiscoveredPages(crawl.pages[0]!, candidates);

    await expect(
      prisma.crawlPage.count({
        where: {
          crawlId: crawl.id,
        },
      }),
    ).resolves.toBe(3);
  });
});
