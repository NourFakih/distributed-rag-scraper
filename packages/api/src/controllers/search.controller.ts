import type { Request, Response } from "express";

import type { SearchQuery } from "../schemas/search.schemas";
import { searchDocuments } from "../services/search.service";

export async function searchController(
  request: Request,
  response: Response,
): Promise<void> {
  const query = request.query as unknown as SearchQuery;
  response.status(200).json({
    data: await searchDocuments(query.q, query.limit, query.mode),
  });
}
