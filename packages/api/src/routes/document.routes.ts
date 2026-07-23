import { Router } from "express";

import { getDocumentController } from "../controllers/document.controller";
import { asyncHandler } from "../middleware/error-handler";
import { validate } from "../middleware/validate";
import { idParamsSchema } from "../schemas/crawl.schemas";

export const documentRouter = Router();

documentRouter.get(
  "/:id",
  validate(idParamsSchema, "params"),
  asyncHandler(getDocumentController),
);

