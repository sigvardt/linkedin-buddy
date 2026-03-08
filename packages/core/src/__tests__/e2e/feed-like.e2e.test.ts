import { describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  expectRateLimitPreview,
  getFeedPost,
  getOptInLikePostUrl,
  isOptInEnabled
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const likeConfirmPostUrl = getOptInLikePostUrl();
const likeConfirmTest =
  isOptInEnabled("LINKEDIN_E2E_ENABLE_LIKE_CONFIRM") &&
  typeof likeConfirmPostUrl === "string" &&
  likeConfirmPostUrl.length > 0
    ? it
    : it.skip;

describe("Feed Like E2E (2PC like_post)", () => {
  const e2e = setupE2ESuite();

  it("prepare returns valid preview with rate limit info", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const post = await getFeedPost(runtime);

    const prepared = runtime.feed.prepareLikePost({
      postUrl: post.post_url,
      reaction: "like"
    });

    expectRateLimitPreview(prepared.preview, "linkedin.feed.like_post");
  }, 60_000);

  likeConfirmTest("likes a feed post via prepare → confirm", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const postUrl = likeConfirmPostUrl!;
    const prepared = runtime.feed.prepareLikePost({
      postUrl,
      reaction: "like",
      operatorNote: "Automated E2E like write test"
    });

    expectPreparedAction(prepared);

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.actionType).toBe("feed.like_post");
    expect(result.result).toMatchObject({
      reacted: true,
      reaction: "like"
    });
  }, 120_000);
});
