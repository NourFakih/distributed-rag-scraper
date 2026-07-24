import { describe, expect, it } from "vitest";

import { discoverLinks } from "../src/scraping/link-discovery";

describe("discoverLinks", () => {
  it("resolves, normalizes, filters, and deduplicates links", () => {
    const links = discoverLinks(
      `
        <a href="/docs/child#one">child</a>
        <a href="https://example.com/docs/child#two">duplicate</a>
        <a href="">empty</a>
        <a href="https://outside.example/page">external</a>
        <a href="mailto:team@example.com">mail</a>
        <a href="tel:+123">telephone</a>
        <a href="javascript:void(0)">script</a>
        <a href="/manual.pdf">download extension</a>
        <a href="/export" download>download attribute</a>
        <a href="/private" rel="ugc nofollow">nofollow</a>
      `,
      "https://example.com/docs/index",
      "https://example.com",
    );

    expect(links).toEqual([
      {
        url: "https://example.com/docs/child",
        normalizedUrl: "https://example.com/docs/child",
      },
    ]);
  });

  it("uses a valid same-origin base URL", () => {
    const links = discoverLinks(
      '<base href="/guide/"><a href="chapter-one">chapter</a>',
      "https://example.com/docs/index",
      "https://example.com",
    );

    expect(links[0]?.normalizedUrl).toBe(
      "https://example.com/guide/chapter-one",
    );
  });

  it("ignores an external base URL and falls back to the final page URL", () => {
    const links = discoverLinks(
      '<base href="https://outside.example/"><a href="child">child</a>',
      "https://example.com/docs/index",
      "https://example.com",
    );

    expect(links[0]?.normalizedUrl).toBe(
      "https://example.com/docs/child",
    );
  });

  it("does not discover links when page-level robots metadata says nofollow", () => {
    const links = discoverLinks(
      '<meta name="robots" content="index, nofollow"><a href="/child">child</a>',
      "https://example.com/",
      "https://example.com",
    );

    expect(links).toEqual([]);
  });
});
