import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getFeedPost,
  getOptInLikePostUrl,
  getWriteConfirmGate
} from "./helpers.js";
import {
  checkAuthenticated,
  checkCdpAvailable,
  cleanupRuntime,
  getRuntime
} from "./setup.js";

const likeConfirmPostUrl = getOptInLikePostUrl();
const likeConfirmTest =
  getWriteConfirmGate("LINKEDIN_E2E_ENABLE_LIKE_CONFIRM").enabled &&
  typeof likeConfirmPostUrl === "string" &&
  likeConfirmPostUrl.length > 0
    ? it
    : it.skip;

describe("Feed Like E2E (2PC like_post)", () => {
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

  it("prepare returns valid preview with rate limit info", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const post = await getFeedPost(runtime);

    const prepared = runtime.feed.prepareLikePost({
      postUrl: post.post_url,
      reaction: "like"
    });

    expect(prepared.preview).toHaveProperty("rate_limit");
    const rateLimit = prepared.preview.rate_limit as Record<string, unknown>;
    expect(rateLimit).toHaveProperty("counter_key", "linkedin.feed.like_post");
    expect(typeof rateLimit.remaining).toBe("number");
    expect(typeof rateLimit.allowed).toBe("boolean");
  }, 60_000);

  likeConfirmTest("likes a feed post via prepare → confirm", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const postUrl = likeConfirmPostUrl!;
    const prepared = runtime.feed.prepareLikePost({
      postUrl,
      reaction: "like",
      operatorNote: "Automated E2E like write test"
    });

    expect(prepared.preparedActionId).toMatch(/^pa_/);
    expect(prepared.confirmToken).toMatch(/^ct_/);

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
