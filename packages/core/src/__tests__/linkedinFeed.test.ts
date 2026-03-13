import { describe, expect, it, vi } from "vitest";
import {
  COMMENT_ON_POST_ACTION_TYPE,
  LINKEDIN_FEED_REACTION_MAP,
  LINKEDIN_FEED_REACTION_TYPES,
  LIKE_POST_ACTION_TYPE,
  LinkedInFeedService,
  REMOVE_REACTION_ACTION_TYPE,
  REPOST_POST_ACTION_TYPE,
  SAVE_POST_ACTION_TYPE,
  SHARE_POST_ACTION_TYPE,
  UNSAVE_POST_ACTION_TYPE,
  createFeedActionExecutors,
  normalizeLinkedInFeedReaction,
  type ViewFeedInput
} from "../linkedinFeed.js";

describe("Feed action type constants", () => {
  it("has correct like action type", () => {
    expect(LIKE_POST_ACTION_TYPE).toBe("feed.like_post");
  });

  it("has correct comment action type", () => {
    expect(COMMENT_ON_POST_ACTION_TYPE).toBe("feed.comment_on_post");
  });

  it("has correct repost action type", () => {
    expect(REPOST_POST_ACTION_TYPE).toBe("feed.repost_post");
  });

  it("has correct share action type", () => {
    expect(SHARE_POST_ACTION_TYPE).toBe("feed.share_post");
  });

  it("has correct save action type", () => {
    expect(SAVE_POST_ACTION_TYPE).toBe("feed.save_post");
  });

  it("has correct unsave action type", () => {
    expect(UNSAVE_POST_ACTION_TYPE).toBe("feed.unsave_post");
  });

  it("has correct remove reaction action type", () => {
    expect(REMOVE_REACTION_ACTION_TYPE).toBe("feed.remove_reaction");
  });
});

describe("createFeedActionExecutors", () => {
  it("registers all feed action executors", () => {
    const executors = createFeedActionExecutors();
    expect(Object.keys(executors)).toHaveLength(7);
    expect(executors[LIKE_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[COMMENT_ON_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[REPOST_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[SHARE_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[SAVE_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[UNSAVE_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_REACTION_ACTION_TYPE]).toBeDefined();
  });

  it("each executor has an execute method", () => {
    const executors = createFeedActionExecutors();
    for (const key of Object.keys(executors)) {
      const executor = executors[key];
      expect(executor).toBeDefined();
      expect(typeof executor!.execute).toBe("function");
    }
  });
});

describe("LinkedInFeedService prepare actions", () => {
  function createService() {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const rateLimiter = {
      peek: vi.fn((config: { counterKey: string; windowSizeMs: number; limit: number }) => ({
        counterKey: config.counterKey,
        windowStartMs: 0,
        windowSizeMs: config.windowSizeMs,
        count: 0,
        limit: config.limit,
        remaining: config.limit,
        allowed: true
      }))
    };

    const service = new LinkedInFeedService({
      twoPhaseCommit: { prepare },
      rateLimiter
    } as unknown as ConstructorParameters<typeof LinkedInFeedService>[0]);

    return {
      service,
      prepare
    };
  }

  it("prepares repost, share, save, unsave, and remove-reaction previews", () => {
    const { service, prepare } = createService();

    const repostPrepared = service.prepareRepostPost({
      postUrl: "123"
    });
    const sharePrepared = service.prepareSharePost({
      postUrl: "123",
      text: "Sharing this with a short note."
    });
    const savePrepared = service.prepareSavePost({
      postUrl: "123"
    });
    const unsavePrepared = service.prepareUnsavePost({
      postUrl: "123"
    });
    const removeReactionPrepared = service.prepareRemoveReaction({
      postUrl: "123"
    });

    expect(repostPrepared.preview).toMatchObject({
      summary: "Repost LinkedIn post https://www.linkedin.com/feed/update/urn:li:activity:123/",
      outbound: {
        action: "repost"
      }
    });
    expect(sharePrepared.preview).toMatchObject({
      summary: "Share LinkedIn post https://www.linkedin.com/feed/update/urn:li:activity:123/",
      outbound: {
        action: "share",
        text: "Sharing this with a short note."
      }
    });
    expect(savePrepared.preview).toMatchObject({
      summary: "Save LinkedIn post https://www.linkedin.com/feed/update/urn:li:activity:123/ for later",
      outbound: {
        action: "save"
      }
    });
    expect(unsavePrepared.preview).toMatchObject({
      summary: "Unsave LinkedIn post https://www.linkedin.com/feed/update/urn:li:activity:123/",
      outbound: {
        action: "unsave"
      }
    });
    expect(removeReactionPrepared.preview).toMatchObject({
      summary:
        "Remove your reaction from LinkedIn post https://www.linkedin.com/feed/update/urn:li:activity:123/",
      outbound: {
        action: "remove_reaction"
      }
    });

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actionType: REPOST_POST_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actionType: SHARE_POST_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ actionType: SAVE_POST_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ actionType: UNSAVE_POST_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ actionType: REMOVE_REACTION_ACTION_TYPE })
    );
  });

  it("rejects empty share text", () => {
    const { service } = createService();

    expect(() =>
      service.prepareSharePost({
        postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
        text: "   "
      })
    ).toThrow("Post text must not be empty.");
  });
});

describe("reaction mapping", () => {
  it("exposes all supported LinkedIn feed reactions", () => {
    expect(LINKEDIN_FEED_REACTION_TYPES).toEqual([
      "like",
      "celebrate",
      "support",
      "love",
      "insightful",
      "funny"
    ]);
    expect(LINKEDIN_FEED_REACTION_MAP.funny.iconType).toBe("ENTERTAINMENT");
    expect(LINKEDIN_FEED_REACTION_MAP.insightful.iconType).toBe("INTEREST");
  });

  it("normalizes aliases to canonical reaction names", () => {
    expect(normalizeLinkedInFeedReaction("LIKE")).toBe("like");
    expect(normalizeLinkedInFeedReaction("praise")).toBe("celebrate");
    expect(normalizeLinkedInFeedReaction("appreciation")).toBe("support");
    expect(normalizeLinkedInFeedReaction("insight")).toBe("insightful");
    expect(normalizeLinkedInFeedReaction("haha")).toBe("funny");
  });

  it("throws for unsupported reaction names", () => {
    expect(() => normalizeLinkedInFeedReaction("rocket")).toThrow(
      "reaction must be one of"
    );
  });
});

describe("ViewFeedInput.mine", () => {
  it("accepts mine flag in input", () => {
    const input: ViewFeedInput = { mine: true, limit: 5 };
    expect(input.mine).toBe(true);
  });

  it("defaults mine to undefined when omitted", () => {
    const input: ViewFeedInput = { limit: 10 };
    expect(input.mine).toBeUndefined();
  });

  it("accepts mine=false explicitly", () => {
    const input: ViewFeedInput = { mine: false };
    expect(input.mine).toBe(false);
  });

  it("accepts full input with mine, profile, and limit", () => {
    const input: ViewFeedInput = {
      profileName: "test-profile",
      limit: 20,
      mine: true,
    };
    expect(input).toEqual({
      profileName: "test-profile",
      limit: 20,
      mine: true,
    });
  });
});
