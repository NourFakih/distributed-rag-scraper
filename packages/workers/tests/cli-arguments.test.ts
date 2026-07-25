import { describe, expect, it } from "vitest";

import {
  DEFAULT_BACKFILL_BATCH_SIZE,
  parseBackfillArguments,
} from "../src/cli/arguments";

describe("parseBackfillArguments", () => {
  it("uses the documented default and accepts both flag forms", () => {
    expect(parseBackfillArguments([])).toEqual({
      batchSize: DEFAULT_BACKFILL_BATCH_SIZE,
    });
    expect(
      parseBackfillArguments([
        "--batch-size=10",
        "--limit",
        "25",
      ]),
    ).toEqual({
      batchSize: 10,
      limit: 25,
    });
  });

  it.each([
    ["--batch-size", "0"],
    ["--batch-size", "1.5"],
    ["--limit", "-1"],
    ["--limit"],
    ["--unknown", "1"],
  ])("rejects invalid CLI input: %s %s", (...arguments_) => {
    expect(() => parseBackfillArguments(arguments_)).toThrow();
  });
});
