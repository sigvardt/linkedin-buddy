import { describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  expectPreparedOutboundText,
  expectRateLimitPreview,
  getFeedPost,
  getOptInLikePostUrl,
  isOptInEnabled
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const feedMenuConfirmPostUrl = getOptInLikePostUrl();
const feedMenuConfirmTest =
  isOptInEnabled("LINKEDIN_E2E_ENABLE_FEED_MENU_CONFIRM") &&
  typeof feedMenuConfirmPostUrl === "string" &&
  feedMenuConfirmPostUrl.length > 0
    ? it
    : it.skip;

describe("Feed engagement E2E (2PC repost/share/save/remove-reaction)", () => {
  const e2e = setupE2ESuite();

  it("prepare returns valid previews for repost/share/save/unsave/remove-reaction", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const post = await getFeedPost(runtime);

    expectRateLimitPreview(
      runtime.feed.prepareRepostPost({
        postUrl: post.post_url
      }).preview,
      "linkedin.feed.repost_post"
    );
    expectRateLimitPreview(
      runtime.feed.prepareSharePost({
        postUrl: post.post_url,
        text: "Replay preview share text"
      }).preview,
      "linkedin.feed.share_post"
    );
    expectRateLimitPreview(
      runtime.feed.prepareSavePost({
        postUrl: post.post_url
      }).preview,
      "linkedin.feed.save_post"
    );
    expectRateLimitPreview(
      runtime.feed.prepareUnsavePost({
        postUrl: post.post_url
      }).preview,
      "linkedin.feed.unsave_post"
    );
    expectRateLimitPreview(
      runtime.feed.prepareRemoveReaction({
        postUrl: post.post_url
      }).preview,
      "linkedin.feed.remove_reaction"
    );
  }, 60_000);

  feedMenuConfirmTest("confirms the new feed engagement actions against the replay surface", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const postUrl = feedMenuConfirmPostUrl!;

    const savePrepared = runtime.feed.prepareSavePost({
      postUrl,
      operatorNote: "Automated E2E save test"
    });
    expectPreparedAction(savePrepared);
    const saveResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: savePrepared.confirmToken
    });
    expect(saveResult.status).toBe("executed");
    expect(saveResult.actionType).toBe("feed.save_post");
    expect(saveResult.result).toMatchObject({
      saved: true
    });

    const unsavePrepared = runtime.feed.prepareUnsavePost({
      postUrl,
      operatorNote: "Automated E2E unsave test"
    });
    expectPreparedAction(unsavePrepared);
    const unsaveResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: unsavePrepared.confirmToken
    });
    expect(unsaveResult.status).toBe("executed");
    expect(unsaveResult.actionType).toBe("feed.unsave_post");
    expect(unsaveResult.result).toMatchObject({
      saved: false
    });

    const likePrepared = runtime.feed.prepareLikePost({
      postUrl,
      reaction: "like",
      operatorNote: "Automated E2E pre-remove reaction setup"
    });
    expectPreparedAction(likePrepared);
    const likeResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: likePrepared.confirmToken
    });
    expect(likeResult.status).toBe("executed");
    expect(likeResult.actionType).toBe("feed.like_post");

    const removeReactionPrepared = runtime.feed.prepareRemoveReaction({
      postUrl,
      operatorNote: "Automated E2E remove reaction test"
    });
    expectPreparedAction(removeReactionPrepared);
    const removeReactionResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: removeReactionPrepared.confirmToken
    });
    expect(removeReactionResult.status).toBe("executed");
    expect(removeReactionResult.actionType).toBe("feed.remove_reaction");
    expect(removeReactionResult.result).toMatchObject({
      reacted: false
    });

    const repostPrepared = runtime.feed.prepareRepostPost({
      postUrl,
      operatorNote: "Automated E2E repost test"
    });
    expectPreparedAction(repostPrepared);
    const repostResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: repostPrepared.confirmToken
    });
    expect(repostResult.status).toBe("executed");
    expect(repostResult.actionType).toBe("feed.repost_post");
    expect(repostResult.result).toMatchObject({
      reposted: true
    });

    const shareText = `Replay share test [${new Date().toISOString()}]`;
    const sharePrepared = runtime.feed.prepareSharePost({
      postUrl,
      text: shareText,
      operatorNote: "Automated E2E share test"
    });
    expectPreparedAction(sharePrepared);
    expectPreparedOutboundText(sharePrepared, shareText);
    const shareResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: sharePrepared.confirmToken
    });
    expect(shareResult.status).toBe("executed");
    expect(shareResult.actionType).toBe("feed.share_post");
    expect(shareResult.result).toMatchObject({
      shared: true,
      text: shareText
    });
  }, 180_000);
});
