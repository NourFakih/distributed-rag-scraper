import { CrawlFailure } from "../errors/crawl-failure";
import { cleanHtml } from "./clean-html";
import {
  extractStructuredContent,
  serializeStructuredContent,
  type StructuredContent,
} from "./extract-structured-content";

export interface PageSource {
  url: string;
  title: string | null;
  rawHtml: string;
  httpStatus: number;
  headers: Record<string, string | undefined>;
  contentType: string | null;
  fetchedAt: Date;
}

export interface ProcessedPage extends PageSource {
  content: string;
  structuredData: StructuredContent;
}

export function processPageSource(source: PageSource): ProcessedPage {
  const cleaned = cleanHtml(source.rawHtml);
  if (!cleaned.content) {
    throw new CrawlFailure(
      "EMPTY_CONTENT",
      "Crawl page did not contain readable content",
      false,
    );
  }
  const structuredData = extractStructuredContent(source.rawHtml);
  const serializedStructuredData =
    serializeStructuredContent(structuredData);

  return {
    ...source,
    title: cleaned.title ?? source.title,
    content: serializedStructuredData
      ? `${cleaned.content}\n\n${serializedStructuredData}`
      : cleaned.content,
    structuredData,
  };
}
