import "dotenv/config";

import { closePrisma, prisma } from "@distributed-rag/shared";

import { runChunkBackfill } from "../backfill/chunk-backfill";
import { parseBackfillArguments } from "./arguments";

async function main(): Promise<void> {
  const options = parseBackfillArguments(process.argv.slice(2));
  await prisma.$connect();
  const summary = await runChunkBackfill(prisma, options);
  console.log("Chunk backfill summary", summary);
  if (summary.documentsFailed > 0) {
    process.exitCode = 1;
  }
}

void main()
  .catch((error: unknown) => {
    console.error("Chunk backfill could not start or complete", error);
    process.exitCode = 1;
  })
  .finally(closePrisma);
