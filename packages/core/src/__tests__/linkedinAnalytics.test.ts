import { describe, expect, it } from "vitest";
import {
  LINKEDIN_ANALYTICS_SURFACES,
  LinkedInAnalyticsService,
  ensureMatchingCards,
  inferAnalyticsMetricTrend,
  inferAnalyticsMetricUnit,
  matchesAnalyticsCard,
  parseLinkedInAnalyticsNumber,
  readAnalyticsLimit,
  toAbsoluteLinkedInUrl,
  toLinkedInAnalyticsMetricKey,
  type LinkedInAnalyticsCard,
  type LinkedInAnalyticsRuntime,
  type ReadContentMetricsInput,
  type ReadPostMetricsInput,
} from "../linkedinAnalytics.js";
import { LinkedInBuddyError } from "../errors.js";

describe("LinkedInAnalyticsService", () => {
  it("exports the service class", () => {
    expect(LinkedInAnalyticsService).toBeDefined();
    expect(typeof LinkedInAnalyticsService).toBe("function");
  });

  it("lists the supported analytics surfaces", () => {
    expect(LINKEDIN_ANALYTICS_SURFACES).toEqual([
      "profile_views",
      "search_appearances",
      "content_metrics",
      "post_metrics",
    ]);
  });

  it("normalizes analytics metric keys", () => {
    expect(toLinkedInAnalyticsMetricKey("Profile views")).toBe("profile_views");
    expect(toLinkedInAnalyticsMetricKey("Engagement total")).toBe(
      "engagement_total",
    );
    expect(toLinkedInAnalyticsMetricKey(" CTR % ")).toBe("ctr");
    expect(toLinkedInAnalyticsMetricKey("")).toBe("metric");
    expect(toLinkedInAnalyticsMetricKey("Click-through Rate (%)")).toBe(
      "click_through_rate",
    );
    expect(toLinkedInAnalyticsMetricKey("___  Mixed___Value  ")).toBe(
      "mixed_value",
    );
    expect(toLinkedInAnalyticsMetricKey("Ünicode   label")).toBe(
      "nicode_label",
    );
  });

  it("parses abbreviated count metrics", () => {
    expect(parseLinkedInAnalyticsNumber("1.2K")).toBe(1200);
    expect(parseLinkedInAnalyticsNumber("2,450")).toBe(2450);
    expect(parseLinkedInAnalyticsNumber("3,4M")).toBe(3_400_000);
    expect(parseLinkedInAnalyticsNumber("2.5B")).toBe(2_500_000_000);
    expect(parseLinkedInAnalyticsNumber("1T")).toBe(1_000_000_000_000);
    expect(parseLinkedInAnalyticsNumber("-5.2K")).toBe(-5200);
  });

  it("parses percentage metrics", () => {
    expect(parseLinkedInAnalyticsNumber("4.5%")).toBe(4.5);
    expect(parseLinkedInAnalyticsNumber("+12% past 7 days")).toBe(12);
    expect(parseLinkedInAnalyticsNumber("+12%")).toBe(12);
  });

  it("parses locale formats and whitespace", () => {
    expect(parseLinkedInAnalyticsNumber("1.234,56")).toBe(1234.56);
    expect(parseLinkedInAnalyticsNumber(" 1,234 ")).toBe(1234);
    expect(parseLinkedInAnalyticsNumber("0")).toBe(0);
  });

  it("returns null for non-numeric analytics text", () => {
    expect(parseLinkedInAnalyticsNumber("No data yet")).toBeNull();
    expect(parseLinkedInAnalyticsNumber("")).toBeNull();
    expect(parseLinkedInAnalyticsNumber("N/A")).toBeNull();
    expect(parseLinkedInAnalyticsNumber("--")).toBeNull();
  });

  it("infers analytics metric units", () => {
    expect(inferAnalyticsMetricUnit("Engagement", "45%")).toBe("percent");
    expect(inferAnalyticsMetricUnit("Engagement rate", "12")).toBe("percent");
    expect(inferAnalyticsMetricUnit("Impressions", "1200")).toBe("count");
    expect(inferAnalyticsMetricUnit("Impressions", "N/A")).toBe("unknown");
  });

  it("infers analytics metric trends", () => {
    expect(inferAnalyticsMetricTrend("+5%")).toBe("up");
    expect(inferAnalyticsMetricTrend("-3 down")).toBe("down");
    expect(inferAnalyticsMetricTrend("flat")).toBe("flat");
    expect(inferAnalyticsMetricTrend("unknown text")).toBe("unknown");
    expect(inferAnalyticsMetricTrend(null)).toBe("unknown");
    expect(inferAnalyticsMetricTrend(undefined)).toBe("unknown");
    expect(inferAnalyticsMetricTrend("")).toBe("unknown");
  });

  it("converts LinkedIn urls to absolute urls", () => {
    expect(toAbsoluteLinkedInUrl("https://www.linkedin.com/in/me/")).toBe(
      "https://www.linkedin.com/in/me/",
    );
    expect(toAbsoluteLinkedInUrl("/in/me/")).toBe(
      "https://www.linkedin.com/in/me/",
    );
    expect(toAbsoluteLinkedInUrl("in/me/")).toBe(
      "https://www.linkedin.com/in/me/",
    );
    expect(toAbsoluteLinkedInUrl(null)).toBeNull();
    expect(toAbsoluteLinkedInUrl("")).toBeNull();
  });

  it("applies analytics limit fallback and bounds", () => {
    expect(readAnalyticsLimit(undefined, 4)).toBe(4);
    expect(readAnalyticsLimit(Number.NaN, 4)).toBe(4);
    expect(readAnalyticsLimit(Number.POSITIVE_INFINITY, 4)).toBe(4);
    expect(readAnalyticsLimit(0.5, 4)).toBe(1);
    expect(readAnalyticsLimit(10, 4)).toBe(10);
    expect(readAnalyticsLimit(100, 4)).toBe(50);
  });

  it("throws UI_CHANGED_SELECTOR_FAILED when no matching cards exist", () => {
    expect(() => ensureMatchingCards("profile_views", [], [])).toThrow(
      LinkedInBuddyError,
    );

    try {
      ensureMatchingCards("profile_views", [], []);
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe(
        "UI_CHANGED_SELECTOR_FAILED",
      );
    }
  });

  it("matches analytics cards with negative keyword filtering", () => {
    const card: LinkedInAnalyticsCard = {
      card_key: "content_analytics",
      title: "Creator analytics",
      description: "Content impressions and engagement",
      href: "https://www.linkedin.com/in/me/",
      metrics: [
        {
          metric_key: "impressions",
          label: "Impressions",
          value: 200,
          value_text: "200",
          delta_value: null,
          delta_text: null,
          unit: "count",
          trend: "unknown",
          observed_at: "2026-03-12T00:00:00.000Z",
        },
      ],
    };

    expect(matchesAnalyticsCard(card, ["creator analytics"])).toBe(true);
    expect(matchesAnalyticsCard(card, ["profile view"])).toBe(false);
    expect(
      matchesAnalyticsCard(card, ["creator analytics"], ["engagement"]),
    ).toBe(false);
  });

  it("keeps the runtime contract minimal for read-only analytics", () => {
    const runtimeKeys: (keyof LinkedInAnalyticsRuntime)[] = [
      "auth",
      "cdpUrl",
      "profileManager",
      "logger",
      "feed",
    ];
    expect(runtimeKeys).toHaveLength(5);
  });

  it("accepts optional limits for aggregated content metrics", () => {
    const input: ReadContentMetricsInput = {
      profileName: "default",
      limit: 3,
    };

    expect(input.profileName).toBe("default");
    expect(input.limit).toBe(3);
  });

  it("requires a post URL for post metrics inputs", () => {
    const input: ReadPostMetricsInput = {
      profileName: "default",
      postUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:123456789/",
    };

    expect(input.postUrl).toContain("linkedin.com/feed/update/");
  });
});
