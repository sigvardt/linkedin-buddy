import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalDataDeletionPlan,
  deleteLocalData,
  resolveConfigPaths
} from "../src/index.js";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

describe("local data deletion", () => {
  let tempDir = "";
  let baseDir = "";
  let rateLimitStatePath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-local-data-"));
    baseDir = path.join(tempDir, "assistant-home");
    rateLimitStatePath = path.join(tempDir, "rate-limit-state.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedLocalDataFixture(): Promise<ReturnType<typeof resolveConfigPaths>> {
    const paths = resolveConfigPaths(baseDir);
    const keepAliveDir = path.join(baseDir, "keepalive");

    await mkdir(path.dirname(paths.dbPath), { recursive: true });
    await writeFile(paths.dbPath, "sqlite-data", "utf8");
    await mkdir(path.join(paths.artifactsDir, "run-123"), { recursive: true });
    await writeFile(
      path.join(paths.artifactsDir, "run-123", "events.jsonl"),
      "{\"event\":\"runtime.started\"}\n",
      "utf8"
    );
    await mkdir(keepAliveDir, { recursive: true });
    await writeFile(path.join(keepAliveDir, "default.pid"), "321\n", "utf8");
    await writeFile(path.join(keepAliveDir, "default.state.json"), "{}\n", "utf8");
    await writeFile(
      path.join(keepAliveDir, "default.events.jsonl"),
      "{\"event\":\"keepalive.tick\"}\n",
      "utf8"
    );
    await mkdir(path.join(paths.profilesDir, "default"), { recursive: true });
    await writeFile(
      path.join(paths.profilesDir, "default", "Preferences"),
      "profile-data",
      "utf8"
    );
    await writeFile(rateLimitStatePath, "{\"cooldown\":true}\n", "utf8");

    return paths;
  }

  it("builds a deletion plan without browser profiles by default", () => {
    const paths = resolveConfigPaths(baseDir);
    const keepAliveDir = path.join(baseDir, "keepalive");

    const plan = createLocalDataDeletionPlan({
      baseDir,
      rateLimitStatePath
    });

    expect(plan.includeProfile).toBe(false);
    expect(plan.targets).toEqual(
      expect.arrayContaining([
        path.resolve(paths.dbPath),
        path.resolve(paths.artifactsDir),
        path.resolve(keepAliveDir),
        path.resolve(rateLimitStatePath)
      ])
    );
    expect(plan.targets).not.toContain(path.resolve(paths.profilesDir));
  });

  it("deletes database, artifacts, keepalive files, and rate-limit state", async () => {
    const paths = await seedLocalDataFixture();
    const keepAliveDir = path.join(baseDir, "keepalive");

    const result = await deleteLocalData({
      baseDir,
      rateLimitStatePath
    });

    expect(result.deletedPaths).toEqual(
      expect.arrayContaining([
        path.resolve(paths.dbPath),
        path.resolve(paths.artifactsDir),
        path.resolve(keepAliveDir),
        path.resolve(rateLimitStatePath)
      ])
    );
    expect(await pathExists(paths.dbPath)).toBe(false);
    expect(await pathExists(paths.artifactsDir)).toBe(false);
    expect(await pathExists(keepAliveDir)).toBe(false);
    expect(await pathExists(rateLimitStatePath)).toBe(false);
    expect(await pathExists(paths.profilesDir)).toBe(true);
  });

  it("deletes browser profiles only when includeProfile is enabled", async () => {
    const paths = await seedLocalDataFixture();

    const result = await deleteLocalData({
      baseDir,
      includeProfile: true,
      rateLimitStatePath
    });

    expect(result.deletedPaths).toContain(path.resolve(paths.profilesDir));
    expect(await pathExists(paths.profilesDir)).toBe(false);
  });
});
