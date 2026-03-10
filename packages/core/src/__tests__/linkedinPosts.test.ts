import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREATE_POST_ACTION_TYPE,
  CREATE_MEDIA_POST_ACTION_TYPE,
  CREATE_POLL_POST_ACTION_TYPE,
  DELETE_POST_ACTION_TYPE,
  DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG,
  EDIT_POST_ACTION_TYPE,
  LINKEDIN_POST_MAX_LENGTH,
  LINKEDIN_POST_VISIBILITY_MAP,
  LINKEDIN_POST_VISIBILITY_TYPES,
  LinkedInPostsService,
  createPostActionExecutors,
  lintLinkedInPostContent,
  normalizeLinkedInPostVisibility,
  resolveLinkedInPostSafetyLintConfig,
  verifyPublishedPost,
  waitForFeedSurface,
  validateLinkedInPostText
} from "../linkedinPosts.js";

const POST_SAFETY_ENV_KEYS = [
  "LINKEDIN_ASSISTANT_POST_SAFETY_MAX_LENGTH",
  "LINKEDIN_ASSISTANT_POST_SAFETY_BANNED_PHRASES",
  "LINKEDIN_ASSISTANT_POST_SAFETY_VALIDATE_LINK_PREVIEWS",
  "LINKEDIN_ASSISTANT_POST_SAFETY_LINK_TIMEOUT_MS"
] as const;

const ORIGINAL_POST_SAFETY_ENV = Object.fromEntries(
  POST_SAFETY_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof POST_SAFETY_ENV_KEYS)[number], string | undefined>;

const tempDirs: string[] = [];

