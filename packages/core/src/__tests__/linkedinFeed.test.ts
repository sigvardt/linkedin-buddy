import { describe, expect, it } from "vitest";
import {
  COMMENT_ON_POST_ACTION_TYPE,
  LINKEDIN_FEED_REACTION_MAP,
  LINKEDIN_FEED_REACTION_TYPES,
  LIKE_POST_ACTION_TYPE,
  createFeedActionExecutors,
  normalizeLinkedInFeedReaction
} from "../linkedinFeed.js";

describe("Feed action type constants", () => {
  it("has correct like action type", () => {
    expect(LIKE_POST_ACTION_TYPE).toBe("feed.like_post");
  });

  it("has correct comment action type", () => {
    expect(COMMENT_ON_POST_ACTION_TYPE).toBe("feed.comment_on_post");
  });
});

describe("createFeedActionExecutors", () => {
  it("registers both feed action executors", () => {
    const executors = createFeedActionExecutors();
    expect(Object.keys(executors)).toHaveLength(2);
    expect(executors[LIKE_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[COMMENT_ON_POST_ACTION_TYPE]).toBeDefined();
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
