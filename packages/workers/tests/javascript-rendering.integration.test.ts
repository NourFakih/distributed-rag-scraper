import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CrawlerConfig } from "@distributed-rag/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { GlobalDomainLimiter } from "../src/http/global-domain-limiter";
import { BrowserManager } from "../src/rendering/browser-manager";
import { JavaScriptPageRenderer } from "../src/rendering/javascript-page.renderer";
import { NavigationGuard } from "../src/rendering/navigation-guard";
import type { RobotsService } from "../src/robots/robots.service";

const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

describe.runIf(runIntegrationTests)(
  "JavaScript rendering with local fixtures",
  () => {
    let server: Server;
    let baseUrl: string;
    let browserManager: BrowserManager;
    let renderer: JavaScriptPageRenderer;
    let popupRequests = 0;

    beforeAll(async () => {
      server = createServer((request, response) => {
        if (request.url === "/rendered") {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
          });
          response.end(`
            <html><head><title>Original title</title></head><body>
              <script>
                document.title = "Rendered title";
                const main = document.createElement("main");
                main.id = "rendered";
                main.innerHTML =
                  '<h1>Rendered heading</h1>' +
                  '<p>Added only by JavaScript.</p>' +
                  '<a href="/created-child">Created child</a>';
                document.body.appendChild(main);
              </script>
            </body></html>
          `);
          return;
        }
        if (request.url === "/external-navigation") {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
          });
          response.end(`
            <html><body><main>Before navigation</main>
              <script>window.location.href = "https://outside.example/";</script>
            </body></html>
          `);
          return;
        }
        if (request.url === "/popup") {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
          });
          response.end(`
            <html><body><script>
              const popup = window.open("/popup-target", "_blank");
              document.body.innerHTML =
                "<main>" + (popup === null ? "Popup blocked" : "Popup opened") + "</main>";
            </script></body></html>
          `);
          return;
        }
        if (request.url === "/popup-target") {
          popupRequests += 1;
        }
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end("<html><body><main>Fallback</main></body></html>");
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      baseUrl = `http://127.0.0.1:${
        (server.address() as AddressInfo).port
      }`;

      const config: CrawlerConfig = {
        userAgent: "FixtureBot/1.0",
        defaultIntervalMs: 1,
        javascriptNavigationTimeoutMs: 3_000,
        javascriptSettleMs: 25,
        javascriptWaitSelector: "main",
        javascriptWaitSelectorTimeoutMs: 1_000,
        javascriptMaxContexts: 1,
        allowPrivateTestTargets: true,
      };
      browserManager = new BrowserManager(1);
      renderer = new JavaScriptPageRenderer(
        config,
        browserManager,
        new NavigationGuard(config),
        {
          acquire: vi.fn().mockResolvedValue(undefined),
        } as unknown as GlobalDomainLimiter,
        {
          check: vi.fn().mockResolvedValue({
            allowed: true,
          }),
        } as unknown as RobotsService,
      );
    });

    afterAll(async () => {
      await browserManager.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    it("captures content and links created only by JavaScript", async () => {
      const page = await renderer.render({
        url: `${baseUrl}/rendered`,
        allowedOrigin: baseUrl,
      });

      expect(page.title).toBe("Rendered title");
      expect(page.content).toContain("Added only by JavaScript.");
      expect(page.rawHtml).toContain('href="/created-child"');
      expect(page.rawHtml).not.toContain("<main id=\"rendered\"></main>");
    });

    it("rejects external top-level navigation", async () => {
      await expect(
        renderer.render({
          url: `${baseUrl}/external-navigation`,
          allowedOrigin: baseUrl,
        }),
      ).rejects.toMatchObject({
        category: "SAME_ORIGIN_VIOLATION",
        retryable: false,
      });
    });

    it("blocks popups before their target is requested", async () => {
      const page = await renderer.render({
        url: `${baseUrl}/popup`,
        allowedOrigin: baseUrl,
      });

      expect(page.content).toContain("Popup blocked");
      expect(popupRequests).toBe(0);
    });
  },
);
