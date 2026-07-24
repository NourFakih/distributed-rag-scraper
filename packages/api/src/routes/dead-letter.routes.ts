import { Router } from "express";

import { getDeadLetterController } from "../controllers/dead-letter.controller";
import { asyncHandler } from "../middleware/error-handler";
import { validate } from "../middleware/validate";
import { idParamsSchema } from "../schemas/crawl.schemas";

export const deadLetterRouter = Router();

deadLetterRouter.get(
  "/:id",
  validate(idParamsSchema, "params"),
  asyncHandler(getDeadLetterController),
);
