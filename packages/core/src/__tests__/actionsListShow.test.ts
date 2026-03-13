import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfigPaths, resolveConfigPaths } from "../config.js";
import { AssistantDatabase } from "../db/database.js";
import {
  TwoPhaseCommitService,
  computeEffectiveStatus,
} from "../twoPhaseCommit.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDb(): { db: AssistantDatabase; baseDir: string } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "linkedin-actions-list-"));
  tempDirs.push(baseDir);
  const paths = resolveConfigPaths(baseDir);
  ensureConfigPaths(paths);
  const db = new AssistantDatabase(paths.dbPath);
  return { db, baseDir };
}

describe("computeEffectiveStatus", () => {
  const now = Date.now();

  it("returns 'confirmed' for executed actions", () => {
    expect(computeEffectiveStatus("executed", now + 10_000, now)).toBe("confirmed");
  });

  it("returns 'failed' for failed actions", () => {
    expect(computeEffectiveStatus("failed", now + 10_000, now)).toBe("failed");
  });

  it("returns 'prepared' for prepared actions that are not expired", () => {
    expect(computeEffectiveStatus("prepared", now + 10_000, now)).toBe("prepared");
  });

  it("returns 'expired' for prepared actions past expiry", () => {
    expect(computeEffectiveStatus("prepared", now - 1_000, now)).toBe("expired");
  });
});

describe("TwoPhaseCommitService.listPreparedActions", () => {
  it("returns empty list when no actions exist", () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService(db);
    const result = service.listPreparedActions({ limit: 10 });
    expect(result).toEqual([]);
  });

  it("lists prepared actions ordered by created_at DESC", () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService(db);

    service.prepare({
      actionType: "test.first",
      target: { profile_name: "default" },
      payload: { text: "first" },
      preview: { summary: "First action" },
    });
    service.prepare({
      actionType: "test.second",
      target: { profile_name: "default" },
      payload: { text: "second" },
      preview: { summary: "Second action" },
    });

    const result = service.listPreparedActions({ limit: 10 });
    expect(result).toHaveLength(2);
    expect(result[0]!.actionType).toBe("test.second");
    expect(result[1]!.actionType).toBe("test.first");
  });

  it("respects limit parameter", () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService(db);

    for (let i = 0; i < 5; i++) {
      service.prepare({
        actionType: `test.action${i}`,
        target: { profile_name: "default" },
        payload: { text: `action ${i}` },
        preview: { summary: `Action ${i}` },
      });
    }

    const result = service.listPreparedActions({ limit: 3 });
    expect(result).toHaveLength(3);
  });

  it("filters by effective status 'prepared'", () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService(db);
    const nowMs = Date.now();

    service.prepare({
      actionType: "test.valid",
      target: { profile_name: "default" },
      payload: { text: "valid" },
      preview: { summary: "Valid action" },
      nowMs,
    });

    service.prepare({
      actionType: "test.expired",
      target: { profile_name: "default" },
      payload: { text: "expired" },
      preview: { summary: "Expired action" },
      expiresInMs: 1,
      nowMs: nowMs - 10_000,
    });

    const result = service.listPreparedActions({
      status: "prepared",
      limit: 10,
      nowMs,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.actionType).toBe("test.valid");
    expect(result[0]!.effectiveStatus).toBe("prepared");
  });

  it("filters by effective status 'expired'", () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService(db);
    const nowMs = Date.now();

    service.prepare({
      actionType: "test.valid",
      target: { profile_name: "default" },
      payload: { text: "valid" },
      preview: { summary: "Valid action" },
      nowMs,
    });

    service.prepare({
      actionType: "test.expired",
      target: { profile_name: "default" },
      payload: { text: "expired" },
      preview: { summary: "Expired action" },
      expiresInMs: 1,
      nowMs: nowMs - 10_000,
    });

    const result = service.listPreparedActions({
      status: "expired",
      limit: 10,
      nowMs,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.actionType).toBe("test.expired");
    expect(result[0]!.effectiveStatus).toBe("expired");
  });

  it("filters by effective status 'confirmed'", async () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService(db, {
      executors: {
        "test.echo": {
          execute() {
            return { ok: true, result: { done: true }, artifacts: [] };
          },
        },
      },
      getRuntime: () => ({}),
    });

    const prepared = service.prepare({
      actionType: "test.echo",
      target: { profile_name: "default" },
      payload: { text: "hello" },
      preview: { summary: "Test" },
    });
    await service.confirmByToken({ confirmToken: prepared.confirmToken });

    service.prepare({
      actionType: "test.echo",
      target: { profile_name: "default" },
      payload: { text: "pending" },
      preview: { summary: "Pending" },
    });

    const result = service.listPreparedActions({ status: "confirmed", limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.effectiveStatus).toBe("confirmed");
  });
});

describe("TwoPhaseCommitService.getPreparedAction", () => {
  it("returns a prepared action by ID", () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService(db);

    const prepared = service.prepare({
      actionType: "test.show",
      target: { profile_name: "default" },
      payload: { text: "hello" },
      preview: { summary: "Show test" },
    });

    const action = service.getPreparedAction(prepared.preparedActionId);
    expect(action.id).toBe(prepared.preparedActionId);
    expect(action.actionType).toBe("test.show");
    expect(action.status).toBe("prepared");
    expect(action.preview).toEqual({ summary: "Show test" });
  });

  it("throws TARGET_NOT_FOUND for missing action", () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService(db);

    expect(() => service.getPreparedAction("pa_nonexistent")).toThrow(
      /Prepared action not found/,
    );
  });
});

describe("AssistantDatabase.listPreparedActions", () => {
  it("returns empty array when table is empty", () => {
    const { db } = createTempDb();
    const result = db.listPreparedActions(10);
    expect(result).toEqual([]);
  });
});
