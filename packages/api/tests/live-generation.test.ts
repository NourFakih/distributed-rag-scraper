import { describe, expect, it } from "vitest";

import {
  getGenerationProvider,
  resetGenerationProviderForTests,
} from "../src/generation/openai-compatible.provider";

const describeLive =
  process.env.RUN_LIVE_LLM_TESTS === "true"
    ? describe
    : describe.skip;

describeLive("live OpenAI-compatible generation", () => {
  it(
    "returns a cited answer for a controlled source",
    async () => {
      resetGenerationProviderForTests();
      const answer =
        await getGenerationProvider().generateGroundedAnswer({
          question: "What price is shown?",
          sources: [
            {
              number: 1,
              chunkId: "00000000-0000-4000-8000-000000000001",
              documentId:
                "00000000-0000-4000-8000-000000000010",
              chunkIndex: 0,
              url: "https://example.com/books",
              title: "Books",
              excerpt: "The displayed book price is $10.",
              similarity: 1,
            },
          ],
        });

      expect(answer).toContain("[1]");
    },
    120_000,
  );
});
