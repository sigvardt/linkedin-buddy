import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@linkedin-assistant/core": path.join(
        repoRoot,
        "packages/core/src/index.js"
      )
    }
  },
  test: {
    environment: "node",
    include: [
      "packages/**/test/**/*.test.ts",
      "packages/**/src/__tests__/**/*.test.ts"
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.e2e.test.ts"
    ]
  }
});
