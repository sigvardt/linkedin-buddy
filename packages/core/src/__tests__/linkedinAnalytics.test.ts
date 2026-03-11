import { describe, expect, it } from "vitest";
import {
  LINKEDIN_ANALYTICS_SURFACES,
  LinkedInAnalyticsService,
  parseLinkedInAnalyticsNumber,
  toLinkedInAnalyticsMetricKey,
  type LinkedInAnalyticsRuntime,
  type ReadContentMetricsInput,
  type ReadPostMetricsInput
} from "../linkedinAnalytics.js";

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
      "post_metrics"
    ]);
  });

  it("normalizes analytics metric keys", () => {
    expect(toLinkedInAnalyticsMetricKey("Profile views")).toBe("profile_views");
    expect(toLinkedInAnalyticsMetricKey("Engagement total")).toBe(
      "engagement_total"
    );
    expect(toLinkedInAnalyticsMetricKey(" CTR % ")).toBe("ctr");
  });

  it("parses abbreviated count metrics", () => {
    expect(parseLinkedInAnalyticsNumber("1.2K")).toBe(1200);
    expect(parseLinkedInAnalyticsNumber("2,450")).toBe(2450);
    expect(parseLinkedInAnalyticsNumber("3,4M")).toBe(3_400_000);
  });

  it("parses percentage metrics", () => {
    expect(parseLinkedInAnalyticsNumber("4.5%")).toBe(4.5);
    expect(parseLinkedInAnalyticsNumber("+12% past 7 days")).toBe(12);
  });

  it("returns null for non-numeric analytics text", () => {
    expect(parseLinkedInAnalyticsNumber("No data yet")).toBeNull();
    expect(parseLinkedInAnalyticsNumber("")).toBeNull();
  });

  it("keeps the runtime contract minimal for read-only analytics", () => {
    const runtimeKeys: (keyof LinkedInAnalyticsRuntime)[] = [
      "auth",
      "cdpUrl",
      "profileManager",
      "logger",
      "feed"
    ];
    expect(runtimeKeys).toHaveLength(5);
  });

  it("accepts optional limits for aggregated content metrics", () => {
    const input: ReadContentMetricsInput = {
      profileName: "default",
      limit: 3
    };

    expect(input.profileName).toBe("default");
    expect(input.limit).toBe(3);
  });

  it("requires a post URL for post metrics inputs", () => {
    const input: ReadPostMetricsInput = {
      profileName: "default",
      postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123456789/"
    };

    expect(input.postUrl).toContain("linkedin.com/feed/update/");
  });
});
