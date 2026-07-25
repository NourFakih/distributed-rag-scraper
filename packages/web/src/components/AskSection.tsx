import { type FormEvent, useState } from "react";

import { ApiError, askQuestion } from "../api/client";
import type { AskResponse } from "../api/types";
import { SectionHeading } from "./SectionHeading";

export function AskSection(): React.JSX.Element {
  const [question, setQuestion] = useState("");
  const [limit, setLimit] = useState(5);
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await askQuestion(question.trim(), limit));
    } catch (askError: unknown) {
      setError(
        askError instanceof ApiError || askError instanceof Error
          ? askError.message
          : "Grounded answering failed",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="dashboard-section" id="ask" aria-labelledby="ask-title">
      <SectionHeading
        eyebrow="03 · Answer"
        title="Ask with grounded citations"
        description="Retrieve semantically relevant chunks and generate a concise answer limited to indexed evidence."
      />
      <div className="ask-layout">
        <form className="panel form-panel ask-form" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="question">Question</label>
            <textarea
              id="question"
              required
              maxLength={2_000}
              rows={6}
              placeholder="What information does the indexed site provide about book prices?"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </div>
          <div className="field limit-field">
            <label htmlFor="ask-limit">Retrieval limit</label>
            <input
              id="ask-limit"
              type="number"
              min="1"
              max="10"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            />
          </div>
          <button className="button button-primary" type="submit" disabled={loading}>
            {loading ? "Building answer…" : "Ask indexed sources"}
          </button>
        </form>

        <div className="panel answer-panel" aria-live="polite">
          {error ? <div className="message message-error" role="alert">{error}</div> : null}
          {!answer && !error ? (
            <div className="empty-state">Your grounded answer and cited source chunks will appear here.</div>
          ) : null}
          {answer ? (
            <article>
              <div className="answer-meta">
                <span className={`status-badge ${answer.grounded ? "status-completed" : "status-retrying"}`}>
                  {answer.grounded ? "Grounded" : "Insufficient evidence"}
                </span>
                <span>{answer.retrieval.resultCount} retrieved sources</span>
                {answer.model ? <span>{answer.model.model}</span> : null}
              </div>
              <p className="answer-text">{answer.answer}</p>
              {answer.citations.length > 0 ? (
                <div className="citations">
                  <h3>Citations</h3>
                  <ol>
                    {answer.citations.map((citation) => (
                      <li key={`${citation.number}-${citation.chunkId}`}>
                        <div className="citation-number">[{citation.number}]</div>
                        <div>
                          <a href={citation.url} target="_blank" rel="noreferrer">
                            {citation.title ?? citation.url}
                          </a>
                          <p>{citation.excerpt}</p>
                          <span className="meta-label">
                            Chunk {citation.chunkIndex} · Similarity {citation.similarity.toFixed(3)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </article>
          ) : null}
        </div>
      </div>
    </section>
  );
}
