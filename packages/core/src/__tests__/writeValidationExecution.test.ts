import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedInAssistantError } from "../errors.js";
import { LIKE_POST_ACTION_TYPE } from "../linkedinFeed.js";
import {
  SEND_MESSAGE_ACTION_TYPE,
  type WriteValidationScenarioDefinition,
  type WriteValidationVerificationResult
} from "../writeValidationShared.js";
import type { WriteValidationAccount } from "../writeValidationAccounts.js";
import type {
  ConfirmByTokenResult,
  PreparedActionResult
} from "../twoPhaseCommit.js";

const writeValidationExecutionMocks = vi.hoisted(() => ({
  createWriteValidationRuntime: vi.fn(),
  resolveWriteValidationAccount: vi.fn(),
  scenarios: [] as WriteValidationScenarioDefinition[]
}));

vi.mock("../writeValidationRuntime.js", () => ({
  createWriteValidationRuntime: writeValidationExecutionMocks.createWriteValidationRuntime
}));

vi.mock("../writeValidationAccounts.js", async () => {
  const actual = await vi.importActual<typeof import("../writeValidationAccounts.js")>(
    "../writeValidationAccounts.js"
  );

  return {
    ...actual,
    resolveWriteValidationAccount: writeValidationExecutionMocks.resolveWriteValidationAccount
  };
});

vi.mock("../writeValidationScenarios.js", () => ({
  LINKEDIN_WRITE_VALIDATION_ACTIONS: [],
  WRITE_VALIDATION_SCENARIOS: writeValidationExecutionMocks.scenarios
}));

import { runLinkedInWriteValidation } from "../writeValidation.js";

