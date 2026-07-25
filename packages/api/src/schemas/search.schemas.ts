import { z } from "zod";

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;
export const MAX_SEARCH_QUERY_LENGTH = 512;
export const searchModes = ["semantic", "keyword"] as const;

export const searchQuerySchema = z
  .object({
    q: z
      .string({
        required_error: "q is required",
      })
      .trim()
      .min(1, "q must not be empty")
      .max(
        MAX_SEARCH_QUERY_LENGTH,
        `q must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters`,
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .default(DEFAULT_SEARCH_LIMIT),
    mode: z.enum(searchModes).default("semantic"),
  })
  .strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchMode = SearchQuery["mode"];
