import path from "node:path";

import {
  EmbeddingConfigurationError,
  EmbeddingInferenceError,
  EmbeddingModelLoadError,
  type EmbeddingProvider,
} from "./embedding-provider";
import { normalizeEmbedding } from "./vector";

export const E5_MODEL_ID = "intfloat/multilingual-e5-small";
export const E5_MODEL_REVISION =
  "614241f622f53c4eeff9890bdc4f31cfecc418b3";
export const E5_INFERENCE_LIBRARY_VERSION = "4.2.0";
export const E5_EMBEDDING_DIMENSION = 384;
export const E5_MODEL_VERSION =
  `hf:${E5_MODEL_REVISION}|transformers.js:${E5_INFERENCE_LIBRARY_VERSION}|fp32|mean|l2:v1`;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
export const MAX_EMBEDDING_BATCH_SIZE = 64;

type FeatureExtractor = (
  inputs: readonly string[],
  options: {
    pooling: "mean";
    normalize: true;
  },
) => Promise<unknown>;

export type E5PipelineLoader = () => Promise<FeatureExtractor>;

export interface E5EmbeddingProviderOptions {
  batchSize?: number;
  pipelineLoader?: E5PipelineLoader;
}

function boundedBatchSize(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_EMBEDDING_BATCH_SIZE
  ) {
    throw new EmbeddingConfigurationError(
      `Embedding batch size must be an integer from 1 through ${MAX_EMBEDDING_BATCH_SIZE}`,
    );
  }
  return value;
}

function configuredBatchSize(): number {
  const raw = process.env.EMBEDDING_BATCH_SIZE;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_EMBEDDING_BATCH_SIZE;
  }
  return boundedBatchSize(Number(raw));
}

function allowRemoteModels(): boolean {
  const raw = process.env.EMBEDDING_ALLOW_REMOTE_MODELS;
  if (raw === undefined || raw === "") {
    return true;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new EmbeddingConfigurationError(
    "EMBEDDING_ALLOW_REMOTE_MODELS must be true or false",
  );
}

function modelCacheDirectory(): string {
  const configured = process.env.MODEL_CACHE_DIR?.trim();
  return configured && configured.length > 0
    ? path.resolve(configured)
    : path.resolve(".cache", "huggingface");
}

async function loadTransformersPipeline(): Promise<FeatureExtractor> {
  try {
    const transformers = await import("@huggingface/transformers");
    transformers.env.cacheDir = modelCacheDirectory();
    transformers.env.allowRemoteModels = allowRemoteModels();
    const extractor = await transformers.pipeline(
      "feature-extraction",
      E5_MODEL_ID,
      {
        revision: E5_MODEL_REVISION,
        dtype: "fp32",
      },
    );

    return async (inputs, options) => extractor([...inputs], options);
  } catch (error: unknown) {
    if (error instanceof EmbeddingConfigurationError) {
      throw error;
    }
    throw new EmbeddingModelLoadError(
      `Unable to load ${E5_MODEL_ID} at revision ${E5_MODEL_REVISION}. Check MODEL_CACHE_DIR and EMBEDDING_ALLOW_REMOTE_MODELS.`,
      { cause: error },
    );
  }
}

function withoutE5Prefix(value: string): string {
  return value.trim().replace(/^(?:passage|query):\s*/iu, "");
}

export function formatE5Passage(value: string): string {
  return `passage: ${withoutE5Prefix(value)}`;
}

export function formatE5Query(value: string): string {
  return `query: ${withoutE5Prefix(value)}`;
}

function outputRows(output: unknown): number[][] {
  const candidate = output as {
    tolist?: () => unknown;
  };
  if (typeof candidate.tolist !== "function") {
    throw new EmbeddingInferenceError(
      "Embedding model returned an unsupported tensor result",
    );
  }

  const listed = candidate.tolist();
  if (!Array.isArray(listed)) {
    throw new EmbeddingInferenceError(
      "Embedding model returned an invalid tensor result",
    );
  }
  if (listed.length === 0) {
    return [];
  }
  if (listed.every((value) => typeof value === "number")) {
    return [listed as number[]];
  }
  if (
    !listed.every(
      (row) =>
        Array.isArray(row) &&
        row.every((value) => typeof value === "number"),
    )
  ) {
    throw new EmbeddingInferenceError(
      "Embedding model returned an invalid tensor shape",
    );
  }
  return listed as number[][];
}

export class MultilingualE5Provider implements EmbeddingProvider {
  public readonly modelId = E5_MODEL_ID;
  public readonly modelVersion = E5_MODEL_VERSION;
  public readonly dimension = E5_EMBEDDING_DIMENSION;

  private readonly batchSize: number;
  private readonly pipelineLoader: E5PipelineLoader;
  private pipelinePromise: Promise<FeatureExtractor> | undefined;

  public constructor(options: E5EmbeddingProviderOptions = {}) {
    this.batchSize = boundedBatchSize(
      options.batchSize ?? configuredBatchSize(),
    );
    this.pipelineLoader =
      options.pipelineLoader ?? loadTransformersPipeline;
  }

  private loadPipeline(): Promise<FeatureExtractor> {
    this.pipelinePromise ??= this.pipelineLoader().catch(
      (error: unknown) => {
        if (
          error instanceof EmbeddingConfigurationError ||
          error instanceof EmbeddingModelLoadError
        ) {
          throw error;
        }
        throw new EmbeddingModelLoadError(
          `Unable to initialize ${this.modelId}`,
          { cause: error },
        );
      },
    );
    return this.pipelinePromise;
  }

  private async embedFormatted(
    inputs: readonly string[],
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }

    const pipeline = await this.loadPipeline();
    const vectors: number[][] = [];
    for (let offset = 0; offset < inputs.length; offset += this.batchSize) {
      const batch = inputs.slice(offset, offset + this.batchSize);
      try {
        const output = await pipeline(batch, {
          pooling: "mean",
          normalize: true,
        });
        const rows = outputRows(output);
        if (rows.length !== batch.length) {
          throw new EmbeddingInferenceError(
            `Embedding batch size mismatch: expected ${batch.length}, received ${rows.length}`,
          );
        }
        vectors.push(
          ...rows.map((row) =>
            normalizeEmbedding(row, this.dimension),
          ),
        );
      } catch (error: unknown) {
        if (error instanceof EmbeddingInferenceError) {
          throw error;
        }
        throw new EmbeddingInferenceError(
          `Inference failed for ${this.modelId}`,
          { cause: error },
        );
      }
    }
    return vectors;
  }

  public async embedPassage(content: string): Promise<number[]> {
    const [vector] = await this.embedPassages([content]);
    if (!vector) {
      throw new EmbeddingInferenceError(
        "Passage embedding returned no vector",
      );
    }
    return vector;
  }

  public async embedQuery(query: string): Promise<number[]> {
    const [vector] = await this.embedFormatted([formatE5Query(query)]);
    if (!vector) {
      throw new EmbeddingInferenceError(
        "Query embedding returned no vector",
      );
    }
    return vector;
  }

  public embedPassages(
    contents: readonly string[],
  ): Promise<number[][]> {
    return this.embedFormatted(contents.map(formatE5Passage));
  }
}

let provider: MultilingualE5Provider | undefined;

export function getEmbeddingProvider(): MultilingualE5Provider {
  provider ??= new MultilingualE5Provider();
  return provider;
}

export function resetEmbeddingProviderForTests(): void {
  provider = undefined;
}
