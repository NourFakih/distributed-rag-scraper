export interface EmbeddingProvider {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimension: number;

  embedPassage(content: string): Promise<number[]>;
  embedQuery(query: string): Promise<number[]>;
  embedPassages(contents: readonly string[]): Promise<number[][]>;
}

export class EmbeddingConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigurationError";
  }
}

export class EmbeddingModelLoadError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingModelLoadError";
  }
}

export class EmbeddingInferenceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingInferenceError";
  }
}
