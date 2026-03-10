import { describe, expect, it } from "vitest";
import {
  CREATE_ARTICLE_ACTION_TYPE,
  CREATE_NEWSLETTER_ACTION_TYPE,
  LINKEDIN_NEWSLETTER_CADENCES,
  PUBLISH_ARTICLE_ACTION_TYPE,
  PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
  createArticleActionExecutors,
  normalizeLinkedInArticleDraftUrl,
  normalizeLinkedInNewsletterCadence,
  normalizeLinkedInNewsletterUrl
} from "../linkedinArticles.js";

describe("createArticleActionExecutors", () => {
  it("registers article and newsletter action executors", () => {
    const executors = createArticleActionExecutors();

    expect(Object.keys(executors)).toHaveLength(4);
    expect(executors[CREATE_ARTICLE_ACTION_TYPE]).toBeDefined();
    expect(executors[PUBLISH_ARTICLE_ACTION_TYPE]).toBeDefined();
    expect(executors[CREATE_NEWSLETTER_ACTION_TYPE]).toBeDefined();
    expect(executors[PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]).toBeDefined();
    expect(typeof executors[CREATE_ARTICLE_ACTION_TYPE]?.execute).toBe("function");
  });
});

describe("normalizeLinkedInNewsletterCadence", () => {
  it("accepts the supported cadence values", () => {
    expect(LINKEDIN_NEWSLETTER_CADENCES).toEqual([
      "daily",
      "weekly",
      "biweekly",
      "monthly"
    ]);
    expect(normalizeLinkedInNewsletterCadence("daily")).toBe("daily");
    expect(normalizeLinkedInNewsletterCadence("WEEKLY")).toBe("weekly");
    expect(normalizeLinkedInNewsletterCadence("twice_month")).toBe(
      "biweekly"
    );
    expect(normalizeLinkedInNewsletterCadence("monthly")).toBe("monthly");
  });

  it("rejects unsupported cadence values", () => {
    expect(() => normalizeLinkedInNewsletterCadence("quarterly")).toThrow(
      "cadence must be one of"
    );
  });
});

describe("long-form URL normalization", () => {
  it("normalizes LinkedIn article draft URLs", () => {
    expect(
      normalizeLinkedInArticleDraftUrl(
        "https://www.linkedin.com/article/edit/123/?foo=bar#hash"
      )
    ).toBe("https://www.linkedin.com/article/edit/123/?foo=bar");
    expect(normalizeLinkedInArticleDraftUrl("/article/edit/123/")).toBe(
      "https://www.linkedin.com/article/edit/123/"
    );
  });

  it("rejects non-article URLs", () => {
    expect(() =>
      normalizeLinkedInArticleDraftUrl("https://www.linkedin.com/feed/")
    ).toThrow("articleUrl must point to linkedin.com/article/");
  });

  it("normalizes LinkedIn newsletter URLs", () => {
    expect(
      normalizeLinkedInNewsletterUrl(
        "https://www.linkedin.com/newsletters/test-123?foo=bar#hash"
      )
    ).toBe("https://www.linkedin.com/newsletters/test-123/?foo=bar");
    expect(normalizeLinkedInNewsletterUrl("/newsletters/test-123")).toBe(
      "https://www.linkedin.com/newsletters/test-123/"
    );
  });

  it("rejects non-newsletter URLs", () => {
    expect(() =>
      normalizeLinkedInNewsletterUrl("https://www.linkedin.com/article/edit/123/")
    ).toThrow("newsletterUrl must point to linkedin.com/newsletters/");
  });
});
