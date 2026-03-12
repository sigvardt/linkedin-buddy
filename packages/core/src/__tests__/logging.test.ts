import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPaths } from "../config.js";
import { JsonEventLogger } from "../logging.js";
import type { AssistantDatabase } from "../db/database.js";
import type { PrivacyConfig } from "../privacy.js";

const tempDirs: string[] = [];

function createTempPaths() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "linkedin-logging-test-"));
  tempDirs.push(baseDir);
  return resolveConfigPaths(baseDir);
}

function parseJsonLines(filePath: string): Array<Record<string, unknown>> {
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) {
    return [];
  }

  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("logging", () => {
  it("creates a run-specific events path", () => {
    const paths = createTempPaths();
    const logger = new JsonEventLogger(paths, "run-123");

    expect(logger.getEventsPath()).toBe(
      path.join(paths.artifactsDir, "run-123", "events.jsonl"),
    );
    expect(existsSync(path.join(paths.artifactsDir, "run-123"))).toBe(true);
  });

  it("writes structured JSON event entries", () => {
    const paths = createTempPaths();
    const logger = new JsonEventLogger(paths, "run-structured");

    const entry = logger.log("info", "action.started", {
      action_id: "act-1",
      duration_ms: 5,
    });

    expect(entry.run_id).toBe("run-structured");
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("action.started");
    expect(entry.payload).toEqual({
      action_id: "act-1",
      duration_ms: 5,
    });
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);

    const lines = parseJsonLines(logger.getEventsPath());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      run_id: "run-structured",
      level: "info",
      event: "action.started",
      payload: {
        action_id: "act-1",
        duration_ms: 5,
      },
    });
  });

  it("appends multiple events to a jsonl file", () => {
    const paths = createTempPaths();
    const logger = new JsonEventLogger(paths, "run-append");

    logger.log("debug", "first", { index: 1 });
    logger.log("warn", "second", { index: 2 });

    const lines = parseJsonLines(logger.getEventsPath());
    expect(lines).toHaveLength(2);
    expect(lines[0]?.event).toBe("first");
    expect(lines[1]?.event).toBe("second");
  });

  it("supports all log levels", () => {
    const paths = createTempPaths();
    const logger = new JsonEventLogger(paths, "run-levels");

    logger.log("debug", "level.debug");
    logger.log("info", "level.info");
    logger.log("warn", "level.warn");
    logger.log("error", "level.error");

    const levels = parseJsonLines(logger.getEventsPath()).map(
      (entry) => entry.level,
    );
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
  });

  it("defaults payload to an empty object", () => {
    const paths = createTempPaths();
    const logger = new JsonEventLogger(paths, "run-empty-payload");

    const entry = logger.log("info", "no.payload");

    expect(entry.payload).toEqual({});
    const lines = parseJsonLines(logger.getEventsPath());
    expect(lines[0]?.payload).toEqual({});
  });

  it("redacts payload values before writing to disk", () => {
    const paths = createTempPaths();
    const privacy: PrivacyConfig = {
      redactionMode: "partial",
      storageMode: "full",
      hashSalt: "salt",
      messageExcerptLength: 8,
    };
    const logger = new JsonEventLogger(
      paths,
      "run-redaction",
      undefined,
      privacy,
    );

    logger.log("info", "privacy.check", {
      email: "owner@example.com",
      messages: [{ text: "Hello Jane Doe" }],
    });

    const serialized = readFileSync(logger.getEventsPath(), "utf8");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("Hello Jane Doe");
    expect(serialized).toContain("email#");
    expect(serialized).toContain("[len=");
  });

  it("sends sanitized log rows to the database when configured", () => {
    const paths = createTempPaths();
    const insertRunLog = vi.fn();
    const db = {
      insertRunLog,
    } as unknown as AssistantDatabase;
    const logger = new JsonEventLogger(paths, "run-db", db, {
      redactionMode: "partial",
      storageMode: "full",
      hashSalt: "salt",
      messageExcerptLength: 8,
    });

    logger.log("error", "db.persisted", {
      email: "owner@example.com",
    });

    expect(insertRunLog).toHaveBeenCalledOnce();
    expect(insertRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-db",
        level: "error",
        eventName: "db.persisted",
      }),
    );

    const insertedRow = insertRunLog.mock.calls[0]?.[0] as {
      payloadJson: string;
      createdAtMs: number;
    };
    expect(insertedRow.payloadJson).toContain("email#");
    expect(insertedRow.payloadJson).not.toContain("owner@example.com");
    expect(typeof insertedRow.createdAtMs).toBe("number");
  });

  it("does not require a database dependency", () => {
    const paths = createTempPaths();
    const logger = new JsonEventLogger(paths, "run-no-db");

    expect(() => logger.log("info", "no-db", { ok: true })).not.toThrow();
    expect(parseJsonLines(logger.getEventsPath())).toHaveLength(1);
  });
});
