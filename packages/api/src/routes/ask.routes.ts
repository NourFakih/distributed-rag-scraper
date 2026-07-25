import { Router } from "express";

import { askController } from "../controllers/ask.controller";
import { asyncHandler } from "../middleware/error-handler";
import { validate } from "../middleware/validate";
import { askBodySchema } from "../schemas/ask.schemas";

export const askRouter = Router();

askRouter.post(
  "/",
  validate(askBodySchema, "body"),
  asyncHandler(askController),
);
