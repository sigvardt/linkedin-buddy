import type {
  LinkedInAssistantErrorPayload,
  ReadOnlyValidationReport
} from "@linkedin-assistant/core";
import { describe, expect, it } from "vitest";
import {
  formatReadOnlyValidationError,
  formatReadOnlyValidationReport,
  resolveReadOnlyValidationOutputMode
} from "../src/liveValidationOutput.js";

function createReportFixture(): ReadOnlyValidationReport {
  return {
    blocked_request_count: 6,
    blocked_requests: [
      {
        blocked_at: "2026-03-09T10:00:01.000Z",
        method: "POST",
        reason: "non_get",
        resource_type: "xhr",
        url: "https://www.linkedin.com/voyager/api/graphql"
      },
      {
        blocked_at: "2026-03-09T10:00:02.000Z",
        method: "GET",
        reason: "non_linkedin_domain",
        resource_type: "script",
        url: "https://example.com/tracker.js"
      },
      {
        blocked_at: "2026-03-09T10:00:03.000Z",
        method: "POST",
        reason: "non_get",
        resource_type: "xhr",
        url: "https://www.linkedin.com/voyager/api/identity"
      },
      {
        blocked_at: "2026-03-09T10:00:04.000Z",
        method: "GET",
        reason: "non_linkedin_domain",
        resource_type: "image",
        url: "https://analytics.example.net/pixel"
      },
      {
        blocked_at: "2026-03-09T10:00:05.000Z",
        method: "POST",
        reason: "non_get",
        resource_type: "fetch",
        url: "https://www.linkedin.com/voyager/api/feed"
      },
      {
        blocked_at: "2026-03-09T10:00:06.000Z",
        method: "GET",
        reason: "non_linkedin_domain",
        resource_type: "font",
        url: "https://cdn.example.org/font.woff2"
      }
    ],
    checked_at: "2026-03-09T10:00:00.000Z",
    diff: {
      previous_report_path: "/tmp/live-readonly/previous-report.json",
      recoveries: [
        {
          change: "recovered",
          current_candidate_key: "profile-h1",
          current_status: "pass",
          operation: "profile",
          previous_candidate_key: null,
          previous_status: "fail",
          selector_key: "profile_header"
        }
      ],
      regressions: [
        {
          change: "fallback_drift",
          current_candidate_key: "header-nav",
          current_status: "pass",
          operation: "feed",
          previous_candidate_key: "global-nav",
          previous_status: "pass",
          selector_key: "global_nav"
        },
        {
          change: "new_failure",
          current_candidate_key: null,
          current_status: "fail",
          operation: "notifications",
          previous_candidate_key: "notification-list",
          previous_status: "pass",
          selector_key: "notification_surface"
        }
      ],
      unchanged_count: 3
    },
    events_path: "/tmp/live-readonly/events.jsonl",
    fail_count: 1,
    latest_report_path: "/tmp/live-readonly/latest-report.json",
    operation_count: 2,
    operations: [
      {
        completed_at: "2026-03-09T10:00:05.000Z",
        failed_count: 0,
        final_url: "https://www.linkedin.com/feed/",
        matched_count: 2,
        operation: "feed",
        page_load_ms: 1200,
        selector_results: [
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
            matched_candidate_key: "header-nav",
            matched_candidate_rank: 1,
            matched_selector: "header nav",
            selector_key: "global_nav",
            status: "pass"
          }
        ],
        started_at: "2026-03-09T10:00:00.000Z",
        status: "pass",
        summary: "Load the LinkedIn feed and verify the main feed surface.",
        url: "https://www.linkedin.com/feed/",
        warnings: []
      },
      {
        completed_at: "2026-03-09T10:00:12.000Z",
        failed_count: 1,
        final_url: "https://www.linkedin.com/notifications/",
        matched_count: 1,
        operation: "notifications",
        page_load_ms: 1600,
        selector_results: [
          {
            description: "Notifications list or container",
            error: "No selector candidate matched notification_surface.",
            matched_candidate_key: null,
            matched_candidate_rank: null,
            matched_selector: null,
            selector_key: "notification_surface",
            status: "fail"
          },
          {
            description: "Notification entry link",
            matched_candidate_key: "notification-anchor",
            matched_candidate_rank: 0,
            matched_selector: "a[href*='/notifications/']",
            selector_key: "notification_link",
            status: "pass"
          }
        ],
        started_at: "2026-03-09T10:00:06.000Z",
        status: "fail",
        summary: "Open notifications and verify the notifications surface.",
        url: "https://www.linkedin.com/notifications/",
        warnings: ["Notifications loaded with a slower-than-usual response."]
      }
    ],
    outcome: "fail",
    pass_count: 1,
    previous_report_path: "/tmp/live-readonly/previous-report.json",
    recommended_actions: [
      "Open /tmp/live-readonly/report.json to review selector matches.",
      "Compare with the previous report to confirm whether the regression is real."
    ],
    report_path: "/tmp/live-readonly/report.json",
    request_limits: {
      max_requests: 20,
      max_requests_reached: false,
      min_interval_ms: 5000,
      used_requests: 2
    },
    run_id: "run_live_validation_output_test",
    session: {
      captured_at: "2026-03-09T09:00:00.000Z",
      file_path: "/tmp/session.enc.json",
      li_at_expires_at: "2026-04-01T00:00:00.000Z",
      session_name: "smoke"
    },
    summary:
      "Checked 2 read-only LinkedIn operations. 1 passed. 1 failed. 2 selector regressions detected versus the previous run."
  };
}

