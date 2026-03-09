import { stdin, stdout } from "node:process";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedInAssistantError } from "@linkedin-assistant/core";

const writeValidationCliMocks = vi.hoisted(() => ({
  answers: [] as string[],
  runLinkedInWriteValidation: vi.fn(),
  upsertWriteValidationAccount: vi.fn()
}));

vi.mock("node:readline/promises", async () => {
  const actual = await vi.importActual<typeof import("node:readline/promises")>(
    "node:readline/promises"
  );

  return {
    ...actual,
    createInterface: vi.fn((options?: { output?: { write?: (chunk: string) => void } }) => ({
      close: vi.fn(),
      question: vi.fn(async (prompt: string) => {
        options?.output?.write?.(prompt);
        return writeValidationCliMocks.answers.shift() ?? "yes";
      })
    }))
  };
});

vi.mock("@linkedin-assistant/core", async () => {
  const actual = await import("../../core/src/index.js");

  return {
    ...actual,
    runLinkedInWriteValidation: writeValidationCliMocks.runLinkedInWriteValidation,
    upsertWriteValidationAccount: writeValidationCliMocks.upsertWriteValidationAccount
  };
});

import { runCli } from "../src/bin/linkedin.js";

function setInteractiveMode(inputIsTty: boolean, outputIsTty: boolean): void {
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: inputIsTty
  });
  Object.defineProperty(stdout, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
}

function createWriteValidationReport(
  outcome: "pass" | "fail" | "cancelled" = "pass"
): Record<string, unknown> {
  return {
    account: {
      designation: "secondary",
      id: "secondary",
      label: "Secondary",
      profile_name: "secondary",
      session_name: "secondary-session"
    },
    action_count: 1,
    actions: [
      {
        action_type: "send_message",
        after_screenshot_paths: ["live-write-validation/send-message-after.png"],
        artifact_paths: ["live-write-validation/send-message-after.png"],
        before_screenshot_paths: ["live-write-validation/send-message-before.png"],
        cleanup_guidance: [],
        completed_at: "2026-03-09T10:00:05.000Z",
        confirm_artifacts: ["live-write-validation/send-message-after.png"],
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
        status: outcome,
        summary: "Send a message in the approved thread and verify the outbound message appears.",
        verification: {
          details: {
            thread_id: "abc123"
          },
          message: "Sent message was re-observed in the approved conversation thread.",
          source: "inbox.getThread",
          verified: outcome === "pass"
        }
      }
    ],
    audit_log_path: "/tmp/events.jsonl",
    cancelled_count: outcome === "cancelled" ? 1 : 0,
    checked_at: "2026-03-09T10:00:06.000Z",
    cooldown_ms: 10_000,
    fail_count: outcome === "fail" ? 1 : 0,
    latest_report_path: "/tmp/latest-report.json",
    outcome,
    pass_count: outcome === "pass" ? 1 : 0,
    recommended_actions: ["Review /tmp/report.json"],
    report_path: "/tmp/report.json",
    run_id: "run_write_validation_test",
    summary: "Checked 1 write-validation actions. 1 passed. 0 failed. 0 cancelled. Overall outcome: pass.",
    warning: "This will perform REAL actions on LinkedIn."
  };
}

