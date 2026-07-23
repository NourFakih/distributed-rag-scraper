import fs from "node:fs";
import path from "node:path";

export const EXPECTED_FIXTURE_CONTENT = [
  "Building a Reliable Static Pipeline",
  "A deterministic fixture makes scraper tests repeatable and safe.",
  "Normalization",
  "Meaningful blocks stay on separate lines, while extra whitespace collapses.",
  "Fetch one page.",
  "Clean, hash, and persist it.",
].join("\n");

export const FIXTURE_HTML = fs.readFileSync(
  path.join(__dirname, "fixtures", "static-page.html"),
  "utf8",
);

