import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantDatabase } from "../db/database.js";
import { ensureConfigPaths, resolveConfigPaths } from "../config.js";
import {
  TwoPhaseCommitService,
  type ActionExecutor,
  type ActionExecutorResult,
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
  const baseDir = mkdtempSync(
    path.join(tmpdir(), "linkedin-2pc-warnings-"),
  );
  tempDirs.push(baseDir);
  const paths = resolveConfigPaths(baseDir);
  ensureConfigPaths(paths);
  const db = new AssistantDatabase(paths.dbPath);
  return { db, baseDir };
}

class WarningsExecutor implements ActionExecutor<unknown> {
  constructor(private readonly warnings: string[]) {}

  execute(): ActionExecutorResult {
    return {
      ok: true,
      result: { done: true },
      artifacts: ["trace.zip"],
      warnings: this.warnings,
    };
  }
}

class NoWarningsExecutor implements ActionExecutor<unknown> {
  execute(): ActionExecutorResult {
    return {
      ok: true,
      result: { done: true },
      artifacts: [],
    };
  }
}

describe("TwoPhaseCommitService warnings passthrough", () => {
  it("passes executor warnings through to the confirm result", async () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService<unknown>(db, {
      executors: {
        "test.warn": new WarningsExecutor([
          "Post verification failed after publish: timed out",
          "Post-publish screenshot failed: page closed",
        ]),
      },
      getRuntime: () => ({}),
    });

    const prepared = service.prepare({
      actionType: "test.warn",
      target: { profile_name: "default" },
      payload: { text: "hello" },
      preview: { summary: "test" },
    });

    const result = await service.confirm({
      confirmToken: prepared.confirmToken,
    });

    expect(result.status).toBe("executed");
    expect(result.warnings).toEqual([
      "Post verification failed after publish: timed out",
      "Post-publish screenshot failed: page closed",
    ]);
    expect(result.result).toEqual({ done: true });
    expect(result.artifacts).toEqual(["trace.zip"]);
  });

  it("omits warnings field when executor returns no warnings", async () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService<unknown>(db, {
      executors: {
        "test.clean": new NoWarningsExecutor(),
      },
      getRuntime: () => ({}),
    });

    const prepared = service.prepare({
      actionType: "test.clean",
      target: { profile_name: "default" },
      payload: { text: "hello" },
      preview: { summary: "test" },
    });

    const result = await service.confirm({
      confirmToken: prepared.confirmToken,
    });

    expect(result.status).toBe("executed");
    expect(result.warnings).toBeUndefined();
    expect(result.result).toEqual({ done: true });
  });

  it("omits warnings field when executor returns empty warnings array", async () => {
    const { db } = createTempDb();
    const service = new TwoPhaseCommitService<unknown>(db, {
      executors: {
        "test.empty": new WarningsExecutor([]),
      },
      getRuntime: () => ({}),
    });

    const prepared = service.prepare({
      actionType: "test.empty",
      target: { profile_name: "default" },
      payload: { text: "hello" },
      preview: { summary: "test" },
    });

    const result = await service.confirm({
      confirmToken: prepared.confirmToken,
    });

    expect(result.status).toBe("executed");
    expect(result.warnings).toBeUndefined();
  });
});