describe("write validation CLI", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setInteractiveMode(true, true);
    process.exitCode = undefined;
    writeValidationCliMocks.answers = [];
    vi.clearAllMocks();
    stderrChunks = [];
    stdoutChunks = [];
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        const [chunk] = args;
        stderrChunks.push(String(chunk));
        return true;
      });
    stdoutWriteSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((...args: Parameters<typeof process.stdout.write>) => {
        const [chunk] = args;
        stdoutChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("registers a write-validation account via the accounts:add alias", async () => {
    writeValidationCliMocks.upsertWriteValidationAccount.mockResolvedValue({
      accounts: {
        secondary: {
          designation: "secondary",
          id: "secondary",
          label: "Secondary",
          profileName: "secondary-profile",
          sessionName: "secondary-session",
          targets: {}
        }
      },
      configPath: "/tmp/config.json"
    });

    await runCli([
      "node",
      "linkedin",
      "accounts:add",
      "secondary",
      "--designation",
      "secondary",
      "--profile",
      "secondary-profile",
      "--session",
      "secondary-session"
    ]);

    expect(writeValidationCliMocks.upsertWriteValidationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "secondary",
        designation: "secondary",
        profileName: "secondary-profile",
        sessionName: "secondary-session"
      })
    );
    expect(JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? ""))).toMatchObject({
      saved: true,
      config_path: "/tmp/config.json"
    });
  });

  it("passes approved target flags through the visible accounts add command", async () => {
    writeValidationCliMocks.upsertWriteValidationAccount.mockResolvedValue({
      accounts: {
        secondary: {
          designation: "secondary",
          id: "secondary",
          label: "Secondary",
          profileName: "secondary-profile",
          sessionName: "secondary-session",
          targets: {}
        }
      },
      configPath: "/tmp/config.json"
    });

    await runCli([
      "node",
      "linkedin",
      "accounts",
      "add",
      "secondary",
      "--designation",
      "secondary",
      "--message-thread",
      "/messaging/thread/abc123/",
      "--message-participant-pattern",
      "Simon Miller",
      "--invite-profile",
      "realsimonmiller",
      "--invite-note",
      "Quick hello",
      "--followup-profile",
      "realsimonmiller",
      "--reaction-post",
      "/feed/update/urn:li:activity:123/",
      "--reaction",
      "celebrate",
      "--post-visibility",
      "connections"
    ]);

    expect(writeValidationCliMocks.upsertWriteValidationAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "secondary",
        designation: "secondary",
        targets: {
          "connections.send_invitation": {
            note: "Quick hello",
            targetProfile: "realsimonmiller"
          },
          "feed.like_post": {
            postUrl: "/feed/update/urn:li:activity:123/",
            reaction: "celebrate"
          },
          "network.followup_after_accept": {
            profileUrlKey: "realsimonmiller"
          },
          "post.create": {
            visibility: "connections"
          },
          send_message: {
            participantPattern: "Simon Miller",
            thread: "/messaging/thread/abc123/"
          }
        }
      })
    );
  });

  it("rejects --yes for write validation", async () => {
    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--write-validation",
      "--account",
      "secondary",
      "--yes"
    ]);

    const stderrOutput = stripVTControlCharacters(stderrChunks.join(""));

    expect(process.exitCode).toBe(2);
    expect(stderrOutput).toContain("Write validation failed [ACTION_PRECONDITION_FAILED]");
    expect(stderrOutput).toContain('Remove "--yes" and rerun');
  });

  it("requires an account id for write validation", async () => {
    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--write-validation"
    ]);

    const stderrOutput = stripVTControlCharacters(stderrChunks.join(""));

    expect(process.exitCode).toBe(2);
    expect(stderrOutput).toContain('Write validation requires "--account <id>".');
  });

  it("rejects combining --read-only with write validation", async () => {
    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--write-validation",
      "--read-only",
      "--account",
      "secondary"
    ]);

    const stderrOutput = stripVTControlCharacters(stderrChunks.join(""));

    expect(process.exitCode).toBe(2);
    expect(stderrOutput).toContain('Choose either "--read-only" or "--write-validation", not both.');
  });

  it("rejects session overrides for write validation", async () => {
    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--write-validation",
      "--account",
      "secondary",
      "--session",
      "custom-session"
    ]);

    const stderrOutput = stripVTControlCharacters(stderrChunks.join(""));

    expect(process.exitCode).toBe(2);
    expect(stderrOutput).toContain(
      'Write validation resolves stored sessions through the account registry. Remove "--session" and rerun.'
    );
  });

  it("rejects cdp-url overrides for write validation", async () => {
    await expect(
      runCli([
        "node",
        "linkedin",
        "--cdp-url",
        "http://127.0.0.1:18800",
        "test",
        "live",
        "--write-validation",
        "--account",
        "secondary",
        "--json"
      ])
    ).rejects.toThrow("do not support --cdp-url");

    expect(process.exitCode).toBe(2);
    expect(writeValidationCliMocks.runLinkedInWriteValidation).not.toHaveBeenCalled();
  });

  it("prompts per action and runs the write-validation harness", async () => {
    writeValidationCliMocks.answers = ["yes"];
    writeValidationCliMocks.runLinkedInWriteValidation.mockImplementation(
      async (input: {
        accountId: string;
        cooldownMs: number;
        onBeforeAction?: (preview: {
          action_type: string;
          expected_outcome: string;
          outbound: Record<string, unknown>;
          risk_class: string;
          summary: string;
          target: Record<string, unknown>;
        }) => Promise<boolean>;
        timeoutMs: number;
      }) => {
        const confirmed = await input.onBeforeAction?.({
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
        });

        expect(input.accountId).toBe("secondary");
        expect(input.cooldownMs).toBe(10_000);
        expect(input.timeoutMs).toBe(30_000);
        expect(confirmed).toBe(true);
        return createWriteValidationReport("pass");
      }
    );

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--write-validation",
      "--account",
      "secondary"
    ]);

    expect(writeValidationCliMocks.runLinkedInWriteValidation).toHaveBeenCalledTimes(1);
    expect(stderrChunks.join("")).toContain("This will perform REAL actions on LinkedIn.");
    expect(stdoutChunks.join("")).toContain("Action: send_message");
    expect(stdoutChunks.join("")).toContain("Execute this action?");
    expect(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Write Validation");
  });

  it("writes prompts to stderr and emits JSON when --json is selected", async () => {
    writeValidationCliMocks.answers = ["yes"];
    writeValidationCliMocks.runLinkedInWriteValidation.mockImplementation(
      async (input: {
        onBeforeAction?: (preview: {
          action_type: string;
          expected_outcome: string;
          outbound: Record<string, unknown>;
          risk_class: string;
          summary: string;
          target: Record<string, unknown>;
        }) => Promise<boolean>;
      }) => {
        const confirmed = await input.onBeforeAction?.({
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
        });

        expect(confirmed).toBe(true);
        return createWriteValidationReport("pass");
      }
    );

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--write-validation",
      "--account",
      "secondary",
      "--json"
    ]);

    expect(stderrChunks.join(" ")).toContain("Action: send_message");
    expect(stderrChunks.join(" ")).toContain("Execute this action?");
    expect(stdoutChunks).toEqual([]);
    expect(
      JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "")) as {
        outcome: string;
      }
    ).toMatchObject({
      outcome: "pass"
    });
  });

  it("sets exit code 1 for failing reports in json mode", async () => {
    writeValidationCliMocks.runLinkedInWriteValidation.mockResolvedValue(
      createWriteValidationReport("fail")
    );

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--write-validation",
      "--account",
      "secondary",
      "--json"
    ]);

    expect(process.exitCode).toBe(1);
    expect(
      JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "")) as {
        outcome: string;
      }
    ).toMatchObject({
      outcome: "fail"
    });
  });

  it("prints a human-readable validation error on harness failures", async () => {
    writeValidationCliMocks.runLinkedInWriteValidation.mockRejectedValue(
      new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Write validation refused to send to an unapproved recipient.",
        {
          account: "secondary",
          action_type: "send_message"
        }
      )
    );

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--write-validation",
      "--account",
      "secondary"
    ]);

    const stderrOutput = stripVTControlCharacters(stderrChunks.join(""));

    expect(process.exitCode).toBe(2);
    expect(stderrOutput).toContain("Write validation failed [ACTION_PRECONDITION_FAILED]");
    expect(stderrOutput).toContain("unapproved recipient");
    expect(stderrOutput).toContain("action_type: send_message");
  });

  it("rethrows harness failures in json mode after setting the error exit code", async () => {
    writeValidationCliMocks.runLinkedInWriteValidation.mockRejectedValue(
      new Error("Stored session expired.")
    );

    await expect(
      runCli([
        "node",
        "linkedin",
        "test:live",
        "--write-validation",
        "--account",
        "secondary",
        "--json"
      ])
    ).rejects.toThrow("Stored session expired.");

    expect(process.exitCode).toBe(2);
  });
});
