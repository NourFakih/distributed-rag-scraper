import { AskSection } from "./components/AskSection";
import { CrawlSection } from "./components/CrawlSection";
import { OverviewSection } from "./components/OverviewSection";
import { SearchSection } from "./components/SearchSection";

export function App(): React.JSX.Element {
  return (
    <>
      <header className="site-header">
        <a className="brand" href="#overview" aria-label="Distributed RAG Scraper home">
          <span className="brand-mark" aria-hidden="true">DR</span>
          <span>
            <strong>Distributed RAG</strong>
            <small>Scraper console</small>
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#crawl">Crawl</a>
          <a href="#search">Search</a>
          <a href="#ask">Ask</a>
        </nav>
      </header>
      <main>
        <OverviewSection />
        <CrawlSection />
        <SearchSection />
        <AskSection />
      </main>
      <footer>
        <p>Distributed ingestion, retrieval, and grounded answers.</p>
      </footer>
    </>
  );
}
