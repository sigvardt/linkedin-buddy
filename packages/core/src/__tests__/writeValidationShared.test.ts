import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedActionResult } from "../twoPhaseCommit.js";
import type { WriteValidationAccount } from "../writeValidationAccounts.js";
import {
  SEND_MESSAGE_ACTION_TYPE,
  buildPreview,
  buildRecommendedActions,
  buildWriteValidationReportAccount,
  buildWriteValidationSummary,
  countActionStatuses,
  dedupeStrings,
  determineActionStatus,
  determineOutcome,
  isRecord,
  isScreenshotPath,
  normalizeText,
  readPreviewArtifacts,
  writeJsonFile,
  type WriteValidationActionResult,
  type WriteValidationResultStatus,
  type WriteValidationScenarioDefinition,
  type WriteValidationVerificationResult
} from "../writeValidationShared.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "linkedin-write-validation-shared-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createScenario(): WriteValidationScenarioDefinition {
  return {
    actionType: SEND_MESSAGE_ACTION_TYPE,
    expectedOutcome: "The outbound message is echoed in the approved conversation thread.",
    riskClass: "private",
    summary: "Send a message in the approved thread and verify the outbound message appears.",
    async prepare() {
      throw new Error("prepare should not run in this test");
    },
    resolveAfterScreenshotUrl() {
      return null;
    },
    async verify() {
      throw new Error("verify should not run in this test");
    }
  };
}

function createPreparedAction(
  preview: PreparedActionResult["preview"]
): PreparedActionResult {
  return {
    preparedActionId: "prepared_123",
    confirmToken: "confirm_123",
    expiresAtMs: 1_746_000_000_000,
    preview
  };
}

function createActionResult(
  status: WriteValidationResultStatus,
  overrides: Partial<WriteValidationActionResult> = {}
): WriteValidationActionResult {
  return {
    action_type: SEND_MESSAGE_ACTION_TYPE,
    after_screenshot_paths: [],
    artifact_paths: [],
    before_screenshot_paths: [],
    cleanup_guidance: [],
    completed_at: "2026-03-09T10:00:05.000Z",
    confirm_artifacts: [],
    expected_outcome: "The outbound message is echoed in the approved conversation thread.",
    preview: {
      action_type: SEND_MESSAGE_ACTION_TYPE,
      expected_outcome: "The outbound message is echoed in the approved conversation thread.",
      outbound: {
        text: "Quick validation ping"
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
    status,
    summary: "Send a message in the approved thread and verify the outbound message appears.",
    ...overrides
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("writeValidationShared", () => {
  it("normalizes preview data and artifact paths", () => {
    const preview = {
      artifacts: [
        {
          path: "live-write-validation/send-message-before.png"
        },
        {
          path: 123
        },
        null,
        "not-a-record"
      ],
      outbound: {
        text: "Quick validation ping"
      },
      target: "not-an-object"
    } satisfies PreparedActionResult["preview"];

    const prepared = createPreparedAction(preview);
    const builtPreview = buildPreview(createScenario(), prepared);

    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(["not", "a", "record"])).toBe(false);
    expect(normalizeText("  hello\nthere  ")).toBe("hello there");
    expect(dedupeStrings(["one", " ", "one", "two"])).toEqual(["one", "two"]);
    expect(isScreenshotPath("  image.PNG ")).toBe(true);
    expect(isScreenshotPath("report.json")).toBe(false);
    expect(readPreviewArtifacts(prepared.preview)).toEqual([
      "live-write-validation/send-message-before.png"
    ]);
    expect(builtPreview).toEqual({
      action_type: SEND_MESSAGE_ACTION_TYPE,
      expected_outcome: "The outbound message is echoed in the approved conversation thread.",
      outbound: {
        text: "Quick validation ping"
      },
      risk_class: "private",
      summary: "Send a message in the approved thread and verify the outbound message appears.",
      target: {}
    });
  });

  it("derives action status counts and overall outcomes", () => {
    const passVerification: WriteValidationVerificationResult = {
      details: {},
      message: "verified",
      source: "test",
      state_synced: true,
      verified: true
    };
    const syncFailureVerification: WriteValidationVerificationResult = {
      details: {},
      message: "state mismatch",
      source: "test",
      state_synced: false,
      verified: true
    };
    const actions = [
      createActionResult("pass"),
      createActionResult("cancelled"),
      createActionResult("fail")
    ];

    expect(determineActionStatus(passVerification)).toBe("pass");
    expect(determineActionStatus(syncFailureVerification)).toBe("fail");
    expect(countActionStatuses(actions)).toEqual({
      cancelledCount: 1,
      failCount: 1,
      passCount: 1
    });
    expect(determineOutcome(actions)).toBe("fail");
    expect(determineOutcome([createActionResult("cancelled")])).toBe("cancelled");
    expect(determineOutcome([createActionResult("pass")])).toBe("pass");
  });

  it("builds summaries and recommended next actions without duplicates", () => {
    const report = {
      actions: [
        createActionResult("fail", {
          cleanup_guidance: [
            "Undo the validation change manually.",
            "Undo the validation change manually."
          ]
        }),
        createActionResult("pass", {
          cleanup_guidance: ["Archive the validation screenshots after review."]
        })
      ],
      audit_log_path: "/tmp/live-write-validation/events.jsonl",
      report_path: "/tmp/live-write-validation/report.json"
    };

    expect(
      buildWriteValidationSummary({
        action_count: 2,
        cancelled_count: 0,
        fail_count: 1,
        outcome: "fail",
        pass_count: 1
      })
    ).toBe(
      "Checked 2 write-validation actions. 1 passed. 1 failed. 0 cancelled. Overall outcome: fail."
    );
    expect(buildRecommendedActions(report)).toEqual([
      "Review /tmp/live-write-validation/report.json for the full per-action report and screenshots.",
      "Open /tmp/live-write-validation/events.jsonl to inspect the structured audit log for this run.",
      "Undo the validation change manually.",
      "Re-check send_message after reviewing /tmp/live-write-validation/report.json and the attached screenshots.",
      "Archive the validation screenshots after review."
    ]);
  });

  it("writes json files and projects account metadata into reports", async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, "reports", "report.json");
    const account: WriteValidationAccount = {
      designation: "secondary",
      id: "secondary-account",
      label: "Secondary Account",
      profileName: "secondary-profile",
      sessionName: "secondary-session",
      targets: {}
    };

    await writeJsonFile(filePath, {
      ok: true,
      values: [1, 2, 3]
    });

    expect(readFileSync(filePath, "utf8")).toBe(`{
  "ok": true,
  "values": [
    1,
    2,
    3
  ]
}\n`);
    expect(buildWriteValidationReportAccount(account)).toEqual({
      designation: "secondary",
      id: "secondary-account",
      label: "Secondary Account",
      profile_name: "secondary-profile",
      session_name: "secondary-session"
    });
  });
});
