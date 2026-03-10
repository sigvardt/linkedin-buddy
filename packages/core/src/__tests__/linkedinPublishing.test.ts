import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  CREATE_ARTICLE_ACTION_TYPE,
  CREATE_NEWSLETTER_ACTION_TYPE,
  LINKEDIN_NEWSLETTER_CADENCE_MAP,
  LINKEDIN_NEWSLETTER_CADENCE_TYPES,
  PUBLISH_ARTICLE_ACTION_TYPE,
  PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
  createPublishingActionExecutors,
  normalizeLinkedInNewsletterCadence,
  parseLinkedInNewsletterList,
  resolveLinkedInArticleUrl,
  resolveLinkedInNewsletterUrl
} from "../linkedinPublishing.js";

describe("publishing action type constants", () => {
  it("exposes stable article and newsletter action types", () => {
    expect(CREATE_ARTICLE_ACTION_TYPE).toBe("article.create");
    expect(PUBLISH_ARTICLE_ACTION_TYPE).toBe("article.publish");
    expect(CREATE_NEWSLETTER_ACTION_TYPE).toBe("newsletter.create");
    expect(PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE).toBe("newsletter.publish_issue");
  });
});

describe("createPublishingActionExecutors", () => {
  it("registers all long-form publishing executors", () => {
    const executors = createPublishingActionExecutors();

    expect(Object.keys(executors)).toHaveLength(4);
    expect(executors[CREATE_ARTICLE_ACTION_TYPE]).toBeDefined();
    expect(executors[PUBLISH_ARTICLE_ACTION_TYPE]).toBeDefined();
    expect(executors[CREATE_NEWSLETTER_ACTION_TYPE]).toBeDefined();
    expect(executors[PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]).toBeDefined();
  });

  it("exposes execute methods for every publishing executor", () => {
    const executors = createPublishingActionExecutors();

    for (const executor of Object.values(executors)) {
      expect(typeof executor.execute).toBe("function");
    }
  });
});

describe("newsletter cadence normalization", () => {
  it("supports the public cadence values and labels", () => {
    expect(LINKEDIN_NEWSLETTER_CADENCE_TYPES).toEqual([
      "daily",
      "weekly",
      "biweekly",
      "monthly"
    ]);
    expect(LINKEDIN_NEWSLETTER_CADENCE_MAP.weekly.label).toBe("Weekly");
    expect(LINKEDIN_NEWSLETTER_CADENCE_MAP.biweekly.keyboardShortcut).toBe("b");
  });

  it("normalizes common cadence aliases", () => {
    expect(normalizeLinkedInNewsletterCadence("DAILY")).toBe("daily");
    expect(normalizeLinkedInNewsletterCadence("week")).toBe("weekly");
    expect(normalizeLinkedInNewsletterCadence("bi-weekly")).toBe("biweekly");
    expect(normalizeLinkedInNewsletterCadence("twice monthly")).toBe(
      "biweekly"
    );
    expect(normalizeLinkedInNewsletterCadence("monthly")).toBe("monthly");
  });

  it("falls back to weekly when cadence is omitted", () => {
    expect(normalizeLinkedInNewsletterCadence(undefined)).toBe("weekly");
    expect(normalizeLinkedInNewsletterCadence("   ")).toBe("weekly");
  });

  it("throws for unsupported cadence values", () => {
    expect(() => normalizeLinkedInNewsletterCadence("quarterly")).toThrow(
      "cadence must be one of"
    );
  });
});

describe("publishing url resolution", () => {
  it("accepts article draft ids and LinkedIn article urls", () => {
    expect(resolveLinkedInArticleUrl("7437162597893689344")).toBe(
      "https://www.linkedin.com/article/edit/7437162597893689344/"
    );
    expect(
      resolveLinkedInArticleUrl(
        "https://www.linkedin.com/article/edit/7437162597893689344/"
      )
    ).toBe("https://www.linkedin.com/article/edit/7437162597893689344/");
    expect(
      resolveLinkedInArticleUrl("https://www.linkedin.com/pulse/some-article/")
    ).toBe("https://www.linkedin.com/pulse/some-article/");
  });

  it("accepts newsletter ids and LinkedIn newsletter urls", () => {
    expect(resolveLinkedInNewsletterUrl("7437164997367160832")).toBe(
      "https://www.linkedin.com/newsletters/7437164997367160832/"
    );
    expect(
      resolveLinkedInNewsletterUrl(
        "https://www.linkedin.com/newsletters/probe-nl-1773158307173-7437164997367160832"
      )
    ).toBe(
      "https://www.linkedin.com/newsletters/probe-nl-1773158307173-7437164997367160832"
    );
  });

  it("rejects non-LinkedIn publishing urls", () => {
    expect(() => resolveLinkedInArticleUrl("https://example.com/article/123")).toThrow(
      "linkedin.com"
    );
    expect(() =>
      resolveLinkedInNewsletterUrl("https://example.com/newsletters/123")
    ).toThrow("linkedin.com");
  });
});

describe("parseLinkedInNewsletterList", () => {
  it("filters evaluated results down to LinkedIn newsletter urls", async () => {
    const page = {
      evaluate: vi.fn(async () => [
        {
          title: "Newsletter One",
          url: "https://www.linkedin.com/newsletters/7437164997367160832/"
        },
        {
          description: "Ignore this invalid row",
          title: "Bad Newsletter",
          url: "https://example.com/newsletters/123"
        }
      ])
    } as unknown as Page;

    const items = await parseLinkedInNewsletterList(page);

    expect(items).toEqual([
      {
        title: "Newsletter One",
        url: "https://www.linkedin.com/newsletters/7437164997367160832/"
      }
    ]);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});
