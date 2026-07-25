import { describe, expect, it } from "vitest";

import { calculateContentHash } from "../src/lib/content-hash";
import {
  chunkText,
  DOCUMENT_CHUNK_OVERLAP,
  DOCUMENT_CHUNK_TARGET_SIZE,
} from "../src/processing/chunk-text";

describe("chunkText", () => {
  it.each(["", "   \n\t  "])("returns no chunks for empty content", (content) => {
    expect(chunkText(content)).toEqual([]);
  });

  it("returns one indexed and hashed chunk for short content", () => {
    const content = "A short deterministic document.";

    expect(chunkText(content)).toEqual([
      {
        chunkIndex: 0,
        content,
        contentHash: calculateContentHash(content),
        startOffset: 0,
        endOffset: content.length,
      },
    ]);
  });

  it("splits long content near the target at natural boundaries", () => {
    const content = Array.from(
      { length: 80 },
      (_value, index) =>
        `Paragraph ${index}: ${"deterministic ".repeat(5).trim()}`,
    ).join("\n");
    const chunks = chunkText(content);

    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.chunkIndex).toBe(index);
      expect(chunk.content).toBe(
        content.slice(chunk.startOffset, chunk.endOffset),
      );
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.content.length).toBeLessThanOrEqual(
        DOCUMENT_CHUNK_TARGET_SIZE,
      );
      expect(chunk.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(chunks[0]?.content.endsWith("deterministic")).toBe(true);
  });

  it("keeps approximately the configured overlap between chunks", () => {
    const content = Array.from(
      { length: 400 },
      (_value, index) => `word-${index.toString().padStart(3, "0")}`,
    ).join(" ");
    const chunks = chunkText(content);

    expect(chunks.length).toBeGreaterThan(2);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]!;
      const current = chunks[index]!;
      const overlap = previous.endOffset - current.startOffset;
      expect(overlap).toBeGreaterThanOrEqual(
        DOCUMENT_CHUNK_OVERLAP - 50,
      );
      expect(overlap).toBeLessThanOrEqual(
        DOCUMENT_CHUNK_OVERLAP + 50,
      );
    }
  });

  it("returns identical chunks and hashes for identical content", () => {
    const content = Array.from(
      { length: 120 },
      (_value, index) => `Stable paragraph ${index}.`,
    ).join("\n\n");

    expect(chunkText(content)).toEqual(chunkText(content));
  });
});
