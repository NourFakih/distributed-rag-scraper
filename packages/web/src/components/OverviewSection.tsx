import { useCallback, useEffect, useState } from "react";

import { getHealth } from "../api/client";

const pipeline = [
  "Crawl",
  "Extract",
  "Chunk",
  "Embed",
  "Search",
  "Grounded answer",
];

type HealthState = "checking" | "online" | "offline";

export function OverviewSection(): React.JSX.Element {
  const [health, setHealth] = useState<HealthState>("checking");

  const checkHealth = useCallback(async () => {
    setHealth("checking");
    try {
      const response = await getHealth();
      setHealth(response.data.status === "ok" ? "online" : "offline");
    } catch {
      setHealth("offline");
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  return (
    <section className="hero" id="overview" aria-labelledby="overview-title">
      <div className="hero-copy">
        <span className="eyebrow">Distributed knowledge pipeline</span>
        <h1 id="overview-title">Crawl, index, and question your sources.</h1>
        <p>
          Operate the complete retrieval workflow from one focused dashboard.
          Start a bounded crawl, inspect its progress, search indexed chunks,
          and request a grounded cited answer.
        </p>
        <div className="hero-actions" aria-label="Dashboard shortcuts">
          <a className="button button-primary" href="#crawl">Start a crawl</a>
          <a className="button button-secondary" href="#search">Search index</a>
          <a className="button button-secondary" href="#ask">Ask a question</a>
        </div>
      </div>
      <aside className="health-card" aria-live="polite">
        <div>
          <span className={`health-dot health-${health}`} aria-hidden="true" />
          <span className="health-label">API health</span>
        </div>
        <strong>{health === "checking" ? "Checking…" : health}</strong>
        {health === "offline" ? (
          <button className="text-button" type="button" onClick={() => void checkHealth()}>
            Check again
          </button>
        ) : null}
      </aside>
      <ol className="pipeline" aria-label="Indexing and retrieval pipeline">
        {pipeline.map((step, index) => (
          <li key={step}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}
