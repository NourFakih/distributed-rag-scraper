import "dotenv/config";

import {
  closePrisma,
  getEmbeddingProvider,
  prisma,
} from "@distributed-rag/shared";

import {
  createEmbeddingBackfillRepository,
  runEmbeddingBackfill,
} from "../backfill/embedding-backfill";
import { parseBackfillArguments } from "./arguments";

async function main(): Promise<void> {
  const options = parseBackfillArguments(process.argv.slice(2));
  await prisma.$connect();
  const summary = await runEmbeddingBackfill(options, {
    repository: createEmbeddingBackfillRepository(prisma),
    provider: getEmbeddingProvider(),
  });
  console.log("Embedding backfill summary", summary);
  if (summary.chunksFailed > 0) {
    process.exitCode = 1;
  }
}

void main()
  .catch((error: unknown) => {
    console.error("Embedding backfill could not start or complete", error);
    process.exitCode = 1;
  })
  .finally(closePrisma);
