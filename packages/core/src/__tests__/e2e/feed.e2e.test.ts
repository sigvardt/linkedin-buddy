import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Feed E2E", () => {
  const e2e = setupE2ESuite();

  it("view feed returns posts array with author, text", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const posts = await runtime.feed.viewFeed({ limit: 5 });

    expect(Array.isArray(posts)).toBe(true);
    const [first] = posts;
    if (first) {
      expect(first.author_name.length).toBeGreaterThan(0);
      expect(typeof first.text).toBe("string");
    }
  });

  it("view feed with limit respects parameter", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const posts = await runtime.feed.viewFeed({ limit: 3 });

    expect(posts.length).toBeLessThanOrEqual(3);
  });
});
