import type { RequestHandler } from "express";
import type { ZodType } from "zod";

import { AppError } from "./error-handler";

type RequestPart = "body" | "params" | "query";

export function validate(
  schema: ZodType,
  requestPart: RequestPart,
): RequestHandler {
  return (request, _response, next) => {
    const result = schema.safeParse(request[requestPart]);

    if (!result.success) {
      next(
        new AppError(
          422,
          "VALIDATION_ERROR",
          "Request validation failed",
          result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ),
      );
      return;
    }

    if (requestPart === "body") {
      request.body = result.data;
    } else if (requestPart === "params") {
      request.params = result.data as Record<string, string>;
    } else {
      request.query = result.data as typeof request.query;
    }

    next();
  };
}