afterEach(() => {
  for (const key of POST_SAFETY_ENV_KEYS) {
    const originalValue = ORIGINAL_POST_SAFETY_ENV[key];
    if (originalValue === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = originalValue;
  }

  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempBaseDir(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-post-lint-"));
  tempDirs.push(tempDir);
  return tempDir;
}

interface MockPublishedPostPageState {
  visibleSelectors: readonly string[];
  hasSnippet?: boolean;
  publishedPostUrl?: string | null;
}

type MockLocatorKind = "surface" | "snippet" | "text" | "anchor";

class MockPublishedPostPage {
  private currentUrl: string;

  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
    return null;
  });

  readonly waitForLoadState = vi.fn(async () => undefined);
  readonly evaluate = vi.fn(async () => undefined);
  readonly url = vi.fn(() => this.currentUrl);
  readonly locator = vi.fn(
    (selector: string) =>
      new MockPublishedPostLocator(this, "surface", selector) as unknown as Locator
  );
  readonly getByText = vi.fn(
    (text: string) =>
      new MockPublishedPostLocator(this, "text", text) as unknown as Locator
  );

  constructor(
    private readonly statesByUrl: Readonly<Record<string, MockPublishedPostPageState>>,
    initialUrl: string
  ) {
    this.currentUrl = initialUrl;
  }

  state(): MockPublishedPostPageState {
    return this.statesByUrl[this.currentUrl] ?? { visibleSelectors: [] };
  }
}

class MockPublishedPostLocator {
  constructor(
    private readonly page: MockPublishedPostPage,
    private readonly kind: MockLocatorKind,
    private readonly selector: string
  ) {}

  first(): Locator {
    return this as unknown as Locator;
  }

  nth(): Locator {
    return this as unknown as Locator;
  }

  filter(options: { hasText?: string | RegExp }): Locator {
    void options;
    return new MockPublishedPostLocator(
      this.page,
      "snippet",
      this.selector
    ) as unknown as Locator;
  }

  locator(selector: string): Locator {
    if (
      (this.kind === "snippet" || this.kind === "text") &&
      selector.includes("a[href*='/feed/update/']")
    ) {
      return new MockPublishedPostLocator(
        this.page,
        "anchor",
        selector
      ) as unknown as Locator;
    }

    if (this.kind === "text") {
      return new MockPublishedPostLocator(
        this.page,
        "snippet",
        selector
      ) as unknown as Locator;
    }

    return new MockPublishedPostLocator(
      this.page,
      "surface",
      selector
    ) as unknown as Locator;
  }

  async count(): Promise<number> {
    const state = this.page.state();
    switch (this.kind) {
      case "surface":
        return state.visibleSelectors.includes(this.selector) ? 1 : 0;
      case "snippet":
      case "text":
        return state.hasSnippet ? 1 : 0;
      case "anchor":
        return state.hasSnippet && state.publishedPostUrl ? 1 : 0;
    }
  }

  async isVisible(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  async waitFor(): Promise<void> {
    if (!(await this.isVisible())) {
      throw new Error(`Locator not visible: ${this.selector}`);
    }
  }

  async getAttribute(name: string): Promise<string | null> {
    if (name !== "href" || this.kind !== "anchor") {
      return null;
    }

    return this.page.state().publishedPostUrl ?? null;
  }
}

function createMockPublishedPostPage(
  statesByUrl: Readonly<Record<string, MockPublishedPostPageState>>,
  initialUrl: string
): Page {
  return new MockPublishedPostPage(statesByUrl, initialUrl) as unknown as Page;
}

describe("Post action type constants", () => {
  it("has correct create post action type", () => {
    expect(CREATE_POST_ACTION_TYPE).toBe("post.create");
    expect(CREATE_MEDIA_POST_ACTION_TYPE).toBe("post.create_media");
    expect(CREATE_POLL_POST_ACTION_TYPE).toBe("post.create_poll");
    expect(EDIT_POST_ACTION_TYPE).toBe("post.edit");
    expect(DELETE_POST_ACTION_TYPE).toBe("post.delete");
  });
});

describe("createPostActionExecutors", () => {
  it("registers all post action executors", () => {
    const executors = createPostActionExecutors();
    expect(Object.keys(executors)).toHaveLength(5);
    expect(executors[CREATE_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[CREATE_MEDIA_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[CREATE_POLL_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[EDIT_POST_ACTION_TYPE]).toBeDefined();
    expect(executors[DELETE_POST_ACTION_TYPE]).toBeDefined();
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

  it("supports stricter configured max lengths", () => {
    expect(() => validateLinkedInPostText("hello world", 10)).toThrow(
      "10 characters or fewer"
    );
  });

  it("rejects control characters", () => {
    expect(() => validateLinkedInPostText(`hello${String.fromCharCode(7)}world`)).toThrow(
      "unsupported control characters"
    );
  });
});

describe("post safety lint", () => {
  it("rejects configured banned phrases", async () => {
    await expect(
      lintLinkedInPostContent("Let's take this offline after the demo", {
        ...DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG,
        bannedPhrases: ["take this offline"]
      })
    ).rejects.toMatchObject({
      message: 'Post text contains banned phrase "take this offline".',
      details: {
        banned_phrases: ["take this offline"]
      }
    });
  });

  it("validates link previews when enabled", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html><head><title>Example</title></head></html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await lintLinkedInPostContent("Read more at https://example.com/post", {
      ...DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG,
      validateLinkPreviews: true
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.urls).toEqual(["https://example.com/post"]);
  });

  it("rejects links that do not look previewable", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      lintLinkedInPostContent("Read more at https://example.com/post", {
        ...DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG,
        validateLinkPreviews: true
      })
    ).rejects.toMatchObject({
      message: "Link preview validation failed for https://example.com/post.",
      details: {
        invalid_links: [
          {
            url: "https://example.com/post"
          }
        ]
      }
    });
  });

  it("loads lint config from config.json and env overrides", () => {
    const baseDir = createTempBaseDir();
    writeFileSync(
      path.join(baseDir, "config.json"),
      JSON.stringify({
        postSafetyLint: {
          maxLength: 2800,
          bannedPhrases: ["reach out", "circle back"],
          validateLinkPreviews: true,
          linkPreviewValidationTimeoutMs: 7000
        }
      })
    );

    expect(resolveLinkedInPostSafetyLintConfig(baseDir)).toEqual({
      maxLength: 2800,
      bannedPhrases: ["reach out", "circle back"],
      validateLinkPreviews: true,
      linkPreviewValidationTimeoutMs: 7000
    });

    process.env.LINKEDIN_ASSISTANT_POST_SAFETY_MAX_LENGTH = "2500";
    process.env.LINKEDIN_ASSISTANT_POST_SAFETY_BANNED_PHRASES = "urgent, follow up";
    process.env.LINKEDIN_ASSISTANT_POST_SAFETY_VALIDATE_LINK_PREVIEWS = "false";
    process.env.LINKEDIN_ASSISTANT_POST_SAFETY_LINK_TIMEOUT_MS = "4000";

    expect(resolveLinkedInPostSafetyLintConfig(baseDir)).toEqual({
      maxLength: 2500,
      bannedPhrases: ["urgent", "follow up"],
      validateLinkPreviews: false,
      linkPreviewValidationTimeoutMs: 4000
    });
  });

  it("blocks prepareCreate before authentication when lint fails", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInPostsService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      rateLimiter: {},
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      },
      postSafetyLint: {
        ...DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG,
        bannedPhrases: ["forbidden phrase"]
      }
    } as never);

    await expect(
      service.prepareCreate({
        text: "This post contains a forbidden phrase."
      })
    ).rejects.toThrow('Post text contains banned phrase "forbidden phrase".');

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("blocks prepareCreateMedia before authentication when a media file is missing", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInPostsService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      rateLimiter: {},
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      },
      postSafetyLint: DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG
    } as never);

    await expect(
      service.prepareCreateMedia({
        text: "Post with missing media",
        mediaPaths: ["./does-not-exist.png"]
      })
    ).rejects.toThrow("Media file does not exist");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("blocks prepareCreatePoll before authentication when options are invalid", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInPostsService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      rateLimiter: {},
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      },
      postSafetyLint: DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG
    } as never);

    await expect(
      service.prepareCreatePoll({
        question: "Which option?",
        options: ["Same", "same"]
      })
    ).rejects.toThrow("options must be distinct");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("blocks prepareEdit before authentication when lint fails", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInPostsService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      rateLimiter: {},
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      },
      postSafetyLint: {
        ...DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG,
        bannedPhrases: ["forbidden phrase"]
      }
    } as never);

    await expect(
      service.prepareEdit({
        postUrl: "1234567890",
        text: "This edited post contains a forbidden phrase."
      })
    ).rejects.toThrow('Post text contains banned phrase "forbidden phrase".');

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("blocks prepareDelete before authentication when postUrl is blank", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInPostsService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      rateLimiter: {},
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      },
      postSafetyLint: DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG
    } as never);

    await expect(
      service.prepareDelete({
        postUrl: "   "
      })
    ).rejects.toThrow("postUrl is required");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });
});

