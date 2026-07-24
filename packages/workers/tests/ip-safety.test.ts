import { describe, expect, it } from "vitest";

import {
  isUnsafeIpAddress,
  resolveAndValidateTarget,
} from "../src/http/ip-safety";

describe("crawler IP safety", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.10.1",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ])("rejects unsafe address %s", (address) => {
    expect(isUnsafeIpAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "permits public address %s",
    (address) => {
      expect(isUnsafeIpAddress(address)).toBe(false);
    },
  );

  it("rejects a hostname when any DNS answer is unsafe", async () => {
    await expect(
      resolveAndValidateTarget("fixture.test", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.1.1", family: 4 },
      ]),
    ).rejects.toMatchObject({
      category: "UNSAFE_TARGET",
      retryable: false,
    });
  });
});
