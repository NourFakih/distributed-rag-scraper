import "dotenv/config";

import { closePrisma, prisma } from "@distributed-rag/shared";

import { createCrawlWorker } from "./src/worker";

async function start(): Promise<void> {
  await prisma.$connect();
  const runtime = createCrawlWorker();
  let shuttingDown = false;

  console.log("Crawl worker is waiting for jobs");

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}; shutting down crawl worker`);
    await runtime.close();
    await closePrisma();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((error: unknown) => {
  console.error("Crawl worker failed to start", error);
  process.exit(1);
});

