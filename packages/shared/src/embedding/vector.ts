import {
  EmbeddingInferenceError,
} from "./embedding-provider";

export const NORMALIZED_VECTOR_TOLERANCE = 1e-5;

export function normalizeEmbedding(
  vector: readonly number[],
  expectedDimension: number,
): number[] {
  if (vector.length !== expectedDimension) {
    throw new EmbeddingInferenceError(
      `Embedding dimension mismatch: expected ${expectedDimension}, received ${vector.length}`,
    );
  }

  let squaredMagnitude = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new EmbeddingInferenceError(
        "Embedding contains a non-finite value",
      );
    }
    squaredMagnitude += value * value;
  }

  const magnitude = Math.sqrt(squaredMagnitude);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new EmbeddingInferenceError(
      "Embedding has zero or invalid magnitude",
    );
  }

  const normalized = vector.map((value) => value / magnitude);
  const normalizedMagnitude = Math.sqrt(
    normalized.reduce((sum, value) => sum + value * value, 0),
  );
  if (
    Math.abs(normalizedMagnitude - 1) >
    NORMALIZED_VECTOR_TOLERANCE
  ) {
    throw new EmbeddingInferenceError(
      "Embedding normalization did not produce a unit vector",
    );
  }

  return normalized;
}

export function embeddingToSqlVector(vector: readonly number[]): string {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new EmbeddingInferenceError(
      "Only non-empty finite embeddings can be stored",
    );
  }
  return `[${vector.join(",")}]`;
}
