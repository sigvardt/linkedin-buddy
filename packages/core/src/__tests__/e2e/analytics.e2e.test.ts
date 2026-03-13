import { describe, expect, it } from "vitest";
import type {
  LinkedInAnalyticsCard,
  LinkedInAnalyticsMetric,
  LinkedInAnalyticsSummary,
  LinkedInPostMetricsSummary
} from "../../linkedinAnalytics.js";
import {
  callMcpTool,
  getDefaultProfileName,
  getFeedPost,
  MCP_TOOL_NAMES
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const VALID_UNITS = new Set(["count", "percent", "unknown"]);
const VALID_TRENDS = new Set(["up", "down", "flat", "unknown"]);

function expectValidMetric(metric: LinkedInAnalyticsMetric): void {
  expect(typeof metric.metric_key).toBe("string");
  expect(metric.metric_key.length).toBeGreaterThan(0);
  expect(typeof metric.label).toBe("string");
  expect(metric.label.length).toBeGreaterThan(0);
  expect(
    metric.value === null || typeof metric.value === "number"
  ).toBe(true);
  expect(typeof metric.value_text).toBe("string");
  expect(
    metric.delta_value === null || typeof metric.delta_value === "number"
  ).toBe(true);
  expect(
    metric.delta_text === null || typeof metric.delta_text === "string"
  ).toBe(true);
  expect(VALID_UNITS.has(metric.unit)).toBe(true);
  expect(VALID_TRENDS.has(metric.trend)).toBe(true);
  expect(typeof metric.observed_at).toBe("string");
  expect(metric.observed_at.length).toBeGreaterThan(0);
}

function expectValidCard(card: LinkedInAnalyticsCard): void {
  expect(typeof card.card_key).toBe("string");
  expect(card.card_key.length).toBeGreaterThan(0);
  expect(typeof card.title).toBe("string");
  expect(card.title.length).toBeGreaterThan(0);
  expect(typeof card.description).toBe("string");
  expect(card.href === null || typeof card.href === "string").toBe(true);
  expect(Array.isArray(card.metrics)).toBe(true);
  for (const metric of card.metrics) {
    expectValidMetric(metric);
  }
}

function expectAnalyticsSummaryShape(
  summary: LinkedInAnalyticsSummary,
  expectedSurface: string
): void {
  expect(summary.surface).toBe(expectedSurface);
  expect(typeof summary.source_url).toBe("string");
  expect(summary.source_url.length).toBeGreaterThan(0);
  expect(typeof summary.observed_at).toBe("string");
  expect(summary.observed_at.length).toBeGreaterThan(0);
  expect(Array.isArray(summary.metrics)).toBe(true);
  expect(Array.isArray(summary.cards)).toBe(true);

  for (const metric of summary.metrics) {
    expectValidMetric(metric);
  }

  for (const card of summary.cards) {
    expectValidCard(card);
  }
}

describe("Analytics E2E", () => {
  const e2e = setupE2ESuite();

  it("getProfileViews returns a valid analytics summary", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const summary = await runtime.analytics.getProfileViews();
    expectAnalyticsSummaryShape(summary, "profile_views");
  }, 60_000);

  it("getSearchAppearances returns a valid analytics summary", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const summary = await runtime.analytics.getSearchAppearances();
    expectAnalyticsSummaryShape(summary, "search_appearances");
  }, 60_000);

  it("getContentMetrics returns a valid analytics summary and respects limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const summary = await runtime.analytics.getContentMetrics({ limit: 3 });
    expectAnalyticsSummaryShape(summary, "content_metrics");
    expect(summary.cards.length).toBeLessThanOrEqual(3);
  }, 60_000);

  it("getPostMetrics returns engagement data for a feed post", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const post = await getFeedPost(runtime);
    const summary: LinkedInPostMetricsSummary =
      await runtime.analytics.getPostMetrics({ postUrl: post.post_url });

    expect(summary.surface).toBe("post_metrics");
    expect(typeof summary.source_url).toBe("string");
    expect(summary.source_url.length).toBeGreaterThan(0);
    expect(typeof summary.observed_at).toBe("string");
    expect(summary.observed_at.length).toBeGreaterThan(0);
    expect(Array.isArray(summary.metrics)).toBe(true);
    expect(Array.isArray(summary.cards)).toBe(true);

    for (const metric of summary.metrics) {
      expectValidMetric(metric);
    }

    for (const card of summary.cards) {
      expectValidCard(card);
    }

    const engagementCard = summary.cards.find(
      (card) => card.card_key === "post_engagement"
    );
    expect(engagementCard).toBeDefined();

    expect(typeof summary.post.post_id).toBe("string");
    expect(typeof summary.post.post_url).toBe("string");
    expect(summary.post.post_url.length).toBeGreaterThan(0);
    expect(typeof summary.post.author_name).toBe("string");
    expect(typeof summary.post.author_headline).toBe("string");
    expect(typeof summary.post.posted_at).toBe("string");
    expect(typeof summary.post.text).toBe("string");

    const metricKeys = summary.metrics.map((metric) => metric.metric_key);
    expect(metricKeys).toContain("engagement_total");
  }, 90_000);
});

describe("Analytics MCP E2E", () => {
  const e2e = setupE2ESuite();
  const profileName = getDefaultProfileName();

  it("MCP profile_views returns a valid summary", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.analyticsProfileViews, {
      profileName
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      surface: "profile_views"
    });
    expect(typeof result.payload.source_url).toBe("string");
    expect(typeof result.payload.observed_at).toBe("string");
    expect(Array.isArray(result.payload.metrics)).toBe(true);
    expect(Array.isArray(result.payload.cards)).toBe(true);
  }, 60_000);

  it("MCP search_appearances returns a valid summary", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(
      MCP_TOOL_NAMES.analyticsSearchAppearances,
      { profileName }
    );

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      surface: "search_appearances"
    });
    expect(typeof result.payload.source_url).toBe("string");
    expect(typeof result.payload.observed_at).toBe("string");
    expect(Array.isArray(result.payload.metrics)).toBe(true);
    expect(Array.isArray(result.payload.cards)).toBe(true);
  }, 60_000);

  it("MCP content_metrics returns a valid summary", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.analyticsContentMetrics, {
      profileName,
      limit: 2
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      surface: "content_metrics"
    });
    expect(typeof result.payload.source_url).toBe("string");
    expect(typeof result.payload.observed_at).toBe("string");
    expect(Array.isArray(result.payload.metrics)).toBe(true);
    expect(Array.isArray(result.payload.cards)).toBe(true);
  }, 60_000);

  it("MCP post_metrics returns engagement data", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const post = await getFeedPost(runtime);
    const result = await callMcpTool(MCP_TOOL_NAMES.analyticsPostMetrics, {
      profileName,
      postUrl: post.post_url
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      surface: "post_metrics"
    });
    expect(typeof result.payload.source_url).toBe("string");
    expect(typeof result.payload.observed_at).toBe("string");
    expect(Array.isArray(result.payload.metrics)).toBe(true);
    expect(Array.isArray(result.payload.cards)).toBe(true);

    const post_data = result.payload.post as Record<string, unknown>;
    expect(typeof post_data.post_url).toBe("string");
    expect(typeof post_data.author_name).toBe("string");
  }, 90_000);
});
