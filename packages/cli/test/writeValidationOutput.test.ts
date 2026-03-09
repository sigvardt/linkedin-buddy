import type {
  LinkedInAssistantErrorPayload,
  WriteValidationReport
} from "@linkedin-assistant/core";
import { describe, expect, it } from "vitest";
import {
  WriteValidationProgressReporter,
  formatWriteValidationError,
  formatWriteValidationReport,
  resolveWriteValidationOutputMode
} from "../src/writeValidationOutput.js";

function createReportFixture(
  outcome: WriteValidationReport["outcome"] = "pass"
): WriteValidationReport {
  const status = outcome === "cancelled" ? "cancelled" : outcome;
  const passCount = status === "pass" ? 1 : 0;
  const failCount = status === "fail" ? 1 : 0;
  const cancelledCount = status === "cancelled" ? 1 : 0;

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
        duration_ms: 5_000,
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
    cancelled_count: cancelledCount,
    checked_at: "2026-03-09T10:00:06.000Z",
    cooldown_ms: 10_000,
    duration_ms: 6_000,
    fail_count: failCount,
    html_report_path: "/tmp/report.html",
    latest_report_path: "/tmp/latest-report.json",
    outcome,
    pass_count: passCount,
    recommended_actions: [
      "Open /tmp/report.html in a browser for the color-coded validation report.",
      "Review /tmp/report.json"
    ],
    report_path: "/tmp/report.json",
    run_id: "run_write_validation_test",
    started_at: "2026-03-09T10:00:00.000Z",
    summary:
      `Checked 1 write-validation actions. ${passCount} passed. ${failCount} failed. ${cancelledCount} cancelled. Overall outcome: ${outcome}.`,
    warning: "This will perform REAL actions on LinkedIn."
  };
}