describe("live validation output helpers", () => {
  it("defaults to human output in interactive terminals unless JSON is forced", () => {
    expect(resolveReadOnlyValidationOutputMode({ json: false }, true)).toBe("human");
    expect(resolveReadOnlyValidationOutputMode({ json: false }, false)).toBe("json");
    expect(resolveReadOnlyValidationOutputMode({ json: true }, true)).toBe("json");
  });

  it("renders a scannable human-readable report", () => {
    const output = formatReadOnlyValidationReport(createReportFixture());

    expect(output).toContain("Live Validation: FAIL");
    expect(output).toContain(
      "Summary: Checked 2 read-only LinkedIn operations. 1 passed. 1 failed. 2 selector regressions detected versus the previous run."
    );
    expect(output).toContain("Operations");
    expect(output).toContain("- PASS feed: 2 matched, 0 failed, 1200ms");
    expect(output).toContain("- FAIL notifications: 1 matched, 1 failed, 1600ms | 1 warning");
    expect(output).toContain("Failures");
    expect(output).toContain(
      "- notifications/notification_surface — No selector candidate matched notification_surface."
    );
    expect(output).toContain("Regressions");
    expect(output).toContain(
      "- Selector drift: feed/global_nav (global-nav → header-nav)"
    );
    expect(output).toContain(
      "- New failure: notifications/notification_surface (notification-list → none)"
    );
    expect(output).toContain("Recoveries");
    expect(output).toContain("- Recovered: profile/profile_header (none → profile-h1)");
    expect(output).toContain("Blocked Requests");
    expect(output).toContain("- 6 requests blocked by the read-only guard");
    expect(output).toContain("https://www.linkedin.com/voyager/api/graphql");
    expect(output).not.toContain("https://cdn.example.org/font.woff2");
    expect(output).toContain("Next Steps");
  });

  it("formats friendly human-readable errors", () => {
    const error: LinkedInAssistantErrorPayload = {
      code: "ACTION_PRECONDITION_FAILED",
      message: "Live validation is currently restricted to read-only mode.",
      details: {
        option: "read-only"
      }
    };

    const output = formatReadOnlyValidationError(error);

    expect(output).toContain(
      "Live validation failed [ACTION_PRECONDITION_FAILED]"
    );
    expect(output).toContain(
      "Live validation is currently restricted to read-only mode."
    );
    expect(output).toContain('Details: {"option":"read-only"}');
  });
});
