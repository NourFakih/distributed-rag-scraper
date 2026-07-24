import type { DeadLetter } from "@prisma/client";
import type { Request, Response } from "express";

import type { CrawlPagesQuery } from "../schemas/crawl.schemas";
import {
  getCrawlDeadLetters,
  getDeadLetterById,
} from "../services/dead-letter.service";

function parsedPayload(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }
}

function deadLetterResponse(deadLetter: DeadLetter) {
  return {
    id: deadLetter.id,
    crawlId: deadLetter.crawlId,
    crawlPageId: deadLetter.crawlPageId,
    jobId: deadLetter.jobId,
    url: deadLetter.url,
    jobPayload: parsedPayload(deadLetter.jobPayload),
    failureCategory: deadLetter.failureCategory,
    errorMessage: deadLetter.errorMessage,
    attemptCount: deadLetter.attemptCount,
    failedAt: deadLetter.failedAt,
  };
}

export async function getCrawlDeadLettersController(
  request: Request,
  response: Response,
): Promise<void> {
  const { page, pageSize } = request.query as unknown as CrawlPagesQuery;
  const result = await getCrawlDeadLetters(
    request.params.id!,
    page,
    pageSize,
  );

  response.status(200).json({
    data: result.deadLetters.map(deadLetterResponse),
    pagination: result.pagination,
  });
}

export async function getDeadLetterController(
  request: Request,
  response: Response,
): Promise<void> {
  const deadLetter = await getDeadLetterById(request.params.id!);
  response.status(200).json({
    data: deadLetterResponse(deadLetter),
  });
}
