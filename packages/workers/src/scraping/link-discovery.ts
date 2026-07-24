import {
  normalizeCrawlUrl,
  UrlNormalizationError,
} from "@distributed-rag/shared";
import * as cheerio from "cheerio";

export interface DiscoveredLink {
  url: string;
  normalizedUrl: string;
}

function hasRelToken(value: string | undefined, token: string): boolean {
  return (
    value
      ?.toLowerCase()
      .split(/\s+/u)
      .includes(token) ?? false
  );
}

function pageDisallowsFollowing(rawHtml: string): boolean {
  const $ = cheerio.load(rawHtml);

  return $('meta[name="robots" i], meta[name="googlebot" i]')
    .toArray()
    .some((element) => {
      const content = $(element).attr("content")?.toLowerCase() ?? "";
      return content.split(/[\s,]+/u).includes("nofollow");
    });
}

function resolutionBase(
  $: cheerio.CheerioAPI,
  finalPageUrl: string,
  allowedOrigin: string,
): string | null {
  let finalUrl: string;
  try {
    finalUrl = normalizeCrawlUrl(finalPageUrl, {
      allowedOrigin,
      rejectDownloadable: false,
    });
  } catch {
    return null;
  }

  const declaredBase = $("base[href]").first().attr("href");
  if (!declaredBase) {
    return finalUrl;
  }

  try {
    return normalizeCrawlUrl(declaredBase, {
      baseUrl: finalUrl,
      allowedOrigin,
      rejectDownloadable: false,
    });
  } catch {
    return finalUrl;
  }
}

export function discoverLinks(
  rawHtml: string,
  finalPageUrl: string,
  allowedOrigin: string,
): DiscoveredLink[] {
  if (pageDisallowsFollowing(rawHtml)) {
    return [];
  }

  const $ = cheerio.load(rawHtml);
  const baseUrl = resolutionBase($, finalPageUrl, allowedOrigin);
  if (!baseUrl) {
    return [];
  }

  const discovered = new Map<string, DiscoveredLink>();

  $("a[href]").each((_index, element) => {
    const anchor = $(element);
    const href = anchor.attr("href")?.trim();

    if (
      !href ||
      anchor.attr("download") !== undefined ||
      hasRelToken(anchor.attr("rel"), "nofollow")
    ) {
      return;
    }

    try {
      const normalizedUrl = normalizeCrawlUrl(href, {
        baseUrl,
        allowedOrigin,
      });
      discovered.set(normalizedUrl, {
        url: normalizedUrl,
        normalizedUrl,
      });
    } catch (error: unknown) {
      if (error instanceof UrlNormalizationError) {
        return;
      }
      throw error;
    }
  });

  return [...discovered.values()];
}
