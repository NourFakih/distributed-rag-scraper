import { z } from "zod";

export const DEFAULT_ASK_RETRIEVAL_LIMIT = 5;
export const MAX_ASK_RETRIEVAL_LIMIT = 10;
export const MAX_ASK_QUESTION_LENGTH = 2_000;

export const askBodySchema = z
  .object({
    question: z
      .string({
        required_error: "question is required",
      })
      .trim()
      .min(1, "question must not be empty")
      .max(
        MAX_ASK_QUESTION_LENGTH,
        `question must not exceed ${MAX_ASK_QUESTION_LENGTH} characters`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ASK_RETRIEVAL_LIMIT)
      .default(DEFAULT_ASK_RETRIEVAL_LIMIT),
  })
  .strict();

export type AskBody = z.infer<typeof askBodySchema>;
