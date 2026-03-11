import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@linkedin-buddy/core": path.join(
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
      ...configDefaults.exclude,
      "**/dist/**",
      "**/*.e2e.test.ts"
    ],
    coverage: {
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["packages/**/src/**/__tests__/**"]
    }
  }
});
