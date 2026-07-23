import type { Request, Response } from "express";

import type { CreateCrawlBody } from "../schemas/crawl.schemas";
import { createCrawl, getCrawlById } from "../services/crawl.service";

export async function createCrawlController(
  request: Request,
  response: Response,
): Promise<void> {
  const { url } = request.body as CreateCrawlBody;
  const crawl = await createCrawl(url);

  response.status(202).json({
    data: {
      id: crawl.id,
      url: crawl.url,
      status: crawl.status,
      createdAt: crawl.createdAt,
    },
  });
}

export async function getCrawlController(
  request: Request,
  response: Response,
): Promise<void> {
  const crawl = await getCrawlById(request.params.id!);

  response.status(200).json({
    data: {
      id: crawl.id,
      url: crawl.url,
      status: crawl.status,
      attempts: crawl.attempts,
      errorMessage: crawl.errorMessage,
      documentId: crawl.document?.id ?? null,
      startedAt: crawl.startedAt,
      completedAt: crawl.completedAt,
      createdAt: crawl.createdAt,
      updatedAt: crawl.updatedAt,
    },
  });
}
