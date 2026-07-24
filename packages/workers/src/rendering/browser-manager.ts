import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from "playwright";

type BrowserLauncher = BrowserType["launch"];

interface BrowserPage {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export class BrowserManager {
  private browser: Browser | undefined;
  private launchPromise: Promise<Browser> | undefined;
  private activeContexts = 0;
  private readonly waiters: Array<() => void> = [];
  private closing = false;

  public constructor(
    private readonly maxContexts: number,
    private readonly launch: BrowserLauncher = (options) =>
      chromium.launch(options),
  ) {}

  private async acquireSlot(): Promise<void> {
    if (this.activeContexts < this.maxContexts) {
      this.activeContexts += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.activeContexts += 1;
  }

  private releaseSlot(): void {
    this.activeContexts -= 1;
    this.waiters.shift()?.();
  }

  private async getBrowser(): Promise<Browser> {
    if (this.closing) {
      throw new Error("Browser manager is shutting down");
    }
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = this.launch({
      headless: true,
      args: ["--no-proxy-server"],
    })
      .then((browser) => {
        this.browser = browser;
        browser.on("disconnected", () => {
          if (this.browser === browser) {
            this.browser = undefined;
          }
        });
        return browser;
      })
      .finally(() => {
        this.launchPromise = undefined;
      });
    return this.launchPromise;
  }

  public async withPage<T>(
    userAgent: string,
    operation: (browserPage: BrowserPage) => Promise<T>,
  ): Promise<T> {
    await this.acquireSlot();
    let context: BrowserContext | undefined;
    let page: Page | undefined;

    try {
      const browser = await this.getBrowser();
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        userAgent,
      });
      page = await context.newPage();
      return await operation({ browser, context, page });
    } finally {
      await page?.close().catch(() => undefined);
      await context?.close().catch(() => undefined);
      this.releaseSlot();
    }
  }

  public async close(): Promise<void> {
    this.closing = true;
    const pending = this.launchPromise;
    const browser = this.browser ?? (pending ? await pending : undefined);
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }
}
