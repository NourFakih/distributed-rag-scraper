export interface GroundingSource {
  number: number;
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  url: string;
  title: string | null;
  excerpt: string;
  similarity: number;
}

export interface GroundedGenerationInput {
  question: string;
  sources: GroundingSource[];
}

export interface GenerationProvider {
  readonly providerId: string;
  readonly modelId: string;

  generateGroundedAnswer(
    input: GroundedGenerationInput,
  ): Promise<string>;
}

export class GenerationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GenerationConfigurationError";
  }
}

export class GenerationTimeoutError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationTimeoutError";
  }
}

export class GenerationProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationProviderError";
  }
}

export class GenerationResponseError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationResponseError";
  }
}
