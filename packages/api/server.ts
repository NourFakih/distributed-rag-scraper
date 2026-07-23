import "dotenv/config";

import {
  closeCrawlQueue,
  closePrisma,
  prisma,
} from "@distributed-rag/shared";

import { createApp } from "./app";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = createApp();

async function start(): Promise<void> {
  await prisma.$connect();

  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`API listening on http://0.0.0.0:${port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}; shutting down API`);

    server.close(async () => {
      await Promise.allSettled([closeCrawlQueue(), closePrisma()]);
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((error: unknown) => {
  console.error("API failed to start", error);
  process.exit(1);
});

