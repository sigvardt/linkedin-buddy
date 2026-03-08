import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalDataDeletionPlan,
  deleteLocalData,
  resolveConfigPaths,
  resolveKeepAliveDir
} from "../src/index.js";

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function resolveCanonicalDirectoryPath(targetPath: string): string {
  const normalizedTargetPath = path.resolve(targetPath);

  try {
    return realpathSync(normalizedTargetPath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }

    const parentPath = path.dirname(normalizedTargetPath);
    if (parentPath === normalizedTargetPath) {
      return normalizedTargetPath;
    }

    return path.resolve(
      resolveCanonicalDirectoryPath(parentPath),
      path.basename(normalizedTargetPath)
    );
  }
}

function resolveExpectedDeletionPath(targetPath: string): string {
  const normalizedTargetPath = path.resolve(targetPath);
  return path.resolve(
    resolveCanonicalDirectoryPath(path.dirname(normalizedTargetPath)),
    path.basename(normalizedTargetPath)
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

describe("local data deletion", () => {
  let tempDir = "";
  let baseDir = "";
  let configFilePath = "";
  let rateLimitStatePath = "";
  let previousAssistantHome: string | undefined;

  beforeEach(async () => {
    previousAssistantHome = process.env.LINKEDIN_ASSISTANT_HOME;
    delete process.env.LINKEDIN_ASSISTANT_HOME;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-local-data-"));
    baseDir = path.join(tempDir, "assistant-home");
    configFilePath = path.join(baseDir, "config.json");
    rateLimitStatePath = path.join(baseDir, "rate-limit-state.json");
  });

  afterEach(async () => {
    if (typeof previousAssistantHome === "string") {
      process.env.LINKEDIN_ASSISTANT_HOME = previousAssistantHome;
    } else {
      delete process.env.LINKEDIN_ASSISTANT_HOME;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedLocalDataFixture(): Promise<ReturnType<typeof resolveConfigPaths>> {
    const paths = resolveConfigPaths(baseDir);
    const keepAliveDir = resolveKeepAliveDir(baseDir);

    await mkdir(path.dirname(paths.dbPath), { recursive: true });
    await writeFile(paths.dbPath, "sqlite-data", "utf8");
    await writeFile(`${paths.dbPath}-journal`, "sqlite-journal", "utf8");
    await writeFile(`${paths.dbPath}-wal`, "sqlite-wal", "utf8");
    await writeFile(`${paths.dbPath}-shm`, "sqlite-shm", "utf8");
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
    await writeFile(configFilePath, "{\"safe\":true}\n", "utf8");

    return paths;
  }

  it("builds a deletion plan under the configured base directory by default", () => {
    const paths = resolveConfigPaths(baseDir);
    const keepAliveDir = resolveKeepAliveDir(baseDir);

    const plan = createLocalDataDeletionPlan({ baseDir });

    expect(plan.includeProfile).toBe(false);
    expect(plan.targets).toEqual(
      expect.arrayContaining([
        resolveExpectedDeletionPath(paths.dbPath),
        resolveExpectedDeletionPath(`${paths.dbPath}-journal`),
        resolveExpectedDeletionPath(`${paths.dbPath}-wal`),
        resolveExpectedDeletionPath(`${paths.dbPath}-shm`),
        resolveExpectedDeletionPath(paths.artifactsDir),
        resolveExpectedDeletionPath(keepAliveDir),
        resolveExpectedDeletionPath(rateLimitStatePath)
      ])
    );
    expect(plan.targets).not.toContain(resolveExpectedDeletionPath(paths.profilesDir));
  });

  it("uses an explicit rate-limit state path when provided", () => {
    const explicitRateLimitStatePath = path.join(
      tempDir,
      "external",
      "rate-limit-state.json"
    );

    const plan = createLocalDataDeletionPlan({
      baseDir,
      rateLimitStatePath: explicitRateLimitStatePath
    });

    expect(plan.targets).toContain(
      resolveExpectedDeletionPath(explicitRateLimitStatePath)
    );
    expect(plan.targets).not.toContain(resolveExpectedDeletionPath(rateLimitStatePath));
  });

  it("resolves the keepalive directory from the shared config path", () => {
    expect(resolveKeepAliveDir(baseDir)).toBe(path.join(baseDir, "keepalive"));

    process.env.LINKEDIN_ASSISTANT_HOME = baseDir;
    expect(resolveKeepAliveDir()).toBe(path.join(baseDir, "keepalive"));
  });

  it("refuses to build a deletion plan for the filesystem root", () => {
    const filesystemRoot = path.parse(baseDir).root;

    expect(() =>
      createLocalDataDeletionPlan({ baseDir: filesystemRoot })
    ).toThrowError("filesystem root");
  });

  it("deletes database sidecars and preserves config.json by default", async () => {
    const paths = await seedLocalDataFixture();
    const keepAliveDir = resolveKeepAliveDir(baseDir);

    const result = await deleteLocalData({ baseDir });

    expect(result.deletedPaths).toEqual(
      expect.arrayContaining([
        resolveExpectedDeletionPath(paths.dbPath),
        resolveExpectedDeletionPath(`${paths.dbPath}-journal`),
        resolveExpectedDeletionPath(`${paths.dbPath}-wal`),
        resolveExpectedDeletionPath(`${paths.dbPath}-shm`),
        resolveExpectedDeletionPath(paths.artifactsDir),
        resolveExpectedDeletionPath(keepAliveDir),
        resolveExpectedDeletionPath(rateLimitStatePath)
      ])
    );
    expect(result.failedPaths).toEqual([]);
    expect(result.startedAt <= result.completedAt).toBe(true);
    expect(await pathExists(paths.dbPath)).toBe(false);
    expect(await pathExists(`${paths.dbPath}-journal`)).toBe(false);
    expect(await pathExists(`${paths.dbPath}-wal`)).toBe(false);
    expect(await pathExists(`${paths.dbPath}-shm`)).toBe(false);
    expect(await pathExists(paths.artifactsDir)).toBe(false);
    expect(await pathExists(keepAliveDir)).toBe(false);
    expect(await pathExists(rateLimitStatePath)).toBe(false);
    expect(await pathExists(configFilePath)).toBe(true);
    expect(await pathExists(paths.profilesDir)).toBe(true);
  });

  it("reports missing paths cleanly when only part of the local state exists", async () => {
    const paths = resolveConfigPaths(baseDir);
    const keepAliveDir = resolveKeepAliveDir(baseDir);

    await mkdir(path.dirname(paths.dbPath), { recursive: true });
    await writeFile(paths.dbPath, "sqlite-data", "utf8");
    await mkdir(keepAliveDir, { recursive: true });
    await writeFile(path.join(keepAliveDir, "default.pid"), "321\n", "utf8");
    await writeFile(configFilePath, "{\"safe\":true}\n", "utf8");
    await mkdir(path.join(paths.profilesDir, "default"), { recursive: true });

    const result = await deleteLocalData({ baseDir });

    expect(result.deletedPaths).toEqual(
      expect.arrayContaining([
        resolveExpectedDeletionPath(paths.dbPath),
        resolveExpectedDeletionPath(keepAliveDir)
      ])
    );
    expect(result.missingPaths).toEqual(
      expect.arrayContaining([
        resolveExpectedDeletionPath(`${paths.dbPath}-journal`),
        resolveExpectedDeletionPath(`${paths.dbPath}-wal`),
        resolveExpectedDeletionPath(`${paths.dbPath}-shm`),
        resolveExpectedDeletionPath(paths.artifactsDir),
        resolveExpectedDeletionPath(rateLimitStatePath)
      ])
    );
    expect(result.failedPaths).toEqual([]);
    expect(await pathExists(paths.dbPath)).toBe(false);
    expect(await pathExists(keepAliveDir)).toBe(false);
    expect(await pathExists(configFilePath)).toBe(true);
    expect(await pathExists(paths.profilesDir)).toBe(true);
  });

  it("deletes browser profiles only when includeProfile is enabled", async () => {
    const paths = await seedLocalDataFixture();

    const result = await deleteLocalData({
      baseDir,
      includeProfile: true
    });

    expect(result.deletedPaths).toContain(
      resolveExpectedDeletionPath(paths.profilesDir)
    );
    expect(result.failedPaths).toEqual([]);
    expect(await pathExists(paths.profilesDir)).toBe(false);
    expect(await pathExists(configFilePath)).toBe(true);
  });

  it("is idempotent when deleteLocalData runs repeatedly", async () => {
    const paths = await seedLocalDataFixture();
    const keepAliveDir = resolveKeepAliveDir(baseDir);

    await deleteLocalData({ baseDir });
    const secondResult = await deleteLocalData({ baseDir });

    expect(secondResult.deletedPaths).toEqual([]);
    expect(secondResult.missingPaths).toEqual(
      expect.arrayContaining([
        resolveExpectedDeletionPath(paths.dbPath),
        resolveExpectedDeletionPath(`${paths.dbPath}-journal`),
        resolveExpectedDeletionPath(`${paths.dbPath}-wal`),
        resolveExpectedDeletionPath(`${paths.dbPath}-shm`),
        resolveExpectedDeletionPath(paths.artifactsDir),
        resolveExpectedDeletionPath(keepAliveDir),
        resolveExpectedDeletionPath(rateLimitStatePath)
      ])
    );
    expect(secondResult.failedPaths).toEqual([]);
    expect(await pathExists(configFilePath)).toBe(true);
    expect(await pathExists(paths.profilesDir)).toBe(true);
  });
});
