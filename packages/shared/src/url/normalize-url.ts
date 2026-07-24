export const MAX_CRAWL_URL_LENGTH = 2_048;

const DOWNLOADABLE_EXTENSIONS = new Set([
  ".7z",
  ".apk",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".css",
  ".csv",
  ".doc",
  ".docx",
  ".dmg",
  ".epub",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".iso",
  ".jar",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".msi",
  ".ogg",
  ".ogv",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".rss",
  ".svg",
  ".tar",
  ".tgz",
  ".tif",
  ".tiff",
  ".tsv",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xml",
  ".xz",
  ".zip",
]);

export type UrlNormalizationErrorCode =
  | "EMPTY_URL"
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "CREDENTIALS_NOT_ALLOWED"
  | "URL_TOO_LONG"
  | "EXTERNAL_ORIGIN"
  | "DOWNLOADABLE_URL";

export class UrlNormalizationError extends Error {
  public constructor(
    public readonly code: UrlNormalizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UrlNormalizationError";
  }
}

export interface NormalizeCrawlUrlOptions {
  baseUrl?: string;
  allowedOrigin?: string;
  rejectDownloadable?: boolean;
}

function hasDownloadableExtension(url: URL): boolean {
  const pathname = url.pathname.toLowerCase();

  if (pathname.endsWith(".tar.gz")) {
    return true;
  }

  const finalSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const extensionStart = finalSegment.lastIndexOf(".");
  if (extensionStart === -1) {
    return false;
  }

  return DOWNLOADABLE_EXTENSIONS.has(finalSegment.slice(extensionStart));
}

export function normalizedOrigin(url: string): string {
  return new URL(url).origin;
}

export function normalizeCrawlUrl(
  input: string,
  options: NormalizeCrawlUrlOptions = {},
): string {
  const value = input.trim();
  if (!value) {
    throw new UrlNormalizationError("EMPTY_URL", "URL is required");
  }

  if (value.length > MAX_CRAWL_URL_LENGTH) {
    throw new UrlNormalizationError(
      "URL_TOO_LONG",
      `URL must be at most ${MAX_CRAWL_URL_LENGTH} characters`,
    );
  }

  let parsed: URL;
  try {
    parsed = options.baseUrl ? new URL(value, options.baseUrl) : new URL(value);
  } catch {
    throw new UrlNormalizationError(
      "INVALID_URL",
      options.baseUrl
        ? "URL could not be resolved against the page URL"
        : "URL must be an absolute HTTP or HTTPS URL",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlNormalizationError(
      "UNSUPPORTED_PROTOCOL",
      "URL must use HTTP or HTTPS",
    );
  }

  if (parsed.username || parsed.password) {
    throw new UrlNormalizationError(
      "CREDENTIALS_NOT_ALLOWED",
      "URL must not contain embedded credentials",
    );
  }

  parsed.hash = "";

  if (
    options.allowedOrigin &&
    parsed.origin !== normalizedOrigin(options.allowedOrigin)
  ) {
    throw new UrlNormalizationError(
      "EXTERNAL_ORIGIN",
      "URL must use the crawl seed origin",
    );
  }

  if (
    options.rejectDownloadable !== false &&
    hasDownloadableExtension(parsed)
  ) {
    throw new UrlNormalizationError(
      "DOWNLOADABLE_URL",
      "URL points to a downloadable or non-HTML resource",
    );
  }

  const normalized = parsed.toString();
  if (normalized.length > MAX_CRAWL_URL_LENGTH) {
    throw new UrlNormalizationError(
      "URL_TOO_LONG",
      `URL must be at most ${MAX_CRAWL_URL_LENGTH} characters`,
    );
  }

  return normalized;
}