interface MockRuntimeBundle {
  profileManager: {
    capturePageScreenshot: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  runtime: {
    artifacts: {
      resolve: (relativePath: string) => string;
      writeText: ReturnType<typeof vi.fn>;
      writeJson: ReturnType<typeof vi.fn>;
    };
    close: ReturnType<typeof vi.fn>;
    logger: {
      getEventsPath: () => string;
      log: ReturnType<typeof vi.fn>;
    };
    runId: string;
    twoPhaseCommit: {
      confirmByToken: ReturnType<typeof vi.fn>;
    };
  };
}

const tempDirs: string[] = [];

function createTempBaseDir(): string {
  const baseDir = mkdtempSync(path.join(tmpdir(), "linkedin-write-validation-execution-"));
  tempDirs.push(baseDir);
  return baseDir;
}

function createAccount(): WriteValidationAccount {
  return {
    designation: "secondary",
    id: "secondary",
    label: "Secondary",
    profileName: "secondary-profile",
    sessionName: "secondary-session",
    targets: {
      send_message: {
        participantPattern: "Simon Miller",
        thread: "https://www.linkedin.com/messaging/thread/abc123/"
      }
    }
  };
}

function createPreparedActionResult(input?: {
  preparedActionId?: string;
  preview?: Record<string, unknown>;
}): PreparedActionResult {
  return {
    confirmToken: `ct_${input?.preparedActionId ?? "prepared_123"}`,
    expiresAtMs: Date.now() + 60_000,
    preparedActionId: input?.preparedActionId ?? "prepared_123",
    preview: input?.preview ?? {}
  };
}

function createConfirmResult(input?: {
  actionType?: string;
  artifacts?: string[];
  preparedActionId?: string;
  result?: Record<string, unknown>;
}): ConfirmByTokenResult {
  return {
    actionType: input?.actionType ?? SEND_MESSAGE_ACTION_TYPE,
    artifacts: input?.artifacts ?? [],
    preparedActionId: input?.preparedActionId ?? "prepared_123",
    result: input?.result ?? {},
    status: "executed"
  };
}

function createVerificationResult(
  overrides?: Partial<WriteValidationVerificationResult>
): WriteValidationVerificationResult {
  return {
    details: {},
    message: "Verification succeeded.",
    source: "test.verify",
    state_synced: null,
    verified: true,
    ...overrides
  };
}

function createRuntimeBundle(baseDir: string): MockRuntimeBundle {
  const runtime: MockRuntimeBundle["runtime"] = {
    artifacts: {
      resolve: (relativePath) => path.join(baseDir, relativePath),
      writeText: vi.fn(),
      writeJson: vi.fn()
    },
    close: vi.fn(),
    logger: {
      getEventsPath: () => path.join(baseDir, "events.jsonl"),
      log: vi.fn()
    },
    runId: "run_write_validation_execution_test",
    twoPhaseCommit: {
      confirmByToken: vi.fn()
    }
  };

  const profileManager: MockRuntimeBundle["profileManager"] = {
    capturePageScreenshot: vi.fn(async ({ actionType, stage }: { actionType: string; stage: string }) => {
      return `${actionType}-${stage}.png`;
    }),
    dispose: vi.fn(async () => undefined)
  };

  writeValidationExecutionMocks.createWriteValidationRuntime.mockResolvedValue({
    profileManager,
    runtime
  });

  return {
    profileManager,
    runtime
  };
}

afterEach(() => {
  delete process.env.CI;
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

beforeEach(() => {
  delete process.env.CI;
  vi.clearAllMocks();
  writeValidationExecutionMocks.scenarios.length = 0;
  writeValidationExecutionMocks.resolveWriteValidationAccount.mockReturnValue(createAccount());
});

describe("runLinkedInWriteValidation execution flow", () => {
  it("continues after a timeout failure and returns a partial report", async () => {
    const baseDir = createTempBaseDir();
    const bundle = createRuntimeBundle(baseDir);

    const failedScenario: WriteValidationScenarioDefinition = {
      actionType: SEND_MESSAGE_ACTION_TYPE,
      expectedOutcome: "The message is sent successfully.",
      riskClass: "private",
      summary: "Send a validation message.",
      prepare: vi.fn(async () => {
        throw new LinkedInAssistantError(
          "TIMEOUT",
          "Timed out while loading the approved messaging thread."
        );
      }),
      resolveAfterScreenshotUrl: vi.fn(() => null),
      verify: vi.fn(async () => createVerificationResult())
    };

    const successfulScenario: WriteValidationScenarioDefinition = {
      actionType: LIKE_POST_ACTION_TYPE,
      expectedOutcome: "The approved reaction remains active on the target post.",
      riskClass: "public",
      summary: "React to the approved post.",
      prepare: vi.fn(async () => ({
        beforeScreenshotUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
        cleanupGuidance: [
          "Remove the validation reaction manually after review if it should not remain visible."
        ],
        prepared: createPreparedActionResult({
          preparedActionId: "prepared_like",
          preview: {
            artifacts: [
              {
                path: "preview-note.txt"
              }
            ],
            outbound: {
              reaction: "like"
            },
            target: {
              postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/"
            }
          }
        }),
        verificationContext: {
          post_url: "https://www.linkedin.com/feed/update/urn:li:activity:123/"
        }
      })),
      resolveAfterScreenshotUrl: vi.fn(() => "https://www.linkedin.com/feed/update/urn:li:activity:123/"),
      verify: vi.fn(async () =>
        createVerificationResult({
          details: {
            reaction: "like"
          },
          message: "Reaction executor reported the approved reaction as active.",
          source: "feed.like_post.confirm_result"
        })
      )
    };

    writeValidationExecutionMocks.scenarios.push(failedScenario, successfulScenario);
    bundle.runtime.twoPhaseCommit.confirmByToken.mockResolvedValue(
      createConfirmResult({
        actionType: LIKE_POST_ACTION_TYPE,
        artifacts: ["confirm-like.txt"],
        preparedActionId: "prepared_like",
        result: {
          reacted: true,
          reaction: "like"
        }
      })
    );

    const report = await runLinkedInWriteValidation({
      accountId: "secondary",
      baseDir,
      cooldownMs: 0,
      interactive: true
    });

    expect(report.outcome).toBe("fail");
    expect(report.fail_count).toBe(1);
    expect(report.pass_count).toBe(1);
    expect(report.actions).toHaveLength(2);
    expect(report.actions[0]).toMatchObject({
      action_type: SEND_MESSAGE_ACTION_TYPE,
      error_code: "TIMEOUT",
      status: "fail"
    });
    expect(report.actions[1]).toMatchObject({
      action_type: LIKE_POST_ACTION_TYPE,
      artifact_paths: expect.arrayContaining([
        "preview-note.txt",
        "confirm-like.txt",
        `${LIKE_POST_ACTION_TYPE}-before.png`,
        `${LIKE_POST_ACTION_TYPE}-after.png`
      ]),
      status: "pass"
    });
    expect(bundle.runtime.twoPhaseCommit.confirmByToken).toHaveBeenCalledTimes(1);
    expect(bundle.profileManager.capturePageScreenshot).toHaveBeenCalledTimes(2);
    expect(bundle.runtime.artifacts.writeText).toHaveBeenCalledWith(
      "live-write-validation/report.html",
      expect.stringContaining("<!doctype html>"),
      "text/html",
      expect.objectContaining({
        account_id: "secondary",
        action_count: 2,
        outcome: "fail"
      })
    );
    expect(bundle.runtime.artifacts.writeJson).toHaveBeenCalledWith(
      "live-write-validation/report.json",
      expect.objectContaining({
        action_count: 2,
        html_report_path: path.join(baseDir, "live-write-validation", "report.html"),
        outcome: "fail"
      }),
      expect.objectContaining({
        account_id: "secondary",
        action_count: 2,
        outcome: "fail"
      })
    );

    const latestReportPath = path.join(
      baseDir,
      "live-write-validation",
      "secondary",
      "latest-report.json"
    );
    expect(existsSync(latestReportPath)).toBe(true);
    expect(JSON.parse(readFileSync(latestReportPath, "utf8")) as { outcome: string }).toMatchObject(
      {
        outcome: "fail"
      }
    );
    expect(bundle.profileManager.dispose).toHaveBeenCalledTimes(1);
    expect(bundle.runtime.close).toHaveBeenCalledTimes(1);
  });

  it("stops early after a rate limit and marks remaining actions cancelled", async () => {
    const baseDir = createTempBaseDir();
    createRuntimeBundle(baseDir);

    const rateLimitedScenario: WriteValidationScenarioDefinition = {
      actionType: SEND_MESSAGE_ACTION_TYPE,
      expectedOutcome: "The message is sent successfully.",
      riskClass: "private",
      summary: "Send a validation message.",
      prepare: vi.fn(async () => {
        throw new LinkedInAssistantError(
          "RATE_LIMITED",
          "LinkedIn asked us to slow down before sending the validation message."
        );
      }),
      resolveAfterScreenshotUrl: vi.fn(() => null),
      verify: vi.fn(async () => createVerificationResult())
    };

    const skippedScenario: WriteValidationScenarioDefinition = {
      actionType: LIKE_POST_ACTION_TYPE,
      expectedOutcome: "The approved reaction remains active on the target post.",
      riskClass: "public",
      summary: "React to the approved post.",
      prepare: vi.fn(async () => {
        throw new Error("remaining scenario should not start");
      }),
      resolveAfterScreenshotUrl: vi.fn(() => null),
      verify: vi.fn(async () => createVerificationResult())
    };

    writeValidationExecutionMocks.scenarios.push(rateLimitedScenario, skippedScenario);

    const report = await runLinkedInWriteValidation({
      accountId: "secondary",
      baseDir,
      cooldownMs: 0,
      interactive: true
    });

    expect(report.outcome).toBe("fail");
    expect(report.fail_count).toBe(1);
    expect(report.cancelled_count).toBe(1);
    expect(report.actions).toEqual([
      expect.objectContaining({
        action_type: SEND_MESSAGE_ACTION_TYPE,
        error_code: "RATE_LIMITED",
        status: "fail"
      }),
      expect.objectContaining({
        action_type: LIKE_POST_ACTION_TYPE,
        error_code: "RATE_LIMITED",
        status: "cancelled"
      })
    ]);
    expect(skippedScenario.prepare).not.toHaveBeenCalled();
    expect(report.recommended_actions).toContain(
      'Wait for LinkedIn to lift rate limiting on session "secondary-session" before rerunning write validation.'
    );
  });

  it("validates scenario config before creating the runtime", async () => {
    const baseDir = createTempBaseDir();

    const scenario: WriteValidationScenarioDefinition = {
      actionType: SEND_MESSAGE_ACTION_TYPE,
      expectedOutcome: "The outbound message is echoed in the approved thread.",
      riskClass: "private",
      summary: "Send a validation message in the approved thread.",
      validateConfig: vi.fn(() => {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          'Write-validation account "secondary" is missing targets.send_message in config.json.'
        );
      }),
      prepare: vi.fn(async () => {
        throw new Error("prepare should not run");
      }),
      resolveAfterScreenshotUrl: vi.fn(() => null),
      verify: vi.fn(async () => createVerificationResult())
    };

    writeValidationExecutionMocks.scenarios.push(scenario);

    await expect(
      runLinkedInWriteValidation({
        accountId: "secondary",
        baseDir,
        cooldownMs: 0,
        interactive: true
      })
    ).rejects.toThrow('Write-validation account "secondary" is missing targets.send_message in config.json.');

    expect(writeValidationExecutionMocks.createWriteValidationRuntime).not.toHaveBeenCalled();
    expect(scenario.prepare).not.toHaveBeenCalled();
  });

  it("continues when screenshot capture fails and records warnings", async () => {
    const baseDir = createTempBaseDir();
    const bundle = createRuntimeBundle(baseDir);

    bundle.profileManager.capturePageScreenshot
      .mockRejectedValueOnce(
        new LinkedInAssistantError("TIMEOUT", "before screenshot timed out")
      )
      .mockRejectedValueOnce(
        new LinkedInAssistantError("TIMEOUT", "before screenshot timed out")
      )
      .mockResolvedValueOnce("send_message-after.png");

    const scenario: WriteValidationScenarioDefinition = {
      actionType: SEND_MESSAGE_ACTION_TYPE,
      expectedOutcome: "The outbound message is echoed in the approved thread.",
      riskClass: "private",
      summary: "Send a validation message in the approved thread.",
      prepare: vi.fn(async () => ({
        beforeScreenshotUrl: "https://www.linkedin.com/messaging/thread/abc123/",
        cleanupGuidance: [],
        prepared: createPreparedActionResult({
          preview: {
            outbound: {
              text: "Quick validation ping"
            },
            target: {
              thread: "abc123"
            }
          }
        }),
        verificationContext: {}
      })),
      resolveAfterScreenshotUrl: vi.fn(() => "https://www.linkedin.com/messaging/thread/abc123/"),
      verify: vi.fn(async () => createVerificationResult())
    };

    writeValidationExecutionMocks.scenarios.push(scenario);
    bundle.runtime.twoPhaseCommit.confirmByToken.mockResolvedValue(
      createConfirmResult({
        result: {
          sent: true
        }
      })
    );

    const report = await runLinkedInWriteValidation({
      accountId: "secondary",
      baseDir,
      cooldownMs: 0,
      interactive: true
    });

    expect(report.outcome).toBe("pass");
    expect(report.actions).toEqual([
      expect.objectContaining({
        action_type: SEND_MESSAGE_ACTION_TYPE,
        after_screenshot_paths: ["send_message-after.png"],
        before_screenshot_paths: [],
        status: "pass",
        warnings: expect.arrayContaining([
          "Retried 1 time before capturing the pre-action screenshot still failed.",
          "before screenshot timed out"
        ])
      })
    ]);
    expect(bundle.runtime.twoPhaseCommit.confirmByToken).toHaveBeenCalledTimes(1);
    expect(scenario.verify).toHaveBeenCalledTimes(1);
  });

  it("blocks concurrent runs for the same account", async () => {
    const baseDir = createTempBaseDir();
    createRuntimeBundle(baseDir);

    let promptEnteredResolve: (() => void) | undefined;
    let releaseFirstRunResolve: ((value: boolean) => void) | undefined;
    const promptEntered = new Promise<void>((resolve) => {
      promptEnteredResolve = resolve;
    });
    const releaseFirstRun = new Promise<boolean>((resolve) => {
      releaseFirstRunResolve = resolve;
    });

    const scenario: WriteValidationScenarioDefinition = {
      actionType: SEND_MESSAGE_ACTION_TYPE,
      expectedOutcome: "The outbound message is echoed in the approved thread.",
      riskClass: "private",
      summary: "Send a validation message in the approved thread.",
      prepare: vi.fn(async () => ({
        beforeScreenshotUrl: "https://www.linkedin.com/messaging/thread/abc123/",
        cleanupGuidance: [],
        prepared: createPreparedActionResult(),
        verificationContext: {}
      })),
      resolveAfterScreenshotUrl: vi.fn(() => null),
      verify: vi.fn(async () => createVerificationResult())
    };

    writeValidationExecutionMocks.scenarios.push(scenario);

    const firstRun = runLinkedInWriteValidation({
      accountId: "secondary",
      baseDir,
      cooldownMs: 0,
      interactive: true,
      onBeforeAction: async () => {
        promptEnteredResolve?.();
        return releaseFirstRun;
      }
    });

    await promptEntered;

    await expect(
      runLinkedInWriteValidation({
        accountId: "secondary",
        baseDir,
        cooldownMs: 0,
        interactive: true
      })
    ).rejects.toThrow('Write validation is already running for account "secondary"');

    releaseFirstRunResolve?.(false);
    await expect(firstRun).resolves.toMatchObject({
      cancelled_count: 1,
      outcome: "cancelled"
    });
    expect(writeValidationExecutionMocks.createWriteValidationRuntime).toHaveBeenCalledTimes(1);
  });

  it("records cancelled actions when the operator declines execution", async () => {
    const baseDir = createTempBaseDir();
    const bundle = createRuntimeBundle(baseDir);

    const scenario: WriteValidationScenarioDefinition = {
      actionType: SEND_MESSAGE_ACTION_TYPE,
      expectedOutcome: "The outbound message is echoed in the approved thread.",
      riskClass: "private",
      summary: "Send a validation message in the approved thread.",
      prepare: vi.fn(async () => ({
        beforeScreenshotUrl: "https://www.linkedin.com/messaging/thread/abc123/",
        cleanupGuidance: ["No cleanup needed."],
        prepared: createPreparedActionResult({
          preview: {
            artifacts: [
              {
                path: "existing-before.png"
              },
              {
                path: "existing-before.png"
              }
            ],
            outbound: {
              text: "Quick validation ping"
            },
            target: {
              thread: "abc123"
            }
          }
        }),
        verificationContext: {}
      })),
      resolveAfterScreenshotUrl: vi.fn(() => null),
      verify: vi.fn(async () => createVerificationResult())
    };

    writeValidationExecutionMocks.scenarios.push(scenario);

    const report = await runLinkedInWriteValidation({
      accountId: "secondary",
      baseDir,
      cooldownMs: 0,
      interactive: true,
      onBeforeAction: async () => false
    });

    expect(report.outcome).toBe("cancelled");
    expect(report.cancelled_count).toBe(1);
    expect(report.actions).toEqual([
      expect.objectContaining({
        action_type: SEND_MESSAGE_ACTION_TYPE,
        after_screenshot_paths: [],
        artifact_paths: ["existing-before.png"],
        before_screenshot_paths: ["existing-before.png"],
        cleanup_guidance: ["No cleanup needed."],
        confirm_artifacts: [],
        status: "cancelled"
      })
    ]);
    expect(bundle.runtime.twoPhaseCommit.confirmByToken).not.toHaveBeenCalled();
    expect(bundle.profileManager.capturePageScreenshot).not.toHaveBeenCalled();
  });
});
