import { calculateContentHash } from "../lib/content-hash";

export const DOCUMENT_CHUNK_TARGET_SIZE = 1_000;
export const DOCUMENT_CHUNK_OVERLAP = 150;

const MINIMUM_END_BOUNDARY_RATIO = 0.7;
const MAXIMUM_START_BOUNDARY_RADIUS = 75;

export interface DocumentChunk {
  chunkIndex: number;
  content: string;
  contentHash: string;
  startOffset: number;
  endOffset: number;
}

export interface ChunkTextOptions {
  targetSize?: number;
  overlap?: number;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function avoidsSplittingSurrogatePair(
  content: string,
  offset: number,
): number {
  if (offset <= 0 || offset >= content.length) {
    return offset;
  }

  const previous = content.charCodeAt(offset - 1);
  const current = content.charCodeAt(offset);
  const splitsPair =
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff;
  return splitsPair ? offset - 1 : offset;
}

function trimStart(
  content: string,
  startOffset: number,
  endOffset: number,
): number {
  let offset = startOffset;
  while (offset < endOffset && isWhitespace(content[offset])) {
    offset += 1;
  }
  return offset;
}

function trimEnd(
  content: string,
  startOffset: number,
  endOffset: number,
): number {
  let offset = endOffset;
  while (offset > startOffset && isWhitespace(content[offset - 1])) {
    offset -= 1;
  }
  return offset;
}

function preferredEndOffset(
  content: string,
  startOffset: number,
  targetSize: number,
): number {
  const hardEnd = Math.min(content.length, startOffset + targetSize);
  if (hardEnd === content.length) {
    return hardEnd;
  }

  const minimumBoundary = Math.min(
    hardEnd - 1,
    startOffset + Math.floor(targetSize * MINIMUM_END_BOUNDARY_RATIO),
  );
  const paragraphBoundary = content.lastIndexOf("\n\n", hardEnd - 1);
  if (paragraphBoundary >= minimumBoundary) {
    return paragraphBoundary;
  }

  const lineBoundary = content.lastIndexOf("\n", hardEnd - 1);
  if (lineBoundary >= minimumBoundary) {
    return lineBoundary;
  }

  for (let offset = hardEnd - 1; offset >= minimumBoundary; offset -= 1) {
    if (isWhitespace(content[offset])) {
      return offset;
    }
  }

  return avoidsSplittingSurrogatePair(content, hardEnd);
}

type StartBoundary = "paragraph" | "line" | "whitespace";

function isStartBoundary(
  content: string,
  offset: number,
  boundary: StartBoundary,
): boolean {
  if (boundary === "paragraph") {
    return content.slice(offset - 2, offset) === "\n\n";
  }
  if (boundary === "line") {
    return content[offset - 1] === "\n";
  }
  return isWhitespace(content[offset - 1]);
}

function nearestStartBoundary(
  content: string,
  idealOffset: number,
  minimumOffset: number,
  maximumOffset: number,
  boundary: StartBoundary,
): number | undefined {
  const maximumDistance = Math.max(
    idealOffset - minimumOffset,
    maximumOffset - idealOffset,
  );

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    const forward = idealOffset + distance;
    if (
      forward <= maximumOffset &&
      isStartBoundary(content, forward, boundary)
    ) {
      return forward;
    }

    const backward = idealOffset - distance;
    if (
      distance > 0 &&
      backward >= minimumOffset &&
      isStartBoundary(content, backward, boundary)
    ) {
      return backward;
    }
  }

  return undefined;
}

function preferredNextStart(
  content: string,
  previousStart: number,
  previousEnd: number,
  overlap: number,
): number {
  if (overlap === 0) {
    return previousEnd;
  }

  const idealOffset = Math.max(
    previousStart + 1,
    previousEnd - overlap,
  );
  const radius = Math.max(
    1,
    Math.min(MAXIMUM_START_BOUNDARY_RADIUS, Math.floor(overlap / 3)),
  );
  const minimumOffset = Math.max(previousStart + 1, idealOffset - radius);
  const maximumOffset = Math.min(previousEnd - 1, idealOffset + radius);

  for (const boundary of [
    "paragraph",
    "line",
    "whitespace",
  ] as const) {
    const offset = nearestStartBoundary(
      content,
      idealOffset,
      minimumOffset,
      maximumOffset,
      boundary,
    );
    if (offset !== undefined) {
      return offset;
    }
  }

  return avoidsSplittingSurrogatePair(content, idealOffset);
}

function validateOptions(targetSize: number, overlap: number): void {
  if (!Number.isInteger(targetSize) || targetSize < 1) {
    throw new RangeError("Chunk target size must be a positive integer");
  }
  if (
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= targetSize
  ) {
    throw new RangeError(
      "Chunk overlap must be a non-negative integer smaller than target size",
    );
  }
}

export function chunkText(
  content: string,
  options: ChunkTextOptions = {},
): DocumentChunk[] {
  const targetSize =
    options.targetSize ?? DOCUMENT_CHUNK_TARGET_SIZE;
  const overlap = options.overlap ?? DOCUMENT_CHUNK_OVERLAP;
  validateOptions(targetSize, overlap);

  let cursor = trimStart(content, 0, content.length);
  if (cursor === content.length) {
    return [];
  }

  const chunks: DocumentChunk[] = [];
  while (cursor < content.length) {
    const rawEnd = preferredEndOffset(content, cursor, targetSize);
    const startOffset = trimStart(content, cursor, rawEnd);
    const endOffset = trimEnd(content, startOffset, rawEnd);

    if (endOffset > startOffset) {
      const chunkContent = content.slice(startOffset, endOffset);
      chunks.push({
        chunkIndex: chunks.length,
        content: chunkContent,
        contentHash: calculateContentHash(chunkContent),
        startOffset,
        endOffset,
      });
    }

    if (rawEnd >= content.length) {
      break;
    }

    let nextCursor = preferredNextStart(
      content,
      startOffset,
      endOffset,
      overlap,
    );
    nextCursor = trimStart(content, nextCursor, content.length);
    if (nextCursor <= cursor) {
      nextCursor = Math.min(
        rawEnd,
        cursor + Math.max(1, targetSize - overlap),
      );
    }
    cursor = nextCursor;
  }

  return chunks;
}
