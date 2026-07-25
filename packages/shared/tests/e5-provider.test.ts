import { describe, expect, it, vi } from "vitest";

import {
  E5_EMBEDDING_DIMENSION,
  E5_MODEL_ID,
  E5_MODEL_VERSION,
  formatE5Passage,
  formatE5Query,
  MultilingualE5Provider,
} from "../src/embedding/e5-provider";
import {
  EmbeddingConfigurationError,
  EmbeddingInferenceError,
  EmbeddingModelLoadError,
} from "../src/embedding/embedding-provider";
import { normalizeEmbedding } from "../src/embedding/vector";

function tensor(rows: number[][]): {
  tolist: () => number[][];
} {
  return {
    tolist: () => rows,
  };
}

function unitVector(value = 1): number[] {
  return [
    value,
    ...Array.from(
      { length: E5_EMBEDDING_DIMENSION - 1 },
      () => 0,
    ),
  ];
}

describe("MultilingualE5Provider", () => {
  it("adds the required passage and query prefixes", () => {
    expect(formatE5Passage("content")).toBe("passage: content");
    expect(formatE5Query("question")).toBe("query: question");
  });

  it("avoids accidental double prefixes and applies the requested kind", () => {
    expect(formatE5Passage(" passage: content ")).toBe(
      "passage: content",
    );
    expect(formatE5Query("query: question")).toBe("query: question");
    expect(formatE5Query("passage: content")).toBe("query: content");
  });

  it("loads one lazy model pipeline and reuses it across calls", async () => {
    const inference = vi.fn(async (inputs: readonly string[]) =>
      tensor(inputs.map(() => unitVector())),
    );
    const loader = vi.fn(async () => inference);
    const provider = new MultilingualE5Provider({
      pipelineLoader: loader,
      batchSize: 2,
    });

    expect(loader).not.toHaveBeenCalled();
    await provider.embedPassage("first");
    await provider.embedQuery("second");

    expect(loader).toHaveBeenCalledTimes(1);
    expect(inference).toHaveBeenNthCalledWith(
      1,
      ["passage: first"],
      {
        pooling: "mean",
        normalize: true,
      },
    );
    expect(inference).toHaveBeenNthCalledWith(
      2,
      ["query: second"],
      {
        pooling: "mean",
        normalize: true,
      },
    );
    expect(provider.modelId).toBe(E5_MODEL_ID);
    expect(provider.modelVersion).toBe(E5_MODEL_VERSION);
  });

  it("normalizes finite vectors before returning them", async () => {
    const provider = new MultilingualE5Provider({
      pipelineLoader: async () => async () => tensor([unitVector(7)]),
    });

    const result = await provider.embedPassage("content");

    expect(result[0]).toBeCloseTo(1);
    expect(
      Math.sqrt(result.reduce((sum, value) => sum + value * value, 0)),
    ).toBeCloseTo(1);
  });

  it("rejects the wrong embedding dimension", async () => {
    const provider = new MultilingualE5Provider({
      pipelineLoader: async () => async () => tensor([[1, 0, 0]]),
    });

    await expect(provider.embedQuery("question")).rejects.toThrow(
      /dimension mismatch/u,
    );
  });

  it("rejects non-finite model output", async () => {
    const invalid = unitVector();
    invalid[10] = Number.NaN;
    const provider = new MultilingualE5Provider({
      pipelineLoader: async () => async () => tensor([invalid]),
    });

    await expect(provider.embedPassage("content")).rejects.toThrow(
      /non-finite/u,
    );
  });

  it("reports model loading failures clearly", async () => {
    const provider = new MultilingualE5Provider({
      pipelineLoader: async () => {
        throw new Error("cache unavailable");
      },
    });

    await expect(provider.embedQuery("question")).rejects.toBeInstanceOf(
      EmbeddingModelLoadError,
    );
  });

  it("validates provider configuration", () => {
    expect(
      () =>
        new MultilingualE5Provider({
          batchSize: 0,
        }),
    ).toThrow(EmbeddingConfigurationError);
  });
});

describe("normalizeEmbedding", () => {
  it("rejects zero-magnitude vectors", () => {
    expect(() =>
      normalizeEmbedding(
        Array.from({ length: E5_EMBEDDING_DIMENSION }, () => 0),
        E5_EMBEDDING_DIMENSION,
      ),
    ).toThrow(EmbeddingInferenceError);
  });
});
