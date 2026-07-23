import { Router } from "express";

import { crawlRouter } from "./crawl.routes";
import { documentRouter } from "./document.routes";

export const apiRouter = Router();

apiRouter.use("/crawls", crawlRouter);
apiRouter.use("/documents", documentRouter);

