import type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
} from "playwright";
import { describe, expect, it, vi } from "vitest";

import { BrowserManager } from "../src/rendering/browser-manager";

function browserFixture() {
  const pages: Array<{
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const contexts: Array<{
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const browserClose = vi.fn().mockResolvedValue(undefined);
  const browser = {
    isConnected: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    close: browserClose,
    newContext: vi.fn().mockImplementation(async () => {
      const page = {
        close: vi.fn().mockResolvedValue(undefined),
      };
      const context = {
        close: vi.fn().mockResolvedValue(undefined),
        newPage: vi.fn().mockResolvedValue(page),
      };
      pages.push(page);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
  } as unknown as Browser;
  const launch = vi.fn().mockResolvedValue(browser) as unknown as
    BrowserType["launch"];

  return {
    browser,
    browserClose,
    contexts,
    launch,
    pages,
  };
}

describe("BrowserManager", () => {
  it("reuses one browser and closes every page and context", async () => {
    const fixture = browserFixture();
    const manager = new BrowserManager(2, fixture.launch);

    await manager.withPage("FixtureBot/1.0", async ({ page }) => page);
    await manager.withPage("FixtureBot/1.0", async ({ page }) => page);
    await manager.close();

    expect(fixture.launch).toHaveBeenCalledTimes(1);
    expect(fixture.pages).toHaveLength(2);
    expect(fixture.contexts).toHaveLength(2);
    expect(
      fixture.pages.every((page) => page.close.mock.calls.length === 1),
    ).toBe(true);
    expect(
      fixture.contexts.every(
        (context) => context.close.mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(fixture.browserClose).toHaveBeenCalledTimes(1);
  });

  it("limits concurrent browser contexts", async () => {
    const fixture = browserFixture();
    const manager = new BrowserManager(1, fixture.launch);
    let releaseFirst: (() => void) | undefined;
    const first = manager.withPage(
      "FixtureBot/1.0",
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await vi.waitFor(() => {
      expect(fixture.contexts).toHaveLength(1);
    });

    const secondOperation = vi.fn().mockResolvedValue(undefined);
    const second = manager.withPage(
      "FixtureBot/1.0",
      secondOperation as (
        value: {
          browser: Browser;
          context: BrowserContext;
          page: Page;
        },
      ) => Promise<void>,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondOperation).not.toHaveBeenCalled();

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(secondOperation).toHaveBeenCalledTimes(1);
    await manager.close();
  });

  it("cleans up the page and context when rendering throws", async () => {
    const fixture = browserFixture();
    const manager = new BrowserManager(1, fixture.launch);

    await expect(
      manager.withPage("FixtureBot/1.0", async () => {
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    expect(fixture.pages[0]?.close).toHaveBeenCalledTimes(1);
    expect(fixture.contexts[0]?.close).toHaveBeenCalledTimes(1);
    await manager.close();
  });
});
