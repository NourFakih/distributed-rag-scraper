import { describe, expect, it } from "vitest";

import {
  MAX_CELLS_PER_ROW,
  MAX_CHARACTERS_PER_CELL,
  MAX_ROWS_PER_TABLE,
  MAX_TABLES_PER_PAGE,
  extractStructuredContent,
} from "../src/processing/extract-structured-content";
import { processPageSource } from "../src/processing/process-page";

const BOOK_INVENTORY_HTML = `
  <main>
    <h1>Book inventory</h1>
    <p>This page lists current inventory.</p>
    <table>
      <caption>Available books</caption>
      <thead>
        <tr>
          <th>Title</th>
          <th>Price</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Security Engineering</td>
          <td>$45</td>
          <td>Available</td>
        </tr>
        <tr>
          <td>Distributed Systems</td>
          <td>$55</td>
          <td>Available</td>
        </tr>
        <tr><td> </td><td> </td><td> </td></tr>
      </tbody>
    </table>
  </main>
`;

function pageSource(rawHtml: string) {
  return {
    url: "https://example.com/books",
    title: null,
    rawHtml,
    httpStatus: 200,
    headers: { "content-type": "text/html" },
    contentType: "text/html",
    fetchedAt: new Date("2026-07-26T10:00:00.000Z"),
  };
}

describe("extractStructuredContent", () => {
  it("extracts a table caption, header, and rows", () => {
    expect(extractStructuredContent(BOOK_INVENTORY_HTML)).toEqual({
      tables: [
        {
          caption: "Available books",
          headers: ["Title", "Price", "Status"],
          rows: [
            ["Security Engineering", "$45", "Available"],
            ["Distributed Systems", "$55", "Available"],
          ],
        },
      ],
    });
  });

  it("appends a readable table serialization to retrieval content", () => {
    const result = processPageSource(pageSource(BOOK_INVENTORY_HTML));

    expect(result.content).toContain(
      "Book inventory\nThis page lists current inventory.",
    );
    expect(result.content).toContain(
      [
        "Structured tables:",
        "Table 1: Available books",
        "Title | Price | Status",
        "Security Engineering | $45 | Available",
        "Distributed Systems | $55 | Available",
      ].join("\n"),
    );
    expect(result.structuredData.tables).toHaveLength(1);
  });

  it("returns an empty table list without appending an empty section", () => {
    const rawHtml = "<main><p>Paragraph only.</p></main>";

    expect(extractStructuredContent(rawHtml)).toEqual({ tables: [] });
    expect(processPageSource(pageSource(rawHtml))).toMatchObject({
      content: "Paragraph only.",
      structuredData: { tables: [] },
    });
  });

  it("uses the first th row when a table has no thead and handles no header", () => {
    const result = extractStructuredContent(`
      <table>
        <tr><td>intro</td></tr>
        <tr><th>Name</th><th>Value</th></tr>
        <tr><td>alpha</td><td>one</td></tr>
      </table>
      <table><tr><td>headerless value</td></tr></table>
    `);

    expect(result.tables[0]).toEqual({
      caption: null,
      headers: ["Name", "Value"],
      rows: [["intro"], ["alpha", "one"]],
    });
    expect(result.tables[1]).toEqual({
      caption: null,
      headers: [],
      rows: [["headerless value"]],
    });
  });

  it("applies table, row, cell, and character limits", () => {
    const firstRow = `<tr>${Array.from(
      { length: MAX_CELLS_PER_ROW + 1 },
      (_value, index) =>
        `<td>${index === 0 ? "x".repeat(MAX_CHARACTERS_PER_CELL + 1) : index}</td>`,
    ).join("")}</tr>`;
    const remainingRows = Array.from(
      { length: MAX_ROWS_PER_TABLE },
      (_value, index) => `<tr><td>row ${index + 2}</td></tr>`,
    ).join("");
    const tables = Array.from(
      { length: MAX_TABLES_PER_PAGE + 1 },
      (_value, index) =>
        index === 0
          ? `<table>${firstRow}${remainingRows}</table>`
          : `<table><tr><td>table ${index + 1}</td></tr></table>`,
    ).join("");

    const result = extractStructuredContent(tables);

    expect(result.tables).toHaveLength(MAX_TABLES_PER_PAGE);
    expect(result.tables[0]?.rows).toHaveLength(MAX_ROWS_PER_TABLE);
    expect(result.tables[0]?.rows[0]).toHaveLength(MAX_CELLS_PER_ROW);
    expect(result.tables[0]?.rows[0]?.[0]).toHaveLength(
      MAX_CHARACTERS_PER_CELL,
    );
  });
});
