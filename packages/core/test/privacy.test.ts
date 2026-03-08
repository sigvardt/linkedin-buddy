import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactHelpers,
  AssistantDatabase,
  JsonEventLogger,
  LinkedInAssistantError,
  TwoPhaseCommitService,
  ensureConfigPaths,
  redactStructuredValue,
  resolveConfigPaths,
  toLinkedInAssistantErrorPayload,
  type PrivacyConfig
} from "../src/index.js";

const privacyConfig: PrivacyConfig = {
  redactionMode: "partial",
  storageMode: "excerpt",
  hashSalt: "test-salt",
  messageExcerptLength: 12
};

const privateBody =
  "Hello Simon Miller, this is a private message body that should never be stored verbatim.";

const createdTempDirs: string[] = [];

function createTempBaseDir(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "linkedin-privacy-"));
  createdTempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of createdTempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("privacy redaction", () => {
  it("redacts structured values for user-facing output", () => {
    const output = redactStructuredValue(
      {
        full_name: "Simon Miller",
        email: "simon@example.com",
        profile_url: "https://www.linkedin.com/in/simon-miller/",
        summary: 'Send message to "Simon Miller"',
        threads: [
          {
            thread_id: "thread-1",
            thread_url: "https://www.linkedin.com/messaging/thread/thread-1/",
            title: "Simon Miller",
            snippet: privateBody,
            messages: [
              {
                author: "Simon Miller",
                text: privateBody
              }
            ]
          }
        ],
        notification: {
          message: privateBody,
          timestamp: "now",
          link: "https://www.linkedin.com/notifications/1/",
          is_read: false
        }
      },
      privacyConfig,
      "cli"
    );

    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain("Simon Miller");
    expect(serialized).not.toContain("simon@example.com");
    expect(serialized).not.toContain(privateBody);
    expect(serialized).toContain("person#");
    expect(serialized).toContain("profile#");
    expect(serialized).toContain("[len=");
  });

  it("redacts logs and stored artifact metadata", () => {
    const baseDir = createTempBaseDir();
    const paths = resolveConfigPaths(baseDir);
    ensureConfigPaths(paths);

    const db = new AssistantDatabase(paths.dbPath);

    try {
      const logger = new JsonEventLogger(paths, "run_privacy", db, privacyConfig);
      logger.log("info", "privacy.test", {
        full_name: "Simon Miller",
        email: "simon@example.com",
        messages: [
          {
            author: "Simon Miller",
            text: privateBody
          }
        ]
      });

      const eventsPath = path.join(paths.artifactsDir, "run_privacy", "events.jsonl");
      const events = readFileSync(eventsPath, "utf8");
      expect(events).not.toContain("Simon Miller");
      expect(events).not.toContain("simon@example.com");
      expect(events).not.toContain(privateBody);

      const logs = db.listRunLogs("run_privacy");
      expect(logs).toHaveLength(1);
      expect(logs[0]?.payload_json).not.toContain("Simon Miller");
      expect(logs[0]?.payload_json).not.toContain(privateBody);

      const artifacts = new ArtifactHelpers(paths, "run_privacy", db, privacyConfig);
      artifacts.writeJson(
        "privacy/thread.json",
        {
          full_name: "Simon Miller",
          messages: [{ text: privateBody }]
        },
        {
          participant_name: "Simon Miller"
        }
      );

      const artifactJson = readFileSync(
        path.join(paths.artifactsDir, "run_privacy", "privacy", "thread.json"),
        "utf8"
      );
      expect(artifactJson).not.toContain("Simon Miller");
      expect(artifactJson).not.toContain(privateBody);

      const artifactIndex = db.listArtifactIndex("run_privacy");
      expect(artifactIndex).toHaveLength(1);
      expect(artifactIndex[0]?.metadata_json).not.toContain("Simon Miller");
    } finally {
      db.close();
    }
  });

  it("stores redacted prepared actions but restores sealed payloads for execution", async () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new TwoPhaseCommitService(db, {
        privacy: privacyConfig,
        getRuntime: () => ({ label: "runtime" }),
        executors: {
          send_message: {
            execute: ({ action }) => {
              expect(action.target.participant_name).toBe("Simon Miller");
              expect(action.payload.text).toBe(privateBody);
              return {
                ok: true,
                result: {
                  full_name: String(action.target.participant_name ?? ""),
                  text: String(action.payload.text ?? "")
                },
                artifacts: []
              };
            }
          }
        }
      });

      const target = {
        profile_name: "default",
        thread_id: "thread-1",
        thread_url: "https://www.linkedin.com/messaging/thread/thread-1/",
        title: "Simon Miller",
        participant_name: "Simon Miller"
      };
      const preview = {
        summary: 'Send message to "Simon Miller"',
        target,
        outbound: {
          text: privateBody
        }
      };
      const operatorNote =
        "Reply to Simon Miller with a private follow-up that should also be redacted.";

      const prepared = service.prepare({
        actionType: "send_message",
        target,
        payload: { text: privateBody },
        preview,
        operatorNote,
        nowMs: 1_700_000_000_000
      });

      const row = db.getPreparedActionById(prepared.preparedActionId);
      expect(row).toBeDefined();
      expect(row?.target_json).not.toContain("Simon Miller");
      expect(row?.preview_json).not.toContain("Simon Miller");
      expect(row?.payload_json).not.toContain(privateBody);
      expect(row?.operator_note).not.toContain("Simon Miller");
      expect(row?.sealed_target_json).toBeTruthy();
      expect(row?.sealed_payload_json).toBeTruthy();

      const storedPreview = service.getPreparedActionPreviewByToken({
        confirmToken: prepared.confirmToken
      });
      const storedPreviewJson = JSON.stringify(storedPreview);
      expect(storedPreviewJson).not.toContain("Simon Miller");
      expect(storedPreviewJson).not.toContain(privateBody);

      const confirmed = await service.confirmByToken({
        confirmToken: prepared.confirmToken,
        nowMs: 1_700_000_000_100
      });
      expect(confirmed.result).toEqual({
        full_name: "Simon Miller",
        text: privateBody
      });

      const executedRow = db.getPreparedActionById(prepared.preparedActionId);
      expect(executedRow?.execution_result_json).toBeDefined();
      expect(executedRow?.execution_result_json).not.toContain("Simon Miller");
      expect(executedRow?.execution_result_json).not.toContain(privateBody);
    } finally {
      db.close();
    }
  });

  it("redacts structured error payloads", () => {
    const error = new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      'Prepared action belongs to profile "Simon Miller", but "default" was requested.',
      {
        expected_participant_name: "Simon Miller",
        notification: {
          message: privateBody,
          timestamp: "now",
          link: "https://www.linkedin.com/notifications/1/",
          is_read: false
        },
        email: "simon@example.com"
      }
    );

    const payload = toLinkedInAssistantErrorPayload(error, privacyConfig);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("Simon Miller");
    expect(serialized).not.toContain("simon@example.com");
    expect(serialized).not.toContain(privateBody);
    expect(serialized).toContain("person#");
    expect(serialized).toContain("email#");
  });
});
