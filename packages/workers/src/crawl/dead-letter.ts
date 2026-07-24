import { CrawlPageStatus, type CrawlPage } from "@prisma/client";
import {
  prisma,
  type CrawlJobData,
  type CrawlJobName,
  type CrawlJobResult,
} from "@distributed-rag/shared";
import type { Job } from "bullmq";

import type { CrawlFailure } from "../errors/crawl-failure";

export const MAX_FAILURE_MESSAGE_LENGTH = 2_000;
export const MAX_JOB_PAYLOAD_LENGTH = 8_192;

export function boundedFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

export function serializedJobPayload(data: unknown): string {
  const serialized = JSON.stringify(data) ?? "null";
  if (serialized.length <= MAX_JOB_PAYLOAD_LENGTH) {
    return serialized;
  }

  const wrapperOverhead = JSON.stringify({
    truncated: true,
    preview: "",
  }).length;
  return JSON.stringify({
    truncated: true,
    preview: serialized.slice(
      0,
      MAX_JOB_PAYLOAD_LENGTH - wrapperOverhead,
    ),
  }).slice(0, MAX_JOB_PAYLOAD_LENGTH);
}

export async function persistTerminalFailure(
  crawlPage: CrawlPage,
  job: Job<CrawlJobData, CrawlJobResult, CrawlJobName>,
  failure: CrawlFailure,
): Promise<void> {
  const completedAt = new Date();
  const errorMessage = boundedFailureMessage(failure);
  const attemptCount = job.attemptsMade + 1;

  await prisma.$transaction(async (transaction) => {
    await transaction.crawlPage.update({
      where: {
        id: crawlPage.id,
      },
      data: {
        status: CrawlPageStatus.FAILED,
        error: errorMessage,
        failureCategory: failure.category,
        completedAt,
      },
    });

    await transaction.crawlPage.updateMany({
      where: {
        parentPageId: crawlPage.id,
        status: CrawlPageStatus.DISCOVERED,
      },
      data: {
        status: CrawlPageStatus.SKIPPED,
        error: "Parent page failed before this page could be queued",
        completedAt,
      },
    });

    await transaction.deadLetter.upsert({
      where: {
        crawlPageId: crawlPage.id,
      },
      create: {
        crawlId: crawlPage.crawlId,
        crawlPageId: crawlPage.id,
        jobId: String(job.id ?? crawlPage.id),
        url: crawlPage.url,
        jobPayload: serializedJobPayload(job.data),
        failureCategory: failure.category,
        errorMessage,
        attemptCount,
        failedAt: completedAt,
      },
      update: {},
    });
  });
}
