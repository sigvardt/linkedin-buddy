import { describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  expectPreparedOutboundText,
  expectRateLimitPreview,
  isOptInEnabled
} from "./helpers.js";
import { setupE2ESuite } from "./setup.js";

const writeTest = isOptInEnabled("LINKEDIN_ENABLE_POST_WRITE_E2E") ? it : it.skip;

/**
 * Post Write E2E — two-phase commit create a LinkedIn post.
 *
 * This publishes a real public post and is intentionally opt-in.
 * Set LINKEDIN_ENABLE_POST_WRITE_E2E=1 only after explicit approval.
 *
 * Flow: posts.prepareCreate → twoPhaseCommit.confirmByToken
 */
describe("Post Write E2E (2PC post.create)", () => {
  const e2e = setupE2ESuite();

  writeTest("creates a public post via prepare → confirm", async () => {
    if (!e2e.canRun()) return;
    const runtime = e2e.runtime();
    const timestamp = new Date().toISOString();
    const postText = `E2E post from linkedin-owa-agentools [${timestamp}]`;

    const prepared = await runtime.posts.prepareCreate({
      text: postText,
      visibility: "public",
      operatorNote: "Automated E2E post write test"
    });

    expectPreparedAction(prepared);
    expectPreparedOutboundText(prepared, postText);

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("post.create");
    expect(result.result).toHaveProperty("posted", true);
    expect(result.result).toHaveProperty("visibility", "public");
    expect(result.result).toHaveProperty("verification_snippet");
  }, 180_000);

  it("prepare returns valid preview with rate limit info", async () => {
    if (!e2e.canRun()) return;
    const runtime = e2e.runtime();
    const prepared = await runtime.posts.prepareCreate({
      text: `E2E preview-only post [${new Date().toISOString()}]`,
      visibility: "public"
    });

    expectRateLimitPreview(prepared.preview, "linkedin.post.create");
  }, 60_000);
});
