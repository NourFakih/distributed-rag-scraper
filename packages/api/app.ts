import express from "express";
import helmet from "helmet";

import { errorHandler, notFoundHandler } from "./src/middleware/error-handler";
import { apiRateLimiter } from "./src/middleware/rate-limiter";
import { apiRouter } from "./src/routes";

export function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "32kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.status(200).json({
      data: {
        service: "api",
        status: "ok",
      },
    });
  });

  app.use("/api", apiRateLimiter, apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

