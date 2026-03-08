import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@linkedin-assistant/core": path.resolve(rootDir, "packages/core/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["packages/core/src/__tests__/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
