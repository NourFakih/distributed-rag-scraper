import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  GenerationConfigurationError,
  GenerationResponseError,
  GenerationTimeoutError,
  type GenerationProvider,
} from "../src/generation/generation-provider";
import { formatGroundingSourceBlock } from "../src/generation/grounding-prompt";
import type { RagConfig } from "../src/generation/generation-config";
import {
  answerQuestion,
  buildBoundedGroundingSources,
  INSUFFICIENT_EVIDENCE_ANSWER,
  validateAnswerCitations,
} from "../src/services/ask.service";
import type {
  SemanticSearchResponse,
  SemanticSearchResult,
} from "../src/services/search.service";

const ragConfig: RagConfig = {
  minimumSimilarity: 0.75,
  maximumSourceCharacters: 100,
  maximumContextCharacters: 1_000,
};

function result(
  number: number,
  overrides: Partial<SemanticSearchResult> = {},
): SemanticSearchResult {
  return {
    chunkId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    documentId: `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    url: `https://example.com/page-${number}`,
    title: `Page ${number}`,
    chunkIndex: number - 1,
    excerpt: `Source ${number} content`,
    similarity: 0.9 - number / 100,
    ...overrides,
  };
}

function retrieval(
  results: SemanticSearchResult[],
): SemanticSearchResponse {
  return {
    query: "question",
    activeEmbeddingModel: {
      id: "fixture-e5",
      version: "fixture-v1",
      dimension: 384,
    },
    resultCount: results.length,
    results,
  };
}

function provider(answer = "Supported answer [1][2]."): {
  value: GenerationProvider;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(async () => answer);
  return {
    value: {
      providerId: "openai-compatible",
      modelId: "fixture-model",
      generateGroundedAnswer: generate,
    },
    generate,
  };
}

