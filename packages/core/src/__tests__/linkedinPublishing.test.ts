import { describe, expect, it, vi } from "vitest";
import {
  ARTICLE_BODY_MAX_LENGTH,
  ARTICLE_TITLE_MAX_LENGTH,
  CREATE_ARTICLE_ACTION_TYPE,
  CREATE_NEWSLETTER_ACTION_TYPE,
  LINKEDIN_NEWSLETTER_CADENCE_TYPES,
  LinkedInArticlesService,
  LinkedInNewslettersService,
  NEWSLETTER_DESCRIPTION_MAX_LENGTH,
  NEWSLETTER_ISSUE_BODY_MAX_LENGTH,
  NEWSLETTER_ISSUE_TITLE_MAX_LENGTH,
  NEWSLETTER_TITLE_MAX_LENGTH,
  PUBLISH_ARTICLE_ACTION_TYPE,
  PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
  createPublishingActionExecutors,
} from "../linkedinPublishing.js";
import { createBlockedRateLimiterStub } from "./rateLimiterTestUtils.js";

function createPublishingConfirmRuntime() {
  const rateLimiter = createBlockedRateLimiterStub();
  const page = {
    screenshot: vi.fn(async () => undefined),
    url: vi.fn(() => "https://www.linkedin.com/publishing/"),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    tracing: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
  };
  const runtime = {
    auth: {
      ensureAuthenticated: vi.fn(async () => undefined),
    },
    cdpUrl: undefined,
    selectorLocale: "en",
    profileManager: {
      runWithContext: vi.fn(
        async (_options: unknown, callback: (ctx: typeof context) => unknown) =>
          callback(context),
      ),
    },
    rateLimiter,
    logger: {
      log: vi.fn(),
    },
    artifacts: {
      resolve: vi.fn((relativePath: string) => `/tmp/${relativePath}`),
      registerArtifact: vi.fn(),
    },
  };

  return {
    page,
    rateLimiter,
    runtime,
  };
}

describe("publishing action type constants", () => {
  it("uses stable action identifiers for article and newsletter flows", () => {
    expect(CREATE_ARTICLE_ACTION_TYPE).toBe("article.create");
    expect(PUBLISH_ARTICLE_ACTION_TYPE).toBe("article.publish");
    expect(CREATE_NEWSLETTER_ACTION_TYPE).toBe("newsletter.create");
    expect(PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE).toBe(
      "newsletter.publish_issue",
    );
  });
});

