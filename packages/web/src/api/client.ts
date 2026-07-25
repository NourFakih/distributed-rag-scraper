import type {
  ApiHealth,
  AskResponse,
  CrawlDetailsResponse,
  CreateCrawlRequest,
  CreateCrawlResponse,
  SearchMode,
  SearchResponse,
} from "./types";

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL;
export const API_BASE_URL =
  configuredBaseUrl === undefined
    ? "http://localhost:3000"
    : configuredBaseUrl.trim().replace(/\/+$/u, "");

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiUrl(path: string): string {
  return API_BASE_URL === "" ? path : `${API_BASE_URL}${path}`;
}

function errorDetails(payload: unknown): {
  message: string;
  code?: string;
} {
  const candidate = payload as {
    error?: {
      message?: unknown;
      code?: unknown;
    };
  };
  return {
    message:
      typeof candidate.error?.message === "string"
        ? candidate.error.message
        : "The API request failed",
    ...(typeof candidate.error?.code === "string"
      ? { code: candidate.error.code }
      : {}),
  };
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(path), {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const details = errorDetails(payload);
      throw new ApiError(details.message, response.status, details.code);
    }
    return payload as T;
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("The API request timed out");
    }
    throw new ApiError(
      error instanceof Error
        ? error.message
        : "The API could not be reached",
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getHealth(): Promise<ApiHealth> {
  return request<ApiHealth>("/health", {}, 5_000);
}

export function createCrawl(
  input: CreateCrawlRequest,
): Promise<CreateCrawlResponse> {
  return request<CreateCrawlResponse>("/api/crawls", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getCrawl(id: string): Promise<CrawlDetailsResponse> {
  return request<CrawlDetailsResponse>(
    `/api/crawls/${encodeURIComponent(id)}`,
  );
}

export function searchIndex(
  query: string,
  mode: SearchMode,
  limit: number,
): Promise<SearchResponse> {
  const parameters = new URLSearchParams({
    q: query,
    mode,
    limit: String(limit),
  });
  return request<SearchResponse>(`/api/search?${parameters.toString()}`);
}

export function askQuestion(
  question: string,
  limit: number,
): Promise<AskResponse> {
  return request<AskResponse>(
    "/api/ask",
    {
      method: "POST",
      body: JSON.stringify({ question, limit }),
    },
    70_000,
  );
}
