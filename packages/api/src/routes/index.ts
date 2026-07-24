import { Router } from "express";

import { crawlRouter } from "./crawl.routes";
import { deadLetterRouter } from "./dead-letter.routes";
import { documentRouter } from "./document.routes";

export const apiRouter = Router();

apiRouter.use("/crawls", crawlRouter);
apiRouter.use("/dead-letters", deadLetterRouter);
apiRouter.use("/documents", documentRouter);
