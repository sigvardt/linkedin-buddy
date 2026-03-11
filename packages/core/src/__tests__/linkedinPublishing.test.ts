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
