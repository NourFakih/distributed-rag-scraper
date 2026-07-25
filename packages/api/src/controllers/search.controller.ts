import type { Request, Response } from "express";

import type { SearchQuery } from "../schemas/search.schemas";
import { semanticSearch } from "../services/search.service";

export async function searchController(
  request: Request,
  response: Response,
): Promise<void> {
  const query = request.query as unknown as SearchQuery;
  response.status(200).json({
    data: await semanticSearch(query.q, query.limit),
  });
}
