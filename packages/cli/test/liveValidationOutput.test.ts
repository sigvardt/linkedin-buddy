import type {
  LinkedInAssistantErrorPayload,
  ReadOnlyValidationReport
} from "@linkedin-assistant/core";
import { describe, expect, it } from "vitest";
import {
  formatReadOnlyValidationError,
  formatReadOnlyValidationReport,
  ReadOnlyValidationProgressReporter,
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
    fail_count: 2,
    latest_report_path: "/tmp/live-readonly/latest-report.json",
    operation_count: 3,
    operations: [
      {
        attempt_count: 1,
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
        attempt_count: 2,
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
        warnings: [
          "Recovered after 1 transient retry.",
          "Notifications loaded with a slower-than-usual response."
        ]
      },
      {
        attempt_count: 3,
        completed_at: "2026-03-09T10:00:20.000Z",
        error_code: "TIMEOUT",
        error_message:
          "Timed out after 30000ms while running connections. LinkedIn may be slow or the page may be incomplete; rerun the live validation or increase the timeout.",
        failed_count: 2,
        final_url:
          "https://www.linkedin.com/mynetwork/invite-connect/connections/",
        matched_count: 0,
        operation: "connections",
        page_load_ms: 900,
        selector_results: [
          {
            description: "Connections list or container",
            error:
              "Timed out after 30000ms while running connections. LinkedIn may be slow or the page may be incomplete; rerun the live validation or increase the timeout.",
            matched_candidate_key: null,
            matched_candidate_rank: null,
            matched_selector: null,
            selector_key: "connections_surface",
            status: "fail"
          },
          {
            description: "Connection profile entry",
            error:
              "Timed out after 30000ms while running connections. LinkedIn may be slow or the page may be incomplete; rerun the live validation or increase the timeout.",
            matched_candidate_key: null,
            matched_candidate_rank: null,
            matched_selector: null,
            selector_key: "connection_entry",
            status: "fail"
          }
        ],
        started_at: "2026-03-09T10:00:13.000Z",
        status: "fail",
        summary: "Open connections and verify the connections list surface.",
        url: "https://www.linkedin.com/mynetwork/invite-connect/connections/",
        warnings: ["Retried 2 times before the page still failed."]
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
      used_requests: 5
    },
    run_id: "run_live_validation_output_test",
    session: {
      captured_at: "2026-03-09T09:00:00.000Z",
      file_path: "/tmp/session.enc.json",
      li_at_expires_at: "2026-04-01T00:00:00.000Z",
      session_name: "smoke"
    },
    summary:
      "Checked 3 read-only LinkedIn operations. 1 passed. 2 failed. 2 selector regressions detected versus the previous run."
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

    expect(output).toContain("Live Validation: MIXED");
    expect(output).toContain(
      "Summary: Checked 3 read-only LinkedIn operations. 1 passed. 2 failed. 2 selector regressions detected versus the previous run."
    );
    expect(output).toContain("Overview");
    expect(output).toContain(
      "- Mixed result: at least one validation step passed and at least one failed in the same run."
    );
    expect(output).toContain(
      "- Operations: 1 passed operation | 2 failed operations | 3 warnings"
    );
    expect(output).toContain("- Coverage: 3/5 steps ran before the validation stopped early.");
    expect(output).toContain("Operations");
    expect(output).toContain("- PASS feed: 2 matched, 0 failed, 1.2s");
    expect(output).toContain(
      "- FAIL notifications: 1 matched, 1 failed, 1.6s | 2 warnings | 2 attempts"
    );
    expect(output).toContain(
      "- FAIL connections: 0 matched, 2 failed, 900ms | 1 warning | 3 attempts | TIMEOUT"
    );
    expect(output).toContain("Warnings");
    expect(output).toContain("- notifications — Recovered after 1 transient retry.");
    expect(output).toContain("Operation Errors");
    expect(output).toContain("- connections [TIMEOUT] — Timed out after 30000ms while running connections.");
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
    expect(output).toContain("- 1 more blocked request recorded in the report JSON.");
    expect(output).toContain("Next Steps");
  });

  it("matches the full human-readable report snapshot", () => {
    expect(formatReadOnlyValidationReport(createReportFixture())).toMatchInlineSnapshot(`
      "Live Validation: MIXED
      Summary: Checked 3 read-only LinkedIn operations. 1 passed. 2 failed. 2 selector regressions detected versus the previous run.
      Session: smoke (captured 2026-03-09T09:00:00.000Z)
      Report JSON: /tmp/live-readonly/report.json
      Events: /tmp/live-readonly/events.jsonl

      Overview
      - Mixed result: at least one validation step passed and at least one failed in the same run.
      - Operations: 1 passed operation | 2 failed operations | 3 warnings
      - Requests: 5/20 used | 6 blocked requests
      - Selector diff: 2 regressions | 1 recovery | 3 unchanged selectors
      - Coverage: 3/5 steps ran before the validation stopped early.

      Operations
      - PASS feed: 2 matched, 0 failed, 1.2s
      - FAIL notifications: 1 matched, 1 failed, 1.6s | 2 warnings | 2 attempts
      - FAIL connections: 0 matched, 2 failed, 900ms | 1 warning | 3 attempts | TIMEOUT

      Warnings
      - notifications — Recovered after 1 transient retry.
      - notifications — Notifications loaded with a slower-than-usual response.
      - connections — Retried 2 times before the page still failed.

      Operation Errors
      - connections [TIMEOUT] — Timed out after 30000ms while running connections. LinkedIn may be slow or the page may be incomplete; rerun the live validation or increase the timeout.

      Failures
      - notifications/notification_surface — No selector candidate matched notification_surface.

      Regressions
      - Selector drift: feed/global_nav (global-nav → header-nav)
      - New failure: notifications/notification_surface (notification-list → none)

      Recoveries
      - Recovered: profile/profile_header (none → profile-h1)

      Blocked Requests
      - 6 requests blocked by the read-only guard
      - POST https://www.linkedin.com/voyager/api/graphql [non_get]
      - GET https://example.com/tracker.js [non_linkedin_domain]
      - POST https://www.linkedin.com/voyager/api/identity [non_get]
      - GET https://analytics.example.net/pixel [non_linkedin_domain]
      - POST https://www.linkedin.com/voyager/api/feed [non_get]
      - 1 more blocked request recorded in the report JSON.

      Next Steps
      - Open /tmp/live-readonly/report.json to review selector matches.
      - Compare with the previous report to confirm whether the regression is real.
      "
    `);
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
    expect(output).toContain(
      "Suggested fix: Review the command flags, fix the precondition, and rerun the validation."
    );
    expect(output).toContain("Details: option=read-only");
    expect(output).toContain("Tip: run linkedin test live --help");
  });

  it("matches the human-readable error snapshot", () => {
    const error: LinkedInAssistantErrorPayload = {
      code: "ACTION_PRECONDITION_FAILED",
      message: "Live validation is currently restricted to read-only mode.",
      details: {
        option: "read-only"
      }
    };

    expect(formatReadOnlyValidationError(error)).toMatchInlineSnapshot(
      `"Live validation failed [ACTION_PRECONDITION_FAILED]\nLive validation is currently restricted to read-only mode.\nSuggested fix: Review the command flags, fix the precondition, and rerun the validation.\nDetails: option=read-only\nTip: run linkedin test live --help for usage and exit codes, or rerun with --json for the structured error payload."`
    );
  });

  it("emits progress lines from stable live-validation log events", () => {
    const lines: string[] = [];
    const reporter = new ReadOnlyValidationProgressReporter({
      writeLine(line) {
        lines.push(line);
      }
    });

    reporter.handleLog({
      event: "live_validation.start",
      payload: {
        max_requests: 20,
        min_interval_ms: 5000,
        session_name: "smoke"
      }
    });
    reporter.handleLog({
      event: "live_validation.operation.start",
      payload: {
        operation: "feed"
      }
    });
    reporter.handleLog({
      event: "live_validation.operation.done",
      payload: {
        attempt_count: 1,
        failed_count: 0,
        matched_count: 2,
        operation: "feed",
        page_load_ms: 1200,
        status: "pass",
        warnings: []
      }
    });
    reporter.handleLog({
      event: "live_validation.operation.start",
      payload: {
        operation: "connections"
      }
    });
    reporter.handleLog({
      event: "live_validation.operation.failed",
      payload: {
        attempt_count: 3,
        code: "TIMEOUT",
        operation: "connections",
        page_load_ms: 900,
        warnings: ["Retried 2 times before the page still failed."]
      }
    });
    reporter.handleLog({
      event: "live_validation.done",
      payload: {
        fail_count: 1,
        pass_count: 1,
        report_path: "/tmp/live-readonly/report.json"
      }
    });

    expect(lines).toEqual([
      "Starting live validation for session smoke (5 steps, request cap 20, min interval 5.0s).",
      "Checking 1/5: feed...",
      "Finished 1/5: feed — PASS | 2 matched | 0 failed | 1.2s",
      "Checking 2/5: connections...",
      "Finished 2/5: connections — FAIL | TIMEOUT | 3 attempts | 900ms | 1 warning",
      "Live validation finished — 1 passed, 1 failed. Report: /tmp/live-readonly/report.json"
    ]);
  });
});