describe("verifyPublishedPost", () => {
  it("treats a visible role-main surface as a ready feed surface", async () => {
    const feedUrl = "https://www.linkedin.com/feed/";
    const page = createMockPublishedPostPage(
      {
        [feedUrl]: {
          visibleSelectors: ["main[role='main']"]
        }
      },
      feedUrl
    );

    await expect(waitForFeedSurface(page)).resolves.toBeUndefined();
  });

  it("falls back to the profile activity page when feed verification misses the new post", async () => {
    const feedUrl = "https://www.linkedin.com/feed/";
    const activityUrl = "https://www.linkedin.com/in/me/recent-activity/all/";
    const publishedPostUrl = "https://www.linkedin.com/feed/update/urn:li:activity:123/";
    const page = createMockPublishedPostPage(
      {
        [feedUrl]: {
          visibleSelectors: ["main[role='main']"]
        },
        [activityUrl]: {
          visibleSelectors: ["main[role='main']"],
          hasSnippet: true,
          publishedPostUrl
        }
      },
      feedUrl
    );

    const result = await verifyPublishedPost(page, "Test post from LinkedIn Buddy", []);

    expect(result.verified).toBe(true);
    expect(result.surface).toBe("profile_activity");
    expect(result.postUrl).toBe(publishedPostUrl);
    expect(page.goto).toHaveBeenCalledWith(activityUrl, {
      waitUntil: "domcontentloaded"
    });
  });
});
