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
import type { Job } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../api/app";
import { processCrawlJob } from "../src/jobs/crawl.job";
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
      .send({ url: `${fixtureBaseUrl}/fixture#ignored-fragment` });

    expect(created.status).toBe(202);
    expect(created.body.data.status).toBe("QUEUED");
    const crawlId = String(created.body.data.id);

    const completed = await waitForStatus(app, crawlId, ["COMPLETED"]);
    expect(completed.data.attempts).toBe(1);
    const documentId = String(completed.data.documentId);

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
        crawlId,
        url: `${fixtureBaseUrl}/fixture`,
      },
      attemptsMade: 0,
      opts: {
        attempts: 3,
      },
    } as unknown as Job<CrawlJobData, CrawlJobResult, CrawlJobName>);

    await expect(
      prisma.document.count({
        where: {
          crawlId,
        },
      }),
    ).resolves.toBe(1);
  });

  it("persists RETRYING and then terminal FAILED state", async () => {
    const created = await request(app)
      .post("/api/crawls")
      .send({ url: `${fixtureBaseUrl}/non-html` });
    const crawlId = String(created.body.data.id);

    const failed = await waitForStatus(app, crawlId, ["FAILED"]);

    expect(failed.data.status).toBe("FAILED");
    expect(failed.data.attempts).toBe(3);
    expect(failed.data.errorMessage).toContain("Unsupported content type");
    expect(failed.observed.has("RETRYING")).toBe(true);

    const job = await getCrawlQueue().getJob(crawlId);
    expect(job?.name).toBe(SCRAPE_STATIC_PAGE_JOB);
    expect(await job?.getState()).toBe("failed");
  });
});

