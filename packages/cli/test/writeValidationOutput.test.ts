import type {
  LinkedInAssistantErrorPayload,
  WriteValidationReport
} from "@linkedin-assistant/core";
import { describe, expect, it } from "vitest";
import {
  formatWriteValidationError,
  formatWriteValidationReport,
  resolveWriteValidationOutputMode
} from "../src/writeValidationOutput.js";

function createReportFixture(
  outcome: WriteValidationReport["outcome"] = "pass"
): WriteValidationReport {
  const status = outcome === "cancelled" ? "cancelled" : outcome;

  return {
    account: {
      designation: "secondary",
      id: "secondary",
      label: "Secondary",
      profile_name: "secondary-profile",
      session_name: "secondary-session"
    },
    action_count: 1,
    actions: [
      {
        action_type: "send_message",
        after_screenshot_paths:
          status === "pass" ? ["live-write-validation/send-message-after.png"] : [],
        artifact_paths: ["live-write-validation/send-message-before.png"],
        before_screenshot_paths: ["live-write-validation/send-message-before.png"],
        cleanup_guidance: [],
        completed_at: "2026-03-09T10:00:05.000Z",
        confirm_artifacts: [],
        ...(status === "fail"
          ? {
              error_code: "ACTION_PRECONDITION_FAILED",
              error_message: "The approved thread could not be verified."
            }
          : {}),
        expected_outcome:
          "The outbound message is echoed in the approved conversation thread.",
        linkedin_response: status === "pass" ? { sent: true } : undefined,
        prepared_action_id: "prepared_123",
        preview: {
          action_type: "send_message",
          expected_outcome:
            "The outbound message is echoed in the approved conversation thread.",
          outbound: {
            text: "Quick validation ping • 2026-03-09T10:00:00.000Z"
          },
          risk_class: "private",
          summary:
            "Send a message in the approved thread and verify the outbound message appears.",
          target: {
            thread_id: "abc123"
          }
        },
        risk_class: "private",
        started_at: "2026-03-09T10:00:00.000Z",
        state_synced: null,
        status,
        summary:
          "Send a message in the approved thread and verify the outbound message appears.",
        verification:
          status === "pass"
            ? {
                details: {
                  thread_id: "abc123"
                },
                message:
                  "Sent message was re-observed in the approved conversation thread.",
                source: "inbox.getThread",
                verified: true
              }
            : undefined
      }
    ],
    audit_log_path: "/tmp/events.jsonl",
    cancelled_count: status === "cancelled" ? 1 : 0,
    checked_at: "2026-03-09T10:00:06.000Z",
    cooldown_ms: 10_000,
    fail_count: status === "fail" ? 1 : 0,
    latest_report_path: "/tmp/latest-report.json",
    outcome,
    pass_count: status === "pass" ? 1 : 0,
    recommended_actions: ["Review /tmp/report.json"],
    report_path: "/tmp/report.json",
    run_id: "run_write_validation_test",
    summary:
      "Checked 1 write-validation actions. 1 passed. 0 failed. 0 cancelled. Overall outcome: pass.",
    warning: "This will perform REAL actions on LinkedIn."
  };
}

describe("write validation output", () => {
  it("formats a human-readable report with action details", () => {
    const output = formatWriteValidationReport(createReportFixture("fail"));

    expect(output).toContain("Write Validation FAIL");
    expect(output).toContain("Actions");
    expect(output).toContain("send_message");
    expect(output).toContain("error: The approved thread could not be verified.");
    expect(output).toContain("Recommendations");
  });

  it("formats validation errors with details and help guidance", () => {
    const error: LinkedInAssistantErrorPayload = {
      code: "ACTION_PRECONDITION_FAILED",
      details: {
        account: "secondary"
      },
      message: "Write validation requires typing \"yes\" for every action."
    };

    const output = formatWriteValidationError(error, {
      helpCommand: "linkedin test live --help"
    });

    expect(output).toContain(
      "Write validation failed [ACTION_PRECONDITION_FAILED]"
    );
    expect(output).toContain("account: secondary");
    expect(output).toContain("linkedin test live --help");
  });

  it("resolves json mode for explicit json and non-tty stdout", () => {
    expect(resolveWriteValidationOutputMode({ json: true }, true)).toBe("json");
    expect(resolveWriteValidationOutputMode({}, false)).toBe("json");
    expect(resolveWriteValidationOutputMode({}, true)).toBe("human");
  });
});
