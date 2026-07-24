import type { CrawlerConfig } from "@distributed-rag/shared";
import type {
  AxiosRequestConfig,
  AxiosResponse,
} from "axios";
import { describe, expect, it, vi } from "vitest";

import {
  CrawlerHttpClient,
  retryableHttpFailure,
  type HttpTransport,
} from "../src/http/crawler-http-client";
import type { GlobalDomainLimiter } from "../src/http/global-domain-limiter";
import type { DnsResolver } from "../src/http/ip-safety";

const config: CrawlerConfig = {
  userAgent: "FixtureBot/1.0",
  defaultIntervalMs: 1_000,
  allowPrivateTestTargets: false,
};

function axiosResponse(
  status: number,
  headers: Record<string, string> = {},
  data = "ok",
): AxiosResponse<string> {
  return {
    status,
    statusText: String(status),
    headers,
    data,
    config: {} as AxiosResponse<string>["config"],
  };
}

function fixtureClient(
  transport: ReturnType<typeof vi.fn>,
  resolver: ReturnType<typeof vi.fn> = vi
    .fn()
    .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]),
) {
  const acquire = vi.fn().mockResolvedValue(undefined);
  const client = new CrawlerHttpClient(
    config,
    { acquire } as unknown as GlobalDomainLimiter,
    resolver as DnsResolver,
    transport as HttpTransport,
  );
  return {
    acquire,
    client,
    resolver,
  };
}

const request = {
  url: "https://example.com/start",
  allowedOrigin: "https://example.com",
  accept: "text/html",
  maxResponseBytes: 1_024,
};

describe("CrawlerHttpClient", () => {
  it("follows a safe same-origin redirect and validates every hop", async () => {
    const transport = vi
      .fn<(configuration: AxiosRequestConfig) => Promise<AxiosResponse<string>>>()
      .mockResolvedValueOnce(
        axiosResponse(302, {
          location: "/final",
        }),
      )
      .mockResolvedValueOnce(axiosResponse(200));
    const fixture = fixtureClient(transport);

    await expect(fixture.client.request(request)).resolves.toMatchObject({
      url: "https://example.com/final",
      status: 200,
    });
    expect(fixture.resolver).toHaveBeenCalledTimes(2);
    expect(fixture.acquire).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      maxRedirects: 0,
      proxy: false,
      headers: {
        "User-Agent": "FixtureBot/1.0",
      },
    });
  });

  it("rejects an external redirect before making the next request", async () => {
    const transport = vi.fn().mockResolvedValue(
      axiosResponse(302, {
        location: "https://outside.example/final",
      }),
    );
    const fixture = fixtureClient(transport);

    await expect(fixture.client.request(request)).rejects.toMatchObject({
      category: "SAME_ORIGIN_VIOLATION",
      retryable: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("checks robots policy before fetching a same-origin redirect target", async () => {
    const transport = vi.fn().mockResolvedValue(
      axiosResponse(302, {
        location: "/private",
      }),
    );
    const checkRedirectPolicy = vi.fn().mockResolvedValue({
      allowed: false,
    });
    const fixture = fixtureClient(transport);

    await expect(
      fixture.client.request({
        ...request,
        checkRedirectPolicy,
      }),
    ).rejects.toMatchObject({
      name: "RobotsExcludedError",
      url: "https://example.com/private",
    });
    expect(checkRedirectPolicy).toHaveBeenCalledWith(
      "https://example.com/private",
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["127.0.0.1", "169.254.10.1"])(
    "rejects unsafe resolved target %s before transport",
    async (address) => {
      const transport = vi.fn();
      const resolver = vi
        .fn()
        .mockResolvedValue([{ address, family: 4 }]);
      const fixture = fixtureClient(transport, resolver);

      await expect(fixture.client.request(request)).rejects.toMatchObject({
        category: "UNSAFE_TARGET",
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ECONNABORTED", "NETWORK_TIMEOUT"],
    ["ETIMEDOUT", "NETWORK_TIMEOUT"],
    ["ECONNRESET", "CONNECTION_RESET"],
  ])(
    "classifies network code %s as retryable %s",
    async (code, category) => {
      const networkError = Object.assign(new Error(code), { code });
      const transport = vi.fn().mockRejectedValue(networkError);
      const fixture = fixtureClient(transport);

      await expect(fixture.client.request(request)).rejects.toMatchObject({
        category,
        retryable: true,
      });
    },
  );

  it("resolves again after redirects and catches a rebinding-style change", async () => {
    const transport = vi.fn().mockResolvedValue(
      axiosResponse(302, {
        location: "/second-hop",
      }),
    );
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const fixture = fixtureClient(transport, resolver);

    await expect(fixture.client.request(request)).rejects.toMatchObject({
      category: "UNSAFE_TARGET",
    });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, "HTTP_429"],
    [502, "HTTP_502"],
    [503, "HTTP_503"],
    [504, "HTTP_504"],
  ])("classifies HTTP %i as retryable %s", (status, category) => {
    expect(
      retryableHttpFailure({
        url: request.url,
        status,
        headers: {
          "retry-after": "2",
        },
        data: "",
      }),
    ).toMatchObject({
      category,
      retryable: true,
      retryAfterMs: 2_000,
    });
  });
});
