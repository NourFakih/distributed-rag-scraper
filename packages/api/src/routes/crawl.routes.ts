import { Router } from "express";

import {
  createCrawlController,
  getCrawlController,
  getCrawlPagesController,
} from "../controllers/crawl.controller";
import { asyncHandler } from "../middleware/error-handler";
import { validate } from "../middleware/validate";
import {
  crawlPagesQuerySchema,
  createCrawlBodySchema,
  idParamsSchema,
} from "../schemas/crawl.schemas";

export const crawlRouter = Router();

crawlRouter.post(
  "/",
  validate(createCrawlBodySchema, "body"),
  asyncHandler(createCrawlController),
);

crawlRouter.get(
  "/:id/pages",
  validate(idParamsSchema, "params"),
  validate(crawlPagesQuerySchema, "query"),
  asyncHandler(getCrawlPagesController),
);

crawlRouter.get(
  "/:id",
  validate(idParamsSchema, "params"),
  asyncHandler(getCrawlController),
);
