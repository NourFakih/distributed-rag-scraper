import { describe, expect, it } from "vitest";

import { calculateContentHash } from "../src/lib/content-hash";
import { EXPECTED_FIXTURE_CONTENT } from "./fixture";

describe("calculateContentHash", () => {
  it("returns a deterministic lowercase SHA-256 hash", () => {
    expect(calculateContentHash(EXPECTED_FIXTURE_CONTENT)).toBe(
      "fb02a585186bfa72501da3517e2494d8341e8dbeb6e1cee0dd58811428e8cc5c",
    );
  });
});
