import { describe, expect, it } from "vitest";

import {
  E5_EMBEDDING_DIMENSION,
  MultilingualE5Provider,
} from "../src/embedding/e5-provider";

const describeRealModel =
  process.env.RUN_REAL_MODEL_TESTS === "true"
    ? describe
    : describe.skip;

describeRealModel("real multilingual E5 model", () => {
  it(
    "returns one normalized 384-dimensional vector",
    async () => {
      const provider = new MultilingualE5Provider({
        batchSize: 1,
      });
      const vector = await provider.embedQuery(
        "How does deterministic crawling work?",
      );

      expect(vector).toHaveLength(E5_EMBEDDING_DIMENSION);
      expect(
        Math.sqrt(
          vector.reduce((sum, value) => sum + value * value, 0),
        ),
      ).toBeCloseTo(1, 5);
    },
    180_000,
  );
});