describe("createPublishingActionExecutors", () => {
  it("registers all long-form publishing executors", () => {
    const executors = createPublishingActionExecutors();

    expect(Object.keys(executors)).toEqual([
      CREATE_ARTICLE_ACTION_TYPE,
      PUBLISH_ARTICLE_ACTION_TYPE,
      CREATE_NEWSLETTER_ACTION_TYPE,
      PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
    ]);
    expect(typeof executors[CREATE_ARTICLE_ACTION_TYPE]?.execute).toBe(
      "function",
    );
    expect(
      typeof executors[PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]?.execute,
    ).toBe("function");
  });

  it("rejects confirm execution locally when publishing actions are rate limited", async () => {
    const executors = createPublishingActionExecutors();
    const cases = [
      {
        actionType: CREATE_ARTICLE_ACTION_TYPE,
        counterKey: "linkedin.article.create",
        action: {
          id: "act-article-create",
          target: {
            profile_name: "default",
          },
          payload: {
            title: "Title",
            body: "Body",
          },
        },
      },
      {
        actionType: PUBLISH_ARTICLE_ACTION_TYPE,
        counterKey: "linkedin.article.publish",
        action: {
          id: "act-article-publish",
          target: {
            profile_name: "default",
          },
          payload: {
            draft_url: "https://www.linkedin.com/pulse/edit/123/",
          },
        },
      },
      {
        actionType: CREATE_NEWSLETTER_ACTION_TYPE,
        counterKey: "linkedin.newsletter.create",
        action: {
          id: "act-newsletter-create",
          target: {
            profile_name: "default",
          },
          payload: {
            title: "Builder Brief",
            description: "Weekly notes.",
            cadence: "weekly",
          },
        },
      },
      {
        actionType: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
        counterKey: "linkedin.newsletter.publish_issue",
        action: {
          id: "act-newsletter-issue",
          target: {
            profile_name: "default",
          },
          payload: {
            newsletter_title: "Builder Brief",
            title: "March update",
            body: "Long-form issue body.",
          },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { page, rateLimiter, runtime } = createPublishingConfirmRuntime();

      await expect(
        executors[testCase.actionType]!.execute({
          runtime,
          action: testCase.action,
        } as never),
      ).rejects.toMatchObject({
        code: "RATE_LIMITED",
        details: {
          rate_limit: {
            counter_key: testCase.counterKey,
          },
        },
      });

      expect(rateLimiter.consume).toHaveBeenCalledWith(
        expect.objectContaining({
          counterKey: testCase.counterKey,
        }),
      );
      expect(page.screenshot).toHaveBeenCalled();
    }
  });
});

describe("newsletter cadence surface", () => {
  it("exposes the supported cadence values", () => {
    expect(LINKEDIN_NEWSLETTER_CADENCE_TYPES).toEqual([
      "daily",
      "weekly",
      "biweekly",
      "monthly",
    ]);
  });
});

describe("LinkedInArticlesService validation", () => {
  it("rejects invalid article titles before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "   ",
        body: "Valid article body.",
      }),
    ).rejects.toThrow("Article title must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects non-LinkedIn draft URLs before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublish({
        draftUrl: "https://example.com/article/123",
      }),
    ).rejects.toThrow("draftUrl must point to linkedin.com.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects URL-only article titles before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "https://example.com/title",
        body: "Valid article body.",
      }),
    ).rejects.toThrow("Article title must be descriptive text, not a URL.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects article titles with control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Invalid\u0007title",
        body: "Valid article body.",
      }),
    ).rejects.toThrow("Article title contains unsupported control characters.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects article titles that exceed max length before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "a".repeat(ARTICLE_TITLE_MAX_LENGTH + 1),
        body: "Valid article body.",
      }),
    ).rejects.toThrow("exceeds maximum length of 150");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects empty article body before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Valid title",
        body: "   ",
      }),
    ).rejects.toThrow("Article body must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects article body with control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Valid title",
        body: "Invalid body\u0007",
      }),
    ).rejects.toThrow("Article body contains unsupported control characters.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects article body that exceeds max length before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Valid title",
        body: "a".repeat(ARTICLE_BODY_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow("exceeds maximum length of 125000");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("accepts valid article create inputs and proceeds to authentication", async () => {
    const ensureAuthenticated = vi.fn(async () => undefined);
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Valid article title",
        body: "Valid article body.",
      }),
    ).rejects.toThrow();

    expect(ensureAuthenticated).toHaveBeenCalled();
  });

  it("rejects empty draft URLs before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublish({
        draftUrl: "   ",
      }),
    ).rejects.toThrow("draftUrl must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects non-URL draft URL strings before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublish({
        draftUrl: "not-a-url",
      }),
    ).rejects.toThrow("Invalid URL");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("accepts valid LinkedIn draft URLs and proceeds to authentication", async () => {
    const ensureAuthenticated = vi.fn(async () => undefined);
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublish({
        draftUrl: "https://www.linkedin.com/pulse/edit/123/",
      }),
    ).rejects.toThrow();

    expect(ensureAuthenticated).toHaveBeenCalled();
  });

  it("treats newline-only article titles as empty before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "\n\n",
        body: "Valid article body.",
      }),
    ).rejects.toThrow("Article title must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects article titles with bell control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Bad\u0007title",
        body: "Valid article body.",
      }),
    ).rejects.toThrow("Article title contains unsupported control characters.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects article bodies with vertical tab control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Valid article title",
        body: "Bad\u000bbody",
      }),
    ).rejects.toThrow("Article body contains unsupported control characters.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("treats draftUrl with only tabs as empty before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublish({
        draftUrl: "\t\t",
      }),
    ).rejects.toThrow("draftUrl must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });
});

