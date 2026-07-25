import { type FormEvent, useState } from "react";

import { ApiError, searchIndex } from "../api/client";
import type {
  SearchMode,
  SearchResponse,
} from "../api/types";
import { SectionHeading } from "./SectionHeading";

export function SearchSection(): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("semantic");
  const [limit, setLimit] = useState(5);
  const [response, setResponse] = useState<SearchResponse["data"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const result = await searchIndex(query.trim(), mode, limit);
      setResponse(result.data);
    } catch (searchError: unknown) {
      setError(
        searchError instanceof ApiError || searchError instanceof Error
          ? searchError.message
          : "Search failed",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="dashboard-section" id="search" aria-labelledby="search-title">
      <SectionHeading
        eyebrow="02 · Retrieve"
        title="Search indexed knowledge"
        description="Use semantic similarity for meaning or keyword relevance for exact indexed language."
      />
      <form className="search-form panel" onSubmit={(event) => void submit(event)}>
        <div className="field search-query-field">
          <label htmlFor="search-query">Search query</label>
          <input
            id="search-query"
            required
            maxLength={512}
            placeholder="How does the crawler handle robots.txt?"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="search-mode">Search mode</label>
          <select
            id="search-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as SearchMode)}
          >
            <option value="semantic">Semantic</option>
            <option value="keyword">Keyword</option>
          </select>
        </div>
        <div className="field limit-field">
          <label htmlFor="search-limit">Result limit</label>
          <input
            id="search-limit"
            type="number"
            min="1"
            max="20"
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          />
        </div>
        <button className="button button-primary" type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error ? <div className="message message-error results-message" role="alert">{error}</div> : null}
      {response && response.results.length === 0 ? (
        <div className="empty-state results-message">No indexed chunks matched this query.</div>
      ) : null}
      {response && response.results.length > 0 ? (
        <div className="results" aria-live="polite">
          <div className="results-heading">
            <p><strong>{response.resultCount}</strong> results</p>
            <span className="mode-pill">{response.mode}</span>
          </div>
          <ol className="result-list">
            {response.results.map((result, index) => (
              <li className="result-card" key={result.chunkId}>
                <div className="result-rank">{String(index + 1).padStart(2, "0")}</div>
                <div className="result-body">
                  <div className="result-title-row">
                    <h3>{result.title ?? "Untitled source"}</h3>
                    <span className="score">
                      {"similarity" in result
                        ? `Similarity ${result.similarity.toFixed(3)}`
                        : `Relevance ${result.relevance.toFixed(3)}`}
                    </span>
                  </div>
                  <a href={result.url} target="_blank" rel="noreferrer">{result.url}</a>
                  <p>{result.excerpt}</p>
                  <span className="meta-label">Chunk {result.chunkIndex}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
