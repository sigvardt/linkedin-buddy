import { describe, expect, it } from "vitest";
import {
  CREATE_POST_ACTION_TYPE,
  LINKEDIN_POST_MAX_LENGTH,
  LINKEDIN_POST_VISIBILITY_MAP,
  LINKEDIN_POST_VISIBILITY_TYPES,
  createPostActionExecutors,
  normalizeLinkedInPostVisibility,
  validateLinkedInPostText
} from "../linkedinPosts.js";

describe("Post action type constants", () => {
  it("has correct create post action type", () => {
    expect(CREATE_POST_ACTION_TYPE).toBe("post.create");
  });
});

describe("createPostActionExecutors", () => {
  it("registers the create post action executor", () => {
    const executors = createPostActionExecutors();
    expect(Object.keys(executors)).toHaveLength(1);
    expect(executors[CREATE_POST_ACTION_TYPE]).toBeDefined();
  });

  it("exposes an execute method", () => {
    const executors = createPostActionExecutors();
    expect(typeof executors[CREATE_POST_ACTION_TYPE]?.execute).toBe("function");
  });
});

describe("post visibility normalization", () => {
  it("supports the public and connections visibility values", () => {
    expect(LINKEDIN_POST_VISIBILITY_TYPES).toEqual(["public", "connections"]);
    expect(LINKEDIN_POST_VISIBILITY_MAP.public.audienceLabel).toBe("Anyone");
    expect(LINKEDIN_POST_VISIBILITY_MAP.connections.audienceLabel).toBe(
      "Connections only"
    );
  });

  it("normalizes common visibility aliases", () => {
    expect(normalizeLinkedInPostVisibility("PUBLIC")).toBe("public");
    expect(normalizeLinkedInPostVisibility("anyone")).toBe("public");
    expect(normalizeLinkedInPostVisibility("connections only")).toBe(
      "connections"
    );
  });

  it("throws for unsupported visibility values", () => {
    expect(() => normalizeLinkedInPostVisibility("private")).toThrow(
      "visibility must be one of"
    );
  });
});

describe("post text validation", () => {
  it("normalizes formatting and reports validation metadata", () => {
    const validated = validateLinkedInPostText(
      "  Hello there  \r\nWorld  \n\n#launch @team  "
    );

    expect(validated.normalizedText).toBe("Hello there\nWorld\n\n#launch @team");
    expect(validated.characterCount).toBe(validated.normalizedText.length);
    expect(validated.lineCount).toBe(4);
    expect(validated.paragraphCount).toBe(2);
    expect(validated.containsUrl).toBe(false);
    expect(validated.containsMention).toBe(true);
    expect(validated.containsHashtag).toBe(true);
  });

  it("rejects empty post text", () => {
    expect(() => validateLinkedInPostText(" \n \n ")).toThrow(
      "Post text must not be empty"
    );
  });

  it("rejects oversized post text", () => {
    expect(() =>
      validateLinkedInPostText("x".repeat(LINKEDIN_POST_MAX_LENGTH + 1))
    ).toThrow(`${LINKEDIN_POST_MAX_LENGTH} characters or fewer`);
  });

  it("rejects control characters", () => {
    expect(() => validateLinkedInPostText(`hello${String.fromCharCode(7)}world`)).toThrow(
      "unsupported control characters"
    );
  });
});
