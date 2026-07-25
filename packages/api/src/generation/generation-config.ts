import { GenerationConfigurationError } from "./generation-provider";

export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const MIN_LLM_TIMEOUT_MS = 1_000;
export const MAX_LLM_TIMEOUT_MS = 120_000;
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 500;
export const MAX_LLM_OUTPUT_TOKENS = 2_000;
export const DEFAULT_RAG_MIN_SIMILARITY = 0.75;
export const DEFAULT_RAG_MAX_SOURCE_CHARACTERS = 1_500;
export const DEFAULT_RAG_MAX_CONTEXT_CHARACTERS = 8_000;

export interface GenerationConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface RagConfig {
  minimumSimilarity: number;
  maximumSourceCharacters: number;
  maximumContextCharacters: number;
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
  maximumLength: number,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new GenerationConfigurationError(`${name} is required`);
  }
  if (value.length > maximumLength) {
    throw new GenerationConfigurationError(
      `${name} must not exceed ${maximumLength} characters`,
    );
  }
  return value;
}

function integer(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new GenerationConfigurationError(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new GenerationConfigurationError(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function baseUrl(environment: NodeJS.ProcessEnv): string {
  const raw = required(environment, "LLM_BASE_URL", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GenerationConfigurationError(
      "LLM_BASE_URL must be an absolute HTTP or HTTPS URL",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new GenerationConfigurationError(
      "LLM_BASE_URL must be an absolute HTTP or HTTPS URL without credentials, query parameters, or a fragment",
    );
  }
  return parsed.toString().replace(/\/+$/u, "");
}

export function loadGenerationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GenerationConfig {
  return {
    baseUrl: baseUrl(environment),
    apiKey: required(environment, "LLM_API_KEY", 4_096),
    model: required(environment, "LLM_MODEL", 255),
    timeoutMs: integer(
      environment.LLM_TIMEOUT_MS,
      "LLM_TIMEOUT_MS",
      DEFAULT_LLM_TIMEOUT_MS,
      MIN_LLM_TIMEOUT_MS,
      MAX_LLM_TIMEOUT_MS,
    ),
    maxOutputTokens: integer(
      environment.LLM_MAX_OUTPUT_TOKENS,
      "LLM_MAX_OUTPUT_TOKENS",
      DEFAULT_LLM_MAX_OUTPUT_TOKENS,
      1,
      MAX_LLM_OUTPUT_TOKENS,
    ),
  };
}

function similarityThreshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RAG_MIN_SIMILARITY;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new GenerationConfigurationError(
      "RAG_MIN_SIMILARITY must be a finite number from -1 through 1",
    );
  }
  return value;
}

export function loadRagConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RagConfig {
  const maximumSourceCharacters = integer(
    environment.RAG_MAX_SOURCE_CHARACTERS,
    "RAG_MAX_SOURCE_CHARACTERS",
    DEFAULT_RAG_MAX_SOURCE_CHARACTERS,
    100,
    10_000,
  );
  const maximumContextCharacters = integer(
    environment.RAG_MAX_CONTEXT_CHARACTERS,
    "RAG_MAX_CONTEXT_CHARACTERS",
    DEFAULT_RAG_MAX_CONTEXT_CHARACTERS,
    500,
    50_000,
  );
  if (maximumSourceCharacters > maximumContextCharacters) {
    throw new GenerationConfigurationError(
      "RAG_MAX_SOURCE_CHARACTERS must not exceed RAG_MAX_CONTEXT_CHARACTERS",
    );
  }

  return {
    minimumSimilarity: similarityThreshold(
      environment.RAG_MIN_SIMILARITY,
    ),
    maximumSourceCharacters,
    maximumContextCharacters,
  };
}