describe("answerQuestion", () => {
  it("reuses semantic search, preserves ordering, and returns cited sources", async () => {
    const search = vi.fn(async () =>
      retrieval([result(1), result(2)]),
    );
    const generation = provider(
      "Books cost $10 [2], based on the listing [1][2].",
    );

    const response = await answerQuestion("Book prices?", 5, {
      search,
      generationProvider: () => generation.value,
      ragConfig,
    });

    expect(search).toHaveBeenCalledWith("Book prices?", 5);
    expect(generation.generate).toHaveBeenCalledWith({
      question: "Book prices?",
      sources: [
        expect.objectContaining({
          number: 1,
          chunkId: result(1).chunkId,
        }),
        expect.objectContaining({
          number: 2,
          chunkId: result(2).chunkId,
        }),
      ],
    });
    expect(response).toEqual({
      question: "Book prices?",
      answer:
        "Books cost $10 [2], based on the listing [1][2].",
      grounded: true,
      model: {
        provider: "openai-compatible",
        model: "fixture-model",
      },
      retrieval: {
        requestedLimit: 5,
        resultCount: 2,
      },
      citations: [
        expect.objectContaining({
          number: 2,
          chunkId: result(2).chunkId,
        }),
        expect.objectContaining({
          number: 1,
          chunkId: result(1).chunkId,
        }),
      ],
    });
  });

  it("does not call generation for empty retrieval", async () => {
    const generation = provider();

    const response = await answerQuestion("Missing?", 5, {
      search: async () => retrieval([]),
      generationProvider: () => generation.value,
      ragConfig,
    });

    expect(generation.generate).not.toHaveBeenCalled();
    expect(response).toEqual({
      question: "Missing?",
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      grounded: false,
      model: null,
      retrieval: {
        requestedLimit: 5,
        resultCount: 0,
      },
      citations: [],
    });
  });

  it("filters low-similarity results before generation", async () => {
    const generation = provider("High evidence [1].");

    const response = await answerQuestion("Question?", 3, {
      search: async () =>
        retrieval([
          result(1, {
            similarity: 0.7,
          }),
          result(2, {
            similarity: 0.88,
          }),
        ]),
      generationProvider: () => generation.value,
      ragConfig,
    });

    expect(response.retrieval.resultCount).toBe(1);
    expect(generation.generate).toHaveBeenCalledWith({
      question: "Question?",
      sources: [
        expect.objectContaining({
          number: 1,
          chunkId: result(2).chunkId,
        }),
      ],
    });
  });

  it("returns structured metadata only for cited sources", async () => {
    const response = await answerQuestion("Question?", 3, {
      search: async () =>
        retrieval([result(1), result(2), result(3)]),
      generationProvider: () =>
        provider("Only the second source supports this [2].").value,
      ragConfig,
    });

    expect(response.retrieval.resultCount).toBe(3);
    expect(response.citations).toEqual([
      expect.objectContaining({
        number: 2,
        chunkId: result(2).chunkId,
      }),
    ]);
  });

  it("does not initialize generation when every result is below threshold", async () => {
    const getProvider = vi.fn(() => provider().value);

    const response = await answerQuestion("Question?", 5, {
      search: async () =>
        retrieval([
          result(1, {
            similarity: 0.2,
          }),
        ]),
      generationProvider: getProvider,
      ragConfig,
    });

    expect(getProvider).not.toHaveBeenCalled();
    expect(response.grounded).toBe(false);
  });

  it("maps configuration, timeout, malformed, and retrieval failures", async () => {
    const usableSearch = async () => retrieval([result(1)]);
    const configurationFailure = answerQuestion("Question?", 5, {
      search: usableSearch,
      generationProvider: () => {
        throw new GenerationConfigurationError("missing");
      },
      ragConfig,
    });
    const timeoutFailure = answerQuestion("Question?", 5, {
      search: usableSearch,
      generationProvider: () =>
        ({
          ...provider().value,
          generateGroundedAnswer: async () => {
            throw new GenerationTimeoutError("timeout");
          },
        }) satisfies GenerationProvider,
      ragConfig,
    });
    const malformedFailure = answerQuestion("Question?", 5, {
      search: usableSearch,
      generationProvider: () =>
        ({
          ...provider().value,
          generateGroundedAnswer: async () => {
            throw new GenerationResponseError("malformed");
          },
        }) satisfies GenerationProvider,
      ragConfig,
    });
    const retrievalFailure = answerQuestion("Question?", 5, {
      search: async () => {
        throw new Error("database unavailable");
      },
      ragConfig,
    });

    await expect(configurationFailure).rejects.toMatchObject({
      status: 503,
      code: "GENERATION_UNAVAILABLE",
    });
    await expect(timeoutFailure).rejects.toMatchObject({
      status: 504,
      code: "GENERATION_TIMEOUT",
    });
    await expect(malformedFailure).rejects.toMatchObject({
      status: 502,
      code: "GENERATION_FAILED",
    });
    await expect(retrievalFailure).rejects.toMatchObject({
      status: 503,
      code: "RETRIEVAL_UNAVAILABLE",
    });
  });

  it("rejects an empty or uncited generated answer", async () => {
    await expect(
      answerQuestion("Question?", 5, {
        search: async () => retrieval([result(1)]),
        generationProvider: () => provider("No citation").value,
        ragConfig,
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "GENERATION_FAILED",
    });
  });
});

describe("grounding and citations", () => {
  it("bounds each source and total serialized context", () => {
    const sources = buildBoundedGroundingSources(
      [
        result(1, {
          excerpt: "a".repeat(500),
        }),
        result(2, {
          excerpt: "b".repeat(500),
        }),
      ],
      {
        minimumSimilarity: 0,
        maximumSourceCharacters: 100,
        maximumContextCharacters: 250,
      },
    );

    expect(sources[0]?.excerpt.length).toBeLessThanOrEqual(100);
    expect(
      sources.map(formatGroundingSourceBlock).join("\n\n").length,
    ).toBeLessThanOrEqual(250);
  });

  it("deduplicates valid citations and removes invalid markers safely", () => {
    expect(
      validateAnswerCitations(
        "Supported [2], repeated [2], first [1], invalid [99].",
        2,
      ),
    ).toEqual({
      answer: "Supported [2], repeated [2], first [1], invalid.",
      citationNumbers: [2, 1],
    });
  });
});
