import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

export interface ErrorDetails {
  path?: string;
  message: string;
}

export class AppError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetails[],
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function asyncHandler(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(
    new AppError(
      404,
      "NOT_FOUND",
      `Route ${request.method} ${request.originalUrl} was not found`,
    ),
  );
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  if (error instanceof AppError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  console.error("Unhandled API error", error);
  response.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
  });
};

