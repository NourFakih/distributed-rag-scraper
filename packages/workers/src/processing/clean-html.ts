import * as cheerio from "cheerio";

const REMOVED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "audio",
  "video",
  "picture",
  "object",
  "embed",
  "nav",
  "header",
  "footer",
  "aside",
].join(",");

const BLOCK_ELEMENTS = [
  "address",
  "article",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
].join(",");

export interface CleanedHtml {
  title: string | null;
  content: string;
}

export function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

export function cleanHtml(rawHtml: string): CleanedHtml {
  const $ = cheerio.load(rawHtml);
  const documentTitle = normalizeText($("title").first().text());

  $(REMOVED_ELEMENTS).remove();

  const main = $("main").first();
  const article = $("article").first();
  const body = $("body").first();
  const readableRoot = main.length
    ? main
    : article.length
      ? article
      : body;

  const headingTitle = normalizeText(readableRoot.find("h1").first().text());

  readableRoot
    .find("*")
    .addBack()
    .contents()
    .each((_index, node) => {
      if (node.type === "text") {
        node.data = node.data.replace(/\s+/g, " ");
      }
    });

  readableRoot.find("br").replaceWith("\n");
  readableRoot.find(BLOCK_ELEMENTS).each((_index, element) => {
    $(element).append("\n");
  });

  return {
    title: documentTitle || headingTitle || null,
    content: normalizeText(readableRoot.text()),
  };
}
