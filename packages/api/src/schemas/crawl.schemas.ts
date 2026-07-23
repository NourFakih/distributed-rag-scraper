import { z } from "zod";

const absoluteHttpUrl = z
  .string()
  .trim()
  .min(1, "URL is required")
  .max(2_048, "URL must be at most 2048 characters")
  .superRefine((value, context) => {
    let parsed: URL;

    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "URL must be an absolute HTTP or HTTPS URL",
      });
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "URL must use HTTP or HTTPS",
      });
    }

    if (parsed.username || parsed.password) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "URL must not contain embedded credentials",
      });
    }
  })
  .transform((value) => {
    const normalized = new URL(value);
    normalized.hash = "";
    return normalized.toString();
  });

export const createCrawlBodySchema = z
  .object({
    url: absoluteHttpUrl,
  })
  .strict();

export const idParamsSchema = z.object({
  id: z.string().uuid("ID must be a valid UUID"),
});

export type CreateCrawlBody = z.infer<typeof createCrawlBodySchema>;

