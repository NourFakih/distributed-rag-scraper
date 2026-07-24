import {
  normalizeCrawlUrl,
  UrlNormalizationError,
  type CrawlerConfig,
} from "@distributed-rag/shared";

import { CrawlFailure } from "../errors/crawl-failure";
import {
  defaultDnsResolver,
  resolveAndValidateTarget,
  type DnsResolver,
} from "../http/ip-safety";

export class NavigationGuard {
  public constructor(
    private readonly config: CrawlerConfig,
    private readonly resolver: DnsResolver = defaultDnsResolver,
  ) {}

  public async validate(
    url: string,
    allowedOrigin?: string,
  ): Promise<string> {
    let normalized: string;
    try {
      normalized = normalizeCrawlUrl(url, {
        ...(allowedOrigin ? { allowedOrigin } : {}),
        rejectDownloadable: false,
      });
    } catch (error: unknown) {
      if (error instanceof UrlNormalizationError) {
        throw new CrawlFailure(
          error.code === "EXTERNAL_ORIGIN"
            ? "SAME_ORIGIN_VIOLATION"
            : "INVALID_URL",
          error.message,
          false,
          undefined,
          { cause: error },
        );
      }
      throw error;
    }

    const parsed = new URL(normalized);
    await resolveAndValidateTarget(
      parsed.hostname.replace(/^\[|\]$/gu, ""),
      this.resolver,
      this.config.allowPrivateTestTargets,
    );
    return normalized;
  }
}
