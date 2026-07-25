export type RenderMode = "STATIC" | "JAVASCRIPT";
export type CrawlStatus =
  | "QUEUED"
  | "PROCESSING"
  | "RETRYING"
  | "COMPLETED"
  | "FAILED";

export interface ApiHealth {
  data: {
    service: string;
    status: string;
  };
}

export interface CreateCrawlRequest {
  url: string;
  maxPages: number;
  maxDepth: number;
  renderMode: RenderMode;
}

export interface CreateCrawlResponse {
  data: {
    id: string;
    seedUrl: string;
    status: CrawlStatus;
    maxPages: number;
    maxDepth: number;
    renderMode: RenderMode;
    rootPageId: string;
    createdAt: string;
  };
}

export interface CrawlDetailsResponse {
  data: {
    id: string;
    seedUrl: string;
    normalizedOrigin: string;
    renderMode: RenderMode;
    status: CrawlStatus;
    limits: {
      maxPages: number;
      maxDepth: number;
    };
    counters: {
      discovered: number;
      completed: number;
      skipped: number;
      failed: number;
    };
    errorMessage: string | null;
    documentId: string | null;
    completedWithFailures: boolean;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  };
}

export type SearchMode = "semantic" | "keyword";

export interface SearchResultBase {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  url: string;
  title: string | null;
  excerpt: string;
}

export interface SemanticSearchResult extends SearchResultBase {
  similarity: number;
}

export interface KeywordSearchResult extends SearchResultBase {
  relevance: number;
}

export interface SearchResponse {
  data: {
    query: string;
    mode: SearchMode;
    resultCount: number;
    results: Array<SemanticSearchResult | KeywordSearchResult>;
    activeEmbeddingModel?: {
      id: string;
      version: string;
      dimension: number;
    };
  };
}

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
  citations: Array<{
    number: number;
    chunkId: string;
    documentId: string;
    chunkIndex: number;
    url: string;
    title: string | null;
    excerpt: string;
    similarity: number;
  }>;
}
