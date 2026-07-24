import type { Request, Response } from "express";

import { getDocumentById } from "../services/document.service";

export async function getDocumentController(
  request: Request,
  response: Response,
): Promise<void> {
  const document = await getDocumentById(request.params.id!);

  response.status(200).json({
    data: {
      id: document.id,
      crawlId: document.crawlPage.crawlId,
      crawlPageId: document.crawlPageId,
      url: document.url,
      title: document.title,
      rawHtml: document.rawHtml,
      content: document.content,
      contentHash: document.contentHash,
      httpStatus: document.httpStatus,
      contentType: document.contentType,
      fetchedAt: document.fetchedAt,
      createdAt: document.createdAt,
    },
  });
}
