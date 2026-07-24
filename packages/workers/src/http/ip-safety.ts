import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";

import { CrawlFailure } from "../errors/crawl-failure";

export type DnsResolver = (hostname: string) => Promise<LookupAddress[]>;

export const defaultDnsResolver: DnsResolver = (hostname) =>
  dns.lookup(hostname, {
    all: true,
    verbatim: true,
  });

function isUnsafeIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }

  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Bytes(address: string): number[] | null {
  const withoutZone = address.split("%", 1)[0]!;
  let normalized = withoutZone.toLowerCase();

  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) {
      return null;
    }
    const octets = ipv4.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = `${normalized.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":").filter(Boolean)
    : [];
  const right = doubleColonParts[1]
    ? doubleColonParts[1].split(":").filter(Boolean)
    : [];
  const missing = 8 - left.length - right.length;
  if (
    missing < 0 ||
    (doubleColonParts.length === 1 && missing !== 0)
  ) {
    return null;
  }

  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[a-f0-9]{1,4}$/u.test(group))
  ) {
    return null;
  }

  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function startsWith(bytes: number[], prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isUnsafeIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) {
    return true;
  }

  const allZero = bytes.every((byte) => byte === 0);
  const loopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;

  if (ipv4Mapped) {
    return isUnsafeIpv4(bytes.slice(12).join("."));
  }

  return (
    allZero ||
    loopback ||
    (bytes[0]! & 0xfe) === 0xfc ||
    (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) ||
    bytes[0] === 0xff ||
    startsWith(bytes, [0x20, 0x01, 0x0d, 0xb8]) ||
    startsWith(bytes, [0x20, 0x01, 0x00, 0x00]) ||
    startsWith(bytes, [0x20, 0x02]) ||
    startsWith(bytes, [0x00, 0x64, 0xff, 0x9b]) ||
    bytes.slice(0, 12).every((byte) => byte === 0)
  );
}

export function isUnsafeIpAddress(address: string): boolean {
  const family = isIP(address.split("%", 1)[0]!);
  if (family === 4) {
    return isUnsafeIpv4(address);
  }
  if (family === 6) {
    return isUnsafeIpv6(address);
  }
  return true;
}

function dnsErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function resolveAndValidateTarget(
  hostname: string,
  resolver: DnsResolver = defaultDnsResolver,
  allowUnsafeAddresses = false,
): Promise<LookupAddress[]> {
  const literalFamily = isIP(hostname);
  let addresses: LookupAddress[];

  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [
      {
        address: hostname,
        family: literalFamily,
      },
    ];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch (error: unknown) {
      const code = dnsErrorCode(error);
      throw new CrawlFailure(
        code === "EAI_AGAIN" ? "DNS_TEMPORARY" : "DNS_FAILURE",
        `DNS resolution failed for ${hostname}`,
        code === "EAI_AGAIN",
        undefined,
        { cause: error },
      );
    }
  }

  if (addresses.length === 0) {
    throw new CrawlFailure(
      "DNS_FAILURE",
      `DNS resolution returned no addresses for ${hostname}`,
      false,
    );
  }

  if (
    !allowUnsafeAddresses &&
    addresses.some((result) => isUnsafeIpAddress(result.address))
  ) {
    throw new CrawlFailure(
      "UNSAFE_TARGET",
      `Target ${hostname} resolves to a non-public IP address`,
      false,
    );
  }

  return addresses;
}
