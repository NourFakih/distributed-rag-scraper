import * as cheerio from "cheerio";
import { z } from "zod";

import { normalizeText } from "./clean-html";

export const MAX_TABLES_PER_PAGE = 20;
export const MAX_ROWS_PER_TABLE = 200;
export const MAX_CELLS_PER_ROW = 30;
export const MAX_CHARACTERS_PER_CELL = 1_000;

const boundedTextSchema = z.string().max(MAX_CHARACTERS_PER_CELL);

export const structuredContentSchema = z
  .object({
    tables: z
      .array(
        z
          .object({
            caption: boundedTextSchema.nullable(),
            headers: z
              .array(boundedTextSchema)
              .max(MAX_CELLS_PER_ROW),
            rows: z
              .array(
                z
                  .array(boundedTextSchema)
                  .max(MAX_CELLS_PER_ROW),
              )
              .max(MAX_ROWS_PER_TABLE),
          })
          .strict(),
      )
      .max(MAX_TABLES_PER_PAGE),
  })
  .strict();

export type StructuredContent = z.infer<typeof structuredContentSchema>;

function boundedText(value: string): string {
  return normalizeText(value).slice(0, MAX_CHARACTERS_PER_CELL);
}

export function extractStructuredContent(
  rawHtml: string,
): StructuredContent {
  const $ = cheerio.load(rawHtml);
  const tables: StructuredContent["tables"] = [];

  $("table")
    .slice(0, MAX_TABLES_PER_PAGE)
    .each((_tableIndex, tableElement) => {
      const table = $(tableElement);
      const tableRows = table.find("tr").filter((_rowIndex, row) =>
        $(row).closest("table").is(tableElement),
      );
      const tableHead = table.children("thead").first();
      const headerRow = tableHead.length
        ? tableRows
            .filter((_rowIndex, row) =>
              $(row).closest("thead").is(tableHead),
            )
            .first()
        : tableRows
            .filter((_rowIndex, row) =>
              $(row).children("th").length > 0,
            )
            .first();

      const readCells = (row: typeof headerRow): string[] =>
        row
          .children("th, td")
          .slice(0, MAX_CELLS_PER_ROW)
          .toArray()
          .map((cell) => boundedText($(cell).text()));

      const headers = headerRow.length
        ? readCells(headerRow)
        : [];
      const rows: string[][] = [];

      tableRows.each((_rowIndex, row) => {
        if (rows.length >= MAX_ROWS_PER_TABLE) {
          return false;
        }
        if (headerRow.length && headerRow.is(row)) {
          return;
        }

        const cells = readCells($(row));
        if (cells.some((cell) => cell.length > 0)) {
          rows.push(cells);
        }
      });

      const caption = boundedText(table.children("caption").first().text());
      tables.push({
        caption: caption || null,
        headers,
        rows,
      });
    });

  return structuredContentSchema.parse({ tables });
}

export function serializeStructuredContent(
  structuredContent: StructuredContent,
): string {
  if (structuredContent.tables.length === 0) {
    return "";
  }

  const serializedTables = structuredContent.tables.map((table, index) => {
    const lines = [
      `Table ${index + 1}${table.caption ? `: ${table.caption}` : ""}`,
    ];
    if (table.headers.length > 0) {
      lines.push(table.headers.join(" | "));
    }
    lines.push(...table.rows.map((row) => row.join(" | ")));
    return lines.join("\n");
  });

  return `Structured tables:\n${serializedTables.join("\n\n")}`;
}
