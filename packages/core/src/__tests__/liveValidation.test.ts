import { describe, expect, it } from "vitest";
import {
  ReadOnlyOperationRateLimiter,
  computeReadOnlyValidationDiff,
  isAllowedLinkedInReadOnlyRequest,
  type ReadOnlyValidationOperationResult,
  type ReadOnlyValidationReport
} from "../liveValidation.js";

function createOperationResult(
  operation: ReadOnlyValidationOperationResult["operation"],
  selectorResults: ReadOnlyValidationOperationResult["selector_results"]
): ReadOnlyValidationOperationResult {
  return {
    completed_at: "2026-03-09T10:00:05.000Z",
    failed_count: selectorResults.filter((result) => result.status === "fail").length,
    final_url: `https://www.linkedin.com/${operation}/`,
    matched_count: selectorResults.filter((result) => result.status === "pass").length,
    operation,
    page_load_ms: 1200,
    selector_results: selectorResults,
    started_at: "2026-03-09T10:00:00.000Z",
    status: selectorResults.some((result) => result.status === "fail")
      ? "fail"
      : "pass",
    summary: `summary:${operation}`,
    url: `https://www.linkedin.com/${operation}/`,
    warnings: []
  };
}

function createReport(
  operations: ReadOnlyValidationOperationResult[],
  reportPath: string
): Pick<ReadOnlyValidationReport, "operations" | "report_path"> {
  return {
    operations,
    report_path: reportPath
  };
}

describe("read-only live validation helpers", () => {
  it("allows only GET requests to LinkedIn-owned domains", () => {
    expect(
      isAllowedLinkedInReadOnlyRequest(
        "https://www.linkedin.com/feed/",
        "GET"
      )
    ).toBe(true);
    expect(
      isAllowedLinkedInReadOnlyRequest(
        "https://media.licdn.com/dms/image/v2/sample",
        "GET"
      )
    ).toBe(true);
    expect(
      isAllowedLinkedInReadOnlyRequest(
        "https://www.linkedin.com/voyager/api/graphql",
        "POST"
      )
    ).toBe(false);
    expect(
      isAllowedLinkedInReadOnlyRequest(
        "https://example.com/tracker.js",
        "GET"
      )
    ).toBe(false);
  });

  it("counts every selector result as unchanged when no previous report exists", () => {
    const currentReport = createReport(
      [
        createOperationResult("feed", [
          {
            description: "Feed content surface",
            matched_candidate_key: "feed-main",
            matched_candidate_rank: 2,
            matched_selector: "main[role='main']",
            selector_key: "feed_surface",
            status: "pass"
          },
          {
            description: "Authenticated global navigation",
            error: "No selector candidate matched global_nav.",
            matched_candidate_key: null,
            matched_candidate_rank: null,
            matched_selector: null,
            selector_key: "global_nav",
            status: "fail"
          }
        ])
      ],
      "/tmp/current.json"
    );

    expect(computeReadOnlyValidationDiff(currentReport, null)).toEqual({
      recoveries: [],
      regressions: [],
      unchanged_count: 2
    });
  });

  it("enforces the per-session request cap and minimum interval", async () => {
    let currentTimeMs = 0;
    const sleepCalls: number[] = [];
    const limiter = new ReadOnlyOperationRateLimiter(
      2,
      5_000,
      () => currentTimeMs,
      async (delayMs) => {
        sleepCalls.push(delayMs);
        currentTimeMs += delayMs;
      }
    );

    await limiter.waitTurn("feed");
    currentTimeMs += 1_000;
    await limiter.waitTurn("profile");

    expect(limiter.getRequestCount()).toBe(2);
    expect(sleepCalls).toEqual([4_000]);
    await expect(limiter.waitTurn("notifications")).rejects.toMatchObject({
      code: "RATE_LIMITED"
    });
  });

  it("rejects non-positive rate-limiter configuration", () => {
    expect(() => new ReadOnlyOperationRateLimiter(0, 5_000)).toThrow(
      "maxRequests must be a positive number."
    );
    expect(() => new ReadOnlyOperationRateLimiter(2, 0)).toThrow(
      "minIntervalMs must be a positive number."
    );
  });

  it("reports new failures, fallback drift, and recoveries against the previous run", () => {
    const previousReport = createReport(
      [
        createOperationResult("feed", [
          {
            description: "Feed content surface",
            matched_candidate_key: "feed-update-card",
            matched_candidate_rank: 0,
            matched_selector: "div.feed-shared-update-v2",
            selector_key: "feed_surface",
            status: "pass"
          },
          {
            description: "Authenticated global navigation",
            matched_candidate_key: "global-nav",
            matched_candidate_rank: 0,
            matched_selector: "nav.global-nav",
            selector_key: "global_nav",
            status: "pass"
          }
        ]),
        createOperationResult("profile", [
          {
            description: "Profile header",
            error: "No selector candidate matched profile_header.",
            matched_candidate_key: null,
            matched_candidate_rank: null,
            matched_selector: null,
            selector_key: "profile_header",
            status: "fail"
          }
        ])
      ],
      "/tmp/previous.json"
    );

    const currentReport = createReport([
      createOperationResult("feed", [
        {
          description: "Feed content surface",
          error: "No selector candidate matched feed_surface.",
          matched_candidate_key: null,
          matched_candidate_rank: null,
          matched_selector: null,
          selector_key: "feed_surface",
          status: "fail"
        },
        {
          description: "Authenticated global navigation",
          matched_candidate_key: "global-nav-link",
          matched_candidate_rank: 2,
          matched_selector: "a[href='/feed/']",
          selector_key: "global_nav",
          status: "pass"
        }
      ]),
      createOperationResult("profile", [
        {
          description: "Profile header",
          matched_candidate_key: "profile-h1",
          matched_candidate_rank: 0,
          matched_selector: "main h1",
          selector_key: "profile_header",
          status: "pass"
        }
      ])
    ], "/tmp/current.json");

    const diff = computeReadOnlyValidationDiff(currentReport, previousReport);

    expect(diff.previous_report_path).toBe("/tmp/previous.json");
    expect(diff.regressions).toEqual([
      expect.objectContaining({
        change: "new_failure",
        operation: "feed",
        selector_key: "feed_surface"
      }),
      expect.objectContaining({
        change: "fallback_drift",
        operation: "feed",
        selector_key: "global_nav"
      })
    ]);
    expect(diff.recoveries).toEqual([
      expect.objectContaining({
        change: "recovered",
        operation: "profile",
        selector_key: "profile_header"
      })
    ]);
  });
});
