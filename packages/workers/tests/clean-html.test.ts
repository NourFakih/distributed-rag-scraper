import { describe, expect, it } from "vitest";

import {
  cleanHtml,
  normalizeText,
} from "../src/processing/clean-html";
import { EXPECTED_FIXTURE_CONTENT, FIXTURE_HTML } from "./fixture";

describe("cleanHtml", () => {
  it("extracts deterministic readable blocks and removes boilerplate", () => {
    const result = cleanHtml(FIXTURE_HTML);

    expect(result).toEqual({
      title: "Deterministic Crawl Fixture",
      content: EXPECTED_FIXTURE_CONTENT,
    });
    expect(result.content).not.toContain("window.fixtureNoise");
    expect(result.content).not.toContain("Ignored navigation");
    expect(result.content).not.toContain("boilerplate");
    expect(result.content).not.toContain("footer");
  });

  it("falls back to article and its first heading", () => {
    expect(
      cleanHtml("<html><body><article><h1>Fallback title</h1><p>Text</p></article></body></html>"),
    ).toEqual({
      title: "Fallback title",
      content: "Fallback title\nText",
    });
  });

  it("normalizes non-breaking spaces and line whitespace", () => {
    expect(normalizeText(" one\u00a0  two \r\n \n three ")).toBe(
      "one two\nthree",
    );
  });
});
