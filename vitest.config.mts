import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@distributed-rag/shared": path.resolve(
        import.meta.dirname,
        "packages/shared/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/tests/**/*.test.{ts,tsx}"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
