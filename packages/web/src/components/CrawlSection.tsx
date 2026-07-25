import { type FormEvent, useEffect, useState } from "react";

import { ApiError, createCrawl, getCrawl } from "../api/client";
import type {
  CrawlDetailsResponse,
  RenderMode,
} from "../api/types";
import { SectionHeading } from "./SectionHeading";

const terminalStatuses = new Set(["COMPLETED", "FAILED"]);

function readableError(error: unknown): string {
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "The crawl request failed";
}

export function CrawlSection(): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState(25);
  const [maxDepth, setMaxDepth] = useState(2);
  const [renderMode, setRenderMode] = useState<RenderMode>("STATIC");
  const [existingId, setExistingId] = useState("");
  const [crawlId, setCrawlId] = useState<string | null>(null);
  const [crawl, setCrawl] = useState<CrawlDetailsResponse["data"] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!crawlId) {
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const response = await getCrawl(crawlId);
        if (cancelled) return;
        setCrawl(response.data);
        setError(null);
        if (!terminalStatuses.has(response.data.status)) {
          timer = window.setTimeout(() => void poll(), 2_000);
        }
      } catch (pollError: unknown) {
        if (!cancelled) setError(readableError(pollError));
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [crawlId]);

  const submitCrawl = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setCrawl(null);
    try {
      const response = await createCrawl({
        url,
        maxPages,
        maxDepth,
        renderMode,
      });
      setCrawlId(response.data.id);
      setExistingId(response.data.id);
    } catch (submitError: unknown) {
      setError(readableError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const inspectCrawl = (event: FormEvent) => {
    event.preventDefault();
    const id = existingId.trim();
    if (!id) return;
    setError(null);
    setCrawl(null);
    setCrawlId(id);
  };

  return (
    <section className="dashboard-section" id="crawl" aria-labelledby="crawl-title">
      <SectionHeading
        eyebrow="01 · Ingest"
        title="Launch a bounded crawl"
        description="Submit one origin for static or JavaScript rendering, then follow aggregate progress until completion."
      />
      <div className="two-column">
        <form className="panel form-panel" onSubmit={(event) => void submitCrawl(event)}>
          <div className="field field-wide">
            <label htmlFor="crawl-url">Seed URL</label>
            <input
              id="crawl-url"
              type="url"
              required
              placeholder="https://example.com/docs/"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="max-pages">Maximum pages</label>
              <input
                id="max-pages"
                type="number"
                min="1"
                max="500"
                value={maxPages}
                onChange={(event) => setMaxPages(Number(event.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="max-depth">Maximum depth</label>
              <input
                id="max-depth"
                type="number"
                min="0"
                max="10"
                value={maxDepth}
                onChange={(event) => setMaxDepth(Number(event.target.value))}
              />
            </div>
          </div>
          <fieldset className="field radio-group">
            <legend>Render mode</legend>
            <label>
              <input
                type="radio"
                name="render-mode"
                value="STATIC"
                checked={renderMode === "STATIC"}
                onChange={() => setRenderMode("STATIC")}
              />
              Static
            </label>
            <label>
              <input
                type="radio"
                name="render-mode"
                value="JAVASCRIPT"
                checked={renderMode === "JAVASCRIPT"}
                onChange={() => setRenderMode("JAVASCRIPT")}
              />
              JavaScript
            </label>
          </fieldset>
          <button className="button button-primary" type="submit" disabled={submitting}>
            {submitting ? "Queueing…" : "Start crawl"}
          </button>
        </form>

        <div className="panel status-panel">
          <form className="inspect-form" onSubmit={inspectCrawl}>
            <div className="field">
              <label htmlFor="crawl-id">Inspect an existing crawl ID</label>
              <div className="inline-control">
                <input
                  id="crawl-id"
                  value={existingId}
                  onChange={(event) => setExistingId(event.target.value)}
                  placeholder="UUID"
                />
                <button className="button button-secondary" type="submit">Inspect</button>
              </div>
            </div>
          </form>
          {error ? <div className="message message-error" role="alert">{error}</div> : null}
          {!crawl && crawlId && !error ? (
            <div className="message" role="status">Loading crawl {crawlId}…</div>
          ) : null}
          {!crawl && !crawlId && !error ? (
            <div className="empty-state">Submit a crawl or enter an existing ID to inspect progress.</div>
          ) : null}
          {crawl ? (
            <div className="crawl-summary" aria-live="polite">
              <div className="summary-heading">
                <div>
                  <span className="meta-label">Crawl ID</span>
                  <code>{crawl.id}</code>
                </div>
                <span className={`status-badge status-${crawl.status.toLowerCase()}`}>
                  {crawl.status}
                </span>
              </div>
              <a href={crawl.seedUrl} target="_blank" rel="noreferrer">{crawl.seedUrl}</a>
              <dl className="counter-grid">
                <div><dt>Discovered</dt><dd>{crawl.counters.discovered}</dd></div>
                <div><dt>Completed</dt><dd>{crawl.counters.completed}</dd></div>
                <div><dt>Skipped</dt><dd>{crawl.counters.skipped}</dd></div>
                <div><dt>Failed</dt><dd>{crawl.counters.failed}</dd></div>
              </dl>
              {crawl.completedWithFailures ? (
                <p className="message message-warning">Completed with one or more page failures.</p>
              ) : null}
              {crawl.errorMessage ? (
                <p className="message message-error">{crawl.errorMessage}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
