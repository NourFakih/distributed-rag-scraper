import { Router } from "express";

import { askRouter } from "./ask.routes";
import { crawlRouter } from "./crawl.routes";
import { deadLetterRouter } from "./dead-letter.routes";
import { documentRouter } from "./document.routes";
import { searchRouter } from "./search.routes";

export const apiRouter = Router();

apiRouter.use("/ask", askRouter);
apiRouter.use("/crawls", crawlRouter);
apiRouter.use("/dead-letters", deadLetterRouter);
apiRouter.use("/documents", documentRouter);
apiRouter.use("/search", searchRouter);
