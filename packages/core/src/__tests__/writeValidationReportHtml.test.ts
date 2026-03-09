import { describe, expect, it } from "vitest";
import type { WriteValidationReport } from "../writeValidationShared.js";
import { renderWriteValidationReportHtml } from "../writeValidationReportHtml.js";

function createReportFixture(): WriteValidationReport {
  return {
    account: {
      designation: "secondary",
      id: "secondary",
      label: "Secondary Account",
      profile_name: "secondary-profile",
      session_name: "secondary-session"
    },
    action_count: 1,
    actions: [
      {
        action_type: "send_message",
        after_screenshot_paths: ["live-write-validation/send-message-after.png"],
        artifact_paths: ["live-write-validation/send-message-before.png"],
        before_screenshot_paths: ["live-write-validation/send-message-before.png"],
        cleanup_guidance: ["Delete the test message if you do not want it to remain visible."],
        completed_at: "2026-03-09T10:00:05.000Z",
        confirm_artifacts: [],
        duration_ms: 5_000,
        expected_outcome: "The outbound message is echoed in the approved conversation thread.",
        linkedin_response: {
          sent: true
        },
        prepared_action_id: "prepared_123",
        preview: {
          action_type: "send_message",
          expected_outcome: "The outbound message is echoed in the approved conversation thread.",
          outbound: {
            text: "Quick validation ping • 2026-03-09T10:00:00.000Z"
          },
          risk_class: "private",
          summary: "Send a message in the approved thread and verify the outbound message appears.",
          target: {
            thread_id: "abc123"
          }
        },
        risk_class: "private",
        started_at: "2026-03-09T10:00:00.000Z",
        state_synced: null,
        status: "pass",
        summary: "Send a message in the approved thread and verify the outbound message appears.",
        verification: {
          details: {
            thread_id: "abc123"
          },
          message: "Sent message was re-observed in the approved conversation thread.",
          source: "inbox.getThread",
          verified: true
        },
        warnings: []
      }
    ],
    audit_log_path: "/tmp/run/events.jsonl",
    cancelled_count: 0,
    checked_at: "2026-03-09T10:00:06.000Z",
    cooldown_ms: 10_000,
    duration_ms: 6_000,
    fail_count: 0,
    html_report_path: "/tmp/run/live-write-validation/report.html",
    latest_report_path: "/tmp/live-write-validation/secondary/latest-report.json",
    outcome: "pass",
    pass_count: 1,
    recommended_actions: [
      "Open /tmp/run/live-write-validation/report.html in a browser for the color-coded validation report."
    ],
    report_path: "/tmp/run/live-write-validation/report.json",
    run_id: "run_write_validation_html_test",
    started_at: "2026-03-09T10:00:00.000Z",
    summary: "Checked 1 write-validation actions. 1 passed. 0 failed. 0 cancelled. Overall outcome: pass.",
    warning: "This will perform REAL actions on LinkedIn."
  };
}

describe("writeValidationReportHtml", () => {
  it("renders a filterable standalone HTML report", () => {
    const html = renderWriteValidationReportHtml(createReportFixture());

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('data-filter-group="status"');
    expect(html).toContain('data-filter-group="risk"');
    expect(html).toContain("Secondary Account");
    expect(html).toContain("send_message");
    expect(html).toContain("color-coded validation report");
    expect(html).toContain("file:///tmp/run/live-write-validation/report.json");
  });
});
