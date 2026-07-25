import { Router } from "express";

import { searchController } from "../controllers/search.controller";
import { asyncHandler } from "../middleware/error-handler";
import { validate } from "../middleware/validate";
import { searchQuerySchema } from "../schemas/search.schemas";

export const searchRouter = Router();

searchRouter.get(
  "/",
  validate(searchQuerySchema, "query"),
  asyncHandler(searchController),
);
