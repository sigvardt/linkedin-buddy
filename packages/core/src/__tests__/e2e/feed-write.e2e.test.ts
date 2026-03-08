import { describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  expectPreparedOutboundText,
  expectRateLimitPreview,
  getFeedPost,
  getOptInCommentPostUrl,
  isOptInEnabled
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const commentConfirmPostUrl = getOptInCommentPostUrl();
const commentConfirmTest =
  isOptInEnabled("LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM") &&
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
  const e2e = setupE2ESuite();

  commentConfirmTest("comments on a feed post via prepare → confirm", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const targetPostUrl = commentConfirmPostUrl!;

    expect(targetPostUrl).toContain("linkedin.com");

    const timestamp = new Date().toISOString();
    const commentText = `E2E test comment from linkedin-owa-agentools [${timestamp}]`;

    const prepared = runtime.feed.prepareCommentOnPost({
      postUrl: targetPostUrl,
      text: commentText,
      operatorNote: "Automated E2E feed write test"
    });

    expectPreparedAction(prepared);
    expectPreparedOutboundText(prepared, commentText);

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("feed.comment_on_post");
    expect(result.result).toHaveProperty("commented", true);
    expect(result.result).toHaveProperty("text", commentText);
  }, 120_000);

  it("prepare returns valid preview with rate limit info", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetPost = await getFeedPost(runtime);
    const prepared = runtime.feed.prepareCommentOnPost({
      postUrl: targetPost.post_url,
      text: "E2E preview-only test (will not confirm)"
    });

    expectRateLimitPreview(prepared.preview, "linkedin.feed.comment_on_post");
  }, 60_000);
});
