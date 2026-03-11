import { describe, expect, it, vi } from "vitest";
import {
  CREATE_ARTICLE_ACTION_TYPE,
  CREATE_NEWSLETTER_ACTION_TYPE,
  LINKEDIN_NEWSLETTER_CADENCE_TYPES,
  LinkedInArticlesService,
  LinkedInNewslettersService,
  PUBLISH_ARTICLE_ACTION_TYPE,
  PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
  createPublishingActionExecutors
} from "../linkedinPublishing.js";
import { createBlockedRateLimiterStub } from "./rateLimiterTestUtils.js";

function createPublishingConfirmRuntime() {
  const rateLimiter = createBlockedRateLimiterStub();
  const page = {
    screenshot: vi.fn(async () => undefined),
    url: vi.fn(() => "https://www.linkedin.com/publishing/")
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    tracing: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    }
  };
  const runtime = {
    auth: {
      ensureAuthenticated: vi.fn(async () => undefined)
    },
    cdpUrl: undefined,
    selectorLocale: "en",
    profileManager: {
      runWithContext: vi.fn(async (_options: unknown, callback: (ctx: typeof context) => unknown) =>
        callback(context)
      )
    },
    rateLimiter,
    logger: {
      log: vi.fn()
    },
    artifacts: {
      resolve: vi.fn((relativePath: string) => `/tmp/${relativePath}`),
      registerArtifact: vi.fn()
    }
  };

  return {
    page,
    rateLimiter,
    runtime
  };
}

describe("publishing action type constants", () => {
  it("uses stable action identifiers for article and newsletter flows", () => {
    expect(CREATE_ARTICLE_ACTION_TYPE).toBe("article.create");
    expect(PUBLISH_ARTICLE_ACTION_TYPE).toBe("article.publish");
    expect(CREATE_NEWSLETTER_ACTION_TYPE).toBe("newsletter.create");
    expect(PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE).toBe("newsletter.publish_issue");
  });
});

describe("createPublishingActionExecutors", () => {
  it("registers all long-form publishing executors", () => {
    const executors = createPublishingActionExecutors();

    expect(Object.keys(executors)).toEqual([
      CREATE_ARTICLE_ACTION_TYPE,
      PUBLISH_ARTICLE_ACTION_TYPE,
      CREATE_NEWSLETTER_ACTION_TYPE,
      PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE
    ]);
    expect(typeof executors[CREATE_ARTICLE_ACTION_TYPE]?.execute).toBe("function");
    expect(typeof executors[PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]?.execute).toBe(
      "function"
    );
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
            profile_name: "default"
          },
          payload: {
            title: "Title",
            body: "Body"
          }
        }
      },
      {
        actionType: PUBLISH_ARTICLE_ACTION_TYPE,
        counterKey: "linkedin.article.publish",
        action: {
          id: "act-article-publish",
          target: {
            profile_name: "default"
          },
          payload: {
            draft_url: "https://www.linkedin.com/pulse/edit/123/"
          }
        }
      },
      {
        actionType: CREATE_NEWSLETTER_ACTION_TYPE,
        counterKey: "linkedin.newsletter.create",
        action: {
          id: "act-newsletter-create",
          target: {
            profile_name: "default"
          },
          payload: {
            title: "Builder Brief",
            description: "Weekly notes.",
            cadence: "weekly"
          }
        }
      },
      {
        actionType: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
        counterKey: "linkedin.newsletter.publish_issue",
        action: {
          id: "act-newsletter-issue",
          target: {
            profile_name: "default"
          },
          payload: {
            newsletter_title: "Builder Brief",
            title: "March update",
            body: "Long-form issue body."
          }
        }
      }
    ] as const;

    for (const testCase of cases) {
      const { page, rateLimiter, runtime } = createPublishingConfirmRuntime();

      await expect(
        executors[testCase.actionType]!.execute({
          runtime,
          action: testCase.action
        } as never)
      ).rejects.toMatchObject({
        code: "RATE_LIMITED",
        details: {
          rate_limit: {
            counter_key: testCase.counterKey
          }
        }
      });

      expect(rateLimiter.consume).toHaveBeenCalledWith(
        expect.objectContaining({
          counterKey: testCase.counterKey
        })
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
      "monthly"
    ]);
  });
});

describe("LinkedInArticlesService validation", () => {
  it("rejects invalid article titles before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      }
    } as never);

    await expect(
      service.prepareCreate({
        title: "   ",
        body: "Valid article body."
      })
    ).rejects.toThrow("Article title must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects non-LinkedIn draft URLs before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInArticlesService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      }
    } as never);

    await expect(
      service.preparePublish({
        draftUrl: "https://example.com/article/123"
      })
    ).rejects.toThrow("draftUrl must point to linkedin.com.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });
});

describe("LinkedInNewslettersService validation", () => {
  it("rejects invalid cadences before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      }
    } as never);

    await expect(
      service.prepareCreate({
        title: "Builder Brief",
        description: "Weekly notes.",
        cadence: "quarterly"
      })
    ).rejects.toThrow("cadence must be one of");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects missing newsletter titles before authentication", async () => {
    const ensureAuthenticated = vi.fn();
    const service = new LinkedInNewslettersService({
      auth: {
        ensureAuthenticated
      },
      cdpUrl: undefined,
      profileManager: {},
      logger: {
        log: vi.fn()
      },
      artifacts: {},
      twoPhaseCommit: {
        prepare: vi.fn()
      }
    } as never);

    await expect(
      service.preparePublishIssue({
        newsletter: "   ",
        title: "March update",
        body: "Long-form issue body."
      })
    ).rejects.toThrow("newsletter must not be empty.");

    expect(ensureAuthenticated).not.toHaveBeenCalled();
  });
});
