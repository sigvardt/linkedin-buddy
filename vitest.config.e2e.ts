import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/core/src/__tests__/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000
  }
});
