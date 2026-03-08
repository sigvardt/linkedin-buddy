import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOptInCommentPostUrl, getWriteConfirmGate } from "./helpers.js";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

const commentConfirmPostUrl = getOptInCommentPostUrl();
const commentConfirmTest =
  getWriteConfirmGate("LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM").enabled &&
  typeof commentConfirmPostUrl === "string" &&
  commentConfirmPostUrl.length > 0
    ? it
    : it.skip;

/**
 * Feed Write E2E — two-phase commit comment on Joakim's own post.
 *
 * Flow: feed.viewFeed → feed.prepareCommentOnPost → twoPhaseCommit.confirmByToken
 *
 * Requires LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM=1 and
 * LINKEDIN_E2E_COMMENT_POST_URL=<approved-post-url>.
 * Comments can be manually deleted afterwards.
 * Explicitly authorised by project owner (Joakim Sigvardt).
 */
describe("Feed Write E2E (2PC comment_on_post)", () => {
  let cdpOk = false;
  let authOk = false;

  beforeAll(async () => {
    cdpOk = await checkCdpAvailable();
    if (cdpOk) {
      authOk = await checkAuthenticated();
    }
  });

  afterAll(() => {
    cleanupRuntime();
  });

  commentConfirmTest("comments on a feed post via prepare → confirm", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();

    const targetPostUrl = commentConfirmPostUrl!;

    expect(targetPostUrl).toContain("linkedin.com");

    // Step 2: prepare a comment via 2PC
    const timestamp = new Date().toISOString();
    const commentText = `E2E test comment from linkedin-owa-agentools [${timestamp}]`;

    const prepared = runtime.feed.prepareCommentOnPost({
      postUrl: targetPostUrl,
      text: commentText,
      operatorNote: "Automated E2E feed write test"
    });

    expect(prepared.preparedActionId).toBeTruthy();
    expect(prepared.preparedActionId).toMatch(/^pa_/);
    expect(prepared.confirmToken).toBeTruthy();
    expect(prepared.confirmToken).toMatch(/^ct_/);
    expect(prepared.expiresAtMs).toBeGreaterThan(Date.now());
    expect(prepared.preview).toBeDefined();
    expect(prepared.preview).toHaveProperty("summary");
    expect(prepared.preview).toHaveProperty("target");
    expect(prepared.preview).toHaveProperty("outbound");

    const outbound = prepared.preview.outbound as { text: string };
    expect(outbound.text).toBe(commentText);

    // Step 3: confirm the action (execute the comment)
    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("feed.comment_on_post");
    expect(result.result).toHaveProperty("commented", true);
    expect(result.result).toHaveProperty("text", commentText);
  }, 120_000);

  it("prepare returns valid preview with rate limit info", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();

    const posts = await runtime.feed.viewFeed({ limit: 5 });
    if (posts.length === 0) return;

    const targetPost = posts[0]!;
    const prepared = runtime.feed.prepareCommentOnPost({
      postUrl: targetPost.post_url,
      text: "E2E preview-only test (will not confirm)"
    });

    expect(prepared.preview).toHaveProperty("rate_limit");
    const rateLimit = prepared.preview.rate_limit as Record<string, unknown>;
    expect(rateLimit).toHaveProperty("counter_key", "linkedin.feed.comment_on_post");
    expect(typeof rateLimit.remaining).toBe("number");
    expect(typeof rateLimit.allowed).toBe("boolean");

    // Intentionally not confirmed; will expire naturally.
  }, 60_000);
});
