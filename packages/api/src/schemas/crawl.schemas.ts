import {
  normalizeCrawlUrl,
  UrlNormalizationError,
} from "@distributed-rag/shared";
import { RenderMode } from "@prisma/client";
import { z } from "zod";

const absoluteHttpUrl = z
  .string()
  .transform((value, context) => {
    try {
      return normalizeCrawlUrl(value);
    } catch (error: unknown) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof UrlNormalizationError
            ? error.message
            : "URL is invalid",
      });
      return z.NEVER;
    }
  });

export const createCrawlBodySchema = z
  .object({
    url: absoluteHttpUrl,
    maxPages: z.number().int().min(1).max(500).default(25),
    maxDepth: z.number().int().min(0).max(10).default(2),
    renderMode: z
      .enum([RenderMode.STATIC, RenderMode.JAVASCRIPT])
      .default(RenderMode.STATIC),
  })
  .strict();

export const idParamsSchema = z.object({
  id: z.string().uuid("ID must be a valid UUID"),
});

export const crawlPagesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CreateCrawlBody = z.infer<typeof createCrawlBodySchema>;
export type CrawlPagesQuery = z.infer<typeof crawlPagesQuerySchema>;
