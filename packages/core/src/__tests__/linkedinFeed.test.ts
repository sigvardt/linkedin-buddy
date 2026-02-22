import { describe, expect, it } from "vitest";
import {
  COMMENT_ON_POST_ACTION_TYPE,
  LIKE_POST_ACTION_TYPE,
  createFeedActionExecutors
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
