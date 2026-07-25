import {
  GenerationConfigurationError,
  GenerationProviderError,
  GenerationResponseError,
  GenerationTimeoutError,
  type GenerationProvider,
  type GroundingSource,
} from "../generation/generation-provider";
import {
  getGenerationProvider,
} from "../generation/openai-compatible.provider";
import {
  formatGroundingSourceBlock,
} from "../generation/grounding-prompt";
import {
  loadRagConfig,
  type RagConfig,
} from "../generation/generation-config";
import { AppError } from "../middleware/error-handler";
import {
  semanticSearch,
  type SemanticSearchResult,
  type SemanticSearchResponse,
} from "./search.service";

export const INSUFFICIENT_EVIDENCE_ANSWER =
  "I could not find enough relevant information in the indexed documents to answer this question.";
export const MAX_GROUNDING_TITLE_CHARACTERS = 200;

export interface AskResponse {
  question: string;
  answer: string;
  grounded: boolean;
  model: {
    provider: string;
    model: string;
  } | null;
  retrieval: {
    requestedLimit: number;
    resultCount: number;
  };
  citations: GroundingSource[];
}

export interface AskServiceDependencies {
  search?: (
    question: string,
    limit: number,
  ) => Promise<SemanticSearchResponse>;
  generationProvider?: () => GenerationProvider;
  ragConfig?: RagConfig;
}

function title(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0
    ? null
    : normalized.slice(0, MAX_GROUNDING_TITLE_CHARACTERS);
}

export function buildBoundedGroundingSources(
  results: readonly SemanticSearchResult[],
  config: RagConfig,
): GroundingSource[] {
  const sources: GroundingSource[] = [];
  let contextCharacters = 0;

  for (const result of results) {
    if (
      !Number.isFinite(result.similarity) ||
      result.similarity < config.minimumSimilarity
    ) {
      continue;
    }
    const excerpt = result.excerpt
      .trim()
      .slice(0, config.maximumSourceCharacters);
    if (excerpt === "") {
      continue;
    }
    const source: GroundingSource = {
      number: sources.length + 1,
      chunkId: result.chunkId,
      documentId: result.documentId,
      chunkIndex: result.chunkIndex,
      url: result.url,
      title: title(result.title),
      excerpt,
      similarity: result.similarity,
    };
    const separatorLength = sources.length === 0 ? 0 : 2;
    const blockLength =
      separatorLength + formatGroundingSourceBlock(source).length;
    const remaining =
      config.maximumContextCharacters - contextCharacters;
    if (remaining <= 0) {
      break;
    }
    if (blockLength > remaining) {
      const overflow = blockLength - remaining;
      const boundedExcerpt = excerpt
        .slice(0, Math.max(0, excerpt.length - overflow))
        .trim();
      if (boundedExcerpt === "") {
        break;
      }
      source.excerpt = boundedExcerpt;
    }

    contextCharacters +=
      separatorLength + formatGroundingSourceBlock(source).length;
    sources.push(source);
  }

  return sources;
}

export interface ValidatedCitations {
  answer: string;
  citationNumbers: number[];
}

export function validateAnswerCitations(
  answer: string,
  sourceCount: number,
): ValidatedCitations {
  const citationNumbers: number[] = [];
  const seen = new Set<number>();
  const sanitized = answer.replace(
    /\[(\d+)\]/gu,
    (_marker, rawNumber: string) => {
      const number = Number(rawNumber);
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        number > sourceCount
      ) {
        return "";
      }
      if (!seen.has(number)) {
        seen.add(number);
        citationNumbers.push(number);
      }
      return `[${number}]`;
    },
  );

  return {
    answer: sanitized
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/[ \t]+([.,;:!?])/gu, "$1")
      .trim(),
    citationNumbers,
  };
}

function insufficientEvidence(
  question: string,
  requestedLimit: number,
): AskResponse {
  return {
    question,
    answer: INSUFFICIENT_EVIDENCE_ANSWER,
    grounded: false,
    model: null,
    retrieval: {
      requestedLimit,
      resultCount: 0,
    },
    citations: [],
  };
}

function configuredRag(
  dependencies: AskServiceDependencies,
): RagConfig {
  try {
    return dependencies.ragConfig ?? loadRagConfig();
  } catch (error: unknown) {
    if (error instanceof GenerationConfigurationError) {
      throw new AppError(
        503,
        "RAG_CONFIGURATION_ERROR",
        "Grounded answering is not configured correctly",
      );
    }
    throw error;
  }
}

export async function answerQuestion(
  question: string,
  limit: number,
  dependencies: AskServiceDependencies = {},
): Promise<AskResponse> {
  const ragConfig = configuredRag(dependencies);
  let retrieval: SemanticSearchResponse;
  try {
    retrieval = await (dependencies.search ?? semanticSearch)(
      question,
      limit,
    );
  } catch {
    throw new AppError(
      503,
      "RETRIEVAL_UNAVAILABLE",
      "Semantic retrieval is temporarily unavailable",
    );
  }

  const sources = buildBoundedGroundingSources(
    retrieval.results,
    ragConfig,
  );
  if (sources.length === 0) {
    return insufficientEvidence(question, limit);
  }

  let provider: GenerationProvider;
  try {
    provider =
      dependencies.generationProvider?.() ?? getGenerationProvider();
  } catch (error: unknown) {
    if (error instanceof GenerationConfigurationError) {
      throw new AppError(
        503,
        "GENERATION_UNAVAILABLE",
        "The generation provider is not configured",
      );
    }
    throw error;
  }

  let generatedAnswer: string;
  try {
    generatedAnswer = await provider.generateGroundedAnswer({
      question,
      sources,
    });
  } catch (error: unknown) {
    if (error instanceof GenerationTimeoutError) {
      throw new AppError(
        504,
        "GENERATION_TIMEOUT",
        "The generation provider timed out",
      );
    }
    if (
      error instanceof GenerationProviderError ||
      error instanceof GenerationResponseError
    ) {
      throw new AppError(
        502,
        "GENERATION_FAILED",
        "The generation provider could not produce a valid answer",
      );
    }
    throw error;
  }

  const validated = validateAnswerCitations(
    generatedAnswer,
    sources.length,
  );
  if (
    validated.answer === "" ||
    validated.citationNumbers.length === 0
  ) {
    throw new AppError(
      502,
      "GENERATION_FAILED",
      "The generation provider returned an uncited answer",
    );
  }
  const citations = validated.citationNumbers.map(
    (number) => sources[number - 1]!,
  );

  return {
    question,
    answer: validated.answer,
    grounded: true,
    model: {
      provider: provider.providerId,
      model: provider.modelId,
    },
    retrieval: {
      requestedLimit: limit,
      resultCount: sources.length,
    },
    citations,
  };
}
