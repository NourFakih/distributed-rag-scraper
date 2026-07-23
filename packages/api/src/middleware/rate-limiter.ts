import { rateLimit } from "express-rate-limit";

export const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests; please retry shortly",
    },
  },
});