describe("write validation output", () => {
  it("formats a human-readable report with action details", () => {
    const output = formatWriteValidationReport(createReportFixture("fail"));

    expect(output).toContain("Write Validation FAIL");
    expect(output).toContain("Overview");
    expect(output).toContain("Reports");
    expect(output).toContain("Actions");
    expect(output).toContain("send_message");
    expect(output).toContain("error: The approved thread could not be verified.");
    expect(output).toContain("Report HTML: /tmp/report.html");
    expect(output).toContain("Recommendations");
  });

  it("matches the full human-readable write-validation report snapshot", () => {
    expect(formatWriteValidationReport(createReportFixture("fail"))).toMatchInlineSnapshot(`
      "Write Validation FAIL
      Account: Secondary [secondary / secondary]
      Summary: Checked 1 write-validation actions. 0 passed. 1 failed. 0 cancelled. Overall outcome: fail.
      Run: run_write_validation_test | Started 2026-03-09T10:00:00.000Z | Finished 2026-03-09T10:00:06.000Z | Duration 6.0s
      Warning: This will perform REAL actions on LinkedIn.
      
      Overview
      - Actions: 0 passed actions | 1 failed action | 0 cancelled actions
      - Timing: 6.0s total | cooldown 10s
      - Side effects: 0 actions need cleanup | 1 artifact | 0 warnings
      - Snapshot: latest /tmp/latest-report.json
      
      Reports
      - Report JSON: /tmp/report.json
      - Report HTML: /tmp/report.html
      - Audit log: /tmp/events.jsonl
      - Latest snapshot: /tmp/latest-report.json
      
      Actions
      - 1/1 FAIL send_message | private | unverified | state=n/a | 5.0s | 1 artifact | ACTION_PRECONDITION_FAILED
        summary: Send a message in the approved thread and verify the outbound message appears.
        expected: The outbound message is echoed in the approved conversation thread.
        target: {"thread_id":"abc123"}
        outbound: {"text":"Quick validation ping • 2026-03-09T10:00:00.000Z"}
        started: 2026-03-09T10:00:00.000Z
        completed: 2026-03-09T10:00:05.000Z
        error: The approved thread could not be verified.
        artifacts: live-write-validation/send-message-before.png
        before: live-write-validation/send-message-before.png
      
      Recommendations
      - Open /tmp/report.html in a browser for the color-coded validation report.
      - Review /tmp/report.json"
    `);
  });

  it("renders failure stages and warnings when present", () => {
    const report = createReportFixture("fail");
    report.actions[0] = {
      ...report.actions[0],
      failure_stage: "verify",
      warnings: [
        "Recovered after 1 transient retry while verifying the LinkedIn outcome."
      ]
    };

    const output = formatWriteValidationReport(report);

    expect(output).toContain("stage: verify");
    expect(output).toContain(
      "warning: Recovered after 1 transient retry while verifying the LinkedIn outcome."
    );
  });

  it("formats validation errors with details, suggestions, and help guidance", () => {
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
    expect(output).toContain("Suggested fix:");
    expect(output).toContain("account: secondary");
    expect(output).toContain("docs/write-validation.md");
    expect(output).toContain("linkedin test live --help");
  });

  it("matches the human-readable error snapshot", () => {
    const error: LinkedInAssistantErrorPayload = {
      code: "ACTION_PRECONDITION_FAILED",
      details: {
        account: "secondary",
        prompt: "yes",
        reason: "operator-declined"
      },
      message: 'Write validation requires typing "yes" for every action.'
    };

    expect(
      formatWriteValidationError(error, {
        helpCommand: "linkedin test live --help"
      })
    ).toMatchInlineSnapshot(`
      "Write validation failed [ACTION_PRECONDITION_FAILED]
      Write validation requires typing "yes" for every action.
      Suggested fix: Keep per-action confirmations enabled. The harness intentionally requires typing yes for each real action.
      
      Details
      - account: secondary
      - prompt: yes
      - reason: operator-declined
      
      Help
      - Re-run linkedin test live --help for usage, safety guidance, and examples.
      - Review docs/write-validation.md for account setup, approved-target examples, and report details.
      - Rerun with --json if you need the structured error payload for automation or debugging."
    `);
  });

  it("renders stable progress updates for long-running write scenarios", () => {
    const lines: string[] = [];
    const reporter = new WriteValidationProgressReporter({
      writeLine(line) {
        lines.push(line);
      }
    });

    reporter.handleLog({
      event: "write_validation.start",
      payload: {
        account_id: "secondary",
        cooldown_ms: 10_000,
        timeout_ms: 30_000
      }
    });
    reporter.handleLog({
      event: "write_validation.action.start",
      payload: {
        action_type: "send_message"
      }
    });
    reporter.handleLog({
      event: "write_validation.action.attempt",
      payload: {
        action_type: "send_message",
        attempt: 1,
        stage: "prepare"
      }
    });
    reporter.handleLog({
      event: "write_validation.action.prepared",
      payload: {
        action_type: "send_message",
        retry_count: 0
      }
    });
    reporter.handleLog({
      event: "write_validation.action.completed",
      payload: {
        action_type: "send_message",
        status: "pass",
        verified: true,
        warnings: []
      }
    });
    reporter.handleLog({
      event: "write_validation.completed",
      payload: {
        cancelled_count: 0,
        fail_count: 0,
        pass_count: 1,
        report_path: "/tmp/report.json"
      }
    });

    expect(lines).toEqual([
      "Starting write validation for account secondary (5 actions, cooldown 10s, timeout 30s).",
      "Running 3/5: send_message — Send a message in the approved thread and verify the outbound message appears.",
      "3/5 send_message — preparing the approved action...",
      "Ready 3/5: send_message — preview shown; waiting for yes.",
      "Finished 3/5: send_message — PASS | verified",
      "Write validation finished — 1 passed, 0 failed, 0 cancelled. Report: /tmp/report.json"
    ]);
  });

  it("resolves json mode for explicit json and non-tty stdout", () => {
    expect(resolveWriteValidationOutputMode({ json: true }, true)).toBe("json");
    expect(resolveWriteValidationOutputMode({}, false)).toBe("json");
    expect(resolveWriteValidationOutputMode({}, true)).toBe("human");
  });
});