describe("LinkedInNewslettersService validation", () => {
  it("rejects invalid cadences before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "Weekly notes.",
        cadence: "quarterly",
      }),
    ).rejects.toThrow("cadence must be one of");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects missing newsletter titles before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "   ",
        title: "March update",
        body: "Long-form issue body.",
      }),
    ).rejects.toThrow("newsletter must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects empty newsletter title on create before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "   ",
        description: "Weekly notes.",
        cadence: "weekly",
      }),
    ).rejects.toThrow("Newsletter title must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects URL-only newsletter title before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "https://example.com/newsletter",
        description: "Weekly notes.",
        cadence: "weekly",
      }),
    ).rejects.toThrow("Newsletter title must be descriptive text, not a URL.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects newsletter title with control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder\u0007Brief",
        description: "Weekly notes.",
        cadence: "weekly",
      }),
    ).rejects.toThrow(
      "Newsletter title contains unsupported control characters.",
    );

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects newsletter title that exceeds max length before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "a".repeat(NEWSLETTER_TITLE_MAX_LENGTH + 1),
        description: "Weekly notes.",
        cadence: "weekly",
      }),
    ).rejects.toThrow("exceeds maximum length of 64");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects empty newsletter description before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "   ",
        cadence: "weekly",
      }),
    ).rejects.toThrow("Newsletter description must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects newsletter description that exceeds max length before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "a".repeat(NEWSLETTER_DESCRIPTION_MAX_LENGTH + 1),
        cadence: "weekly",
      }),
    ).rejects.toThrow("exceeds maximum length of 300");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("accepts case-insensitive cadence values and proceeds to authentication", async () => {
    const ensureAuthenticated = vi.fn(async () => undefined);
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "Weekly notes.",
        cadence: "Weekly",
      }),
    ).rejects.toThrow();

    expect(ensureAuthenticated).toHaveBeenCalled();
  });

  it("accepts cadence aliases and proceeds to authentication", async () => {
    const ensureAuthenticated = vi.fn(async () => undefined);
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "Weekly notes.",
        cadence: "every week",
      }),
    ).rejects.toThrow();

    expect(ensureAuthenticated).toHaveBeenCalled();
  });

  it("accepts valid newsletter create inputs and proceeds to authentication", async () => {
    const ensureAuthenticated = vi.fn(async () => undefined);
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "Weekly notes.",
        cadence: "weekly",
      }),
    ).rejects.toThrow();

    expect(ensureAuthenticated).toHaveBeenCalled();
  });

  it("rejects empty issue title before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "   ",
        body: "Issue body",
      }),
    ).rejects.toThrow("Issue title must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects URL-only issue titles before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "https://example.com/issue",
        body: "Issue body",
      }),
    ).rejects.toThrow("Issue title must be descriptive text, not a URL.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects issue titles with control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "Issue\u0007title",
        body: "Issue body",
      }),
    ).rejects.toThrow("Issue title contains unsupported control characters.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects issue titles that exceed max length before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "a".repeat(NEWSLETTER_ISSUE_TITLE_MAX_LENGTH + 1),
        body: "Issue body",
      }),
    ).rejects.toThrow("exceeds maximum length of 150");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects empty issue body before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "March update",
        body: "   ",
      }),
    ).rejects.toThrow("Issue body must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects issue body with control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "March update",
        body: "Issue body\u0007",
      }),
    ).rejects.toThrow("Issue body contains unsupported control characters.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects issue body that exceeds max length before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "March update",
        body: "a".repeat(NEWSLETTER_ISSUE_BODY_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow("exceeds maximum length of 125000");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("accepts valid issue publish inputs and proceeds to authentication", async () => {
    const ensureAuthenticated = vi.fn(async () => undefined);
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "March update",
        body: "Long-form issue body.",
      }),
    ).rejects.toThrow();

    expect(ensureAuthenticated).toHaveBeenCalled();
  });

  it("treats whitespace-only newsletter descriptions as empty before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "\n\t\n",
        cadence: "weekly",
      }),
    ).rejects.toThrow("Newsletter description must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects newsletter titles with bell control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder\u0007Brief",
        description: "Weekly notes.",
        cadence: "weekly",
      }),
    ).rejects.toThrow(
      "Newsletter title contains unsupported control characters.",
    );

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects issue titles with bell control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "Issue\u0007title",
        body: "Issue body",
      }),
    ).rejects.toThrow("Issue title contains unsupported control characters.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("treats newline-only issue titles as empty before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "\n\n",
        body: "Issue body",
      }),
    ).rejects.toThrow("Issue title must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("treats tab-only newsletter names as empty before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "\t\t",
        title: "March update",
        body: "Issue body",
      }),
    ).rejects.toThrow("newsletter must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("accepts normalized cadence alias with mixed spacing before authentication", async () => {
    const ensureAuthenticated = vi.fn(async () => undefined);
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "Weekly notes.",
        cadence: "Every_Week",
      }),
    ).rejects.toThrow();

    expect(ensureAuthenticated).toHaveBeenCalled();
  });

  it("rejects newsletter descriptions with control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "Bad\u0007description",
        cadence: "weekly",
      }),
    ).rejects.toThrow(
      "Newsletter description contains unsupported control characters.",
    );

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects URL-only newsletter descriptions before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "https://example.com/description",
        cadence: "weekly",
      }),
    ).rejects.toThrow(
      "Newsletter description must be descriptive text, not a URL.",
    );

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects issue body with bell control characters before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "March update",
        body: "Issue body\u0007",
      }),
    ).rejects.toThrow("Issue body contains unsupported control characters.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("treats newsletter title with only tabs and spaces as empty before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.prepareCreate({
        title: " \t ",
        description: "Weekly notes.",
        cadence: "weekly",
      }),
    ).rejects.toThrow("Newsletter title must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("treats issue body with only newlines and tabs as empty before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated,
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn(),
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "Builder Brief",
        title: "March update",
        body: "\n\t\n",
      }),
    ).rejects.toThrow("Issue body must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });
});
