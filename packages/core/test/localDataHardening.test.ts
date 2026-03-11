import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalDataDeletionPlan,
  deleteLocalData,
  resolveConfigPaths,
  resolveKeepAliveDir
} from "../src/index.js";

type RemovePath = typeof import("node:fs/promises").rm;

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

async function importLocalDataWithMockedRm(
  rmImplementation: RemovePath
): Promise<typeof import("../src/localData.js")> {
  vi.resetModules();
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises"
    );

    return {
      ...actual,
      rm: rmImplementation
    };
  });

  return await import("../src/localData.js");
}

describe("local data deletion hardening", () => {
  let tempDir = "";
  let baseDir = "";
  let configFilePath = "";
  let rateLimitStatePath = "";
  let previousAssistantHome: string | undefined;

  beforeEach(async () => {
    previousAssistantHome = process.env.LINKEDIN_BUDDY_HOME;
    delete process.env.LINKEDIN_BUDDY_HOME;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-local-data-hardening-"));
    baseDir = path.join(tempDir, "buddy-home");
    configFilePath = path.join(baseDir, "config.json");
    rateLimitStatePath = path.join(baseDir, "rate-limit-state.json");
  });

  afterEach(async () => {
    vi.unmock("node:fs/promises");
    vi.resetModules();
    vi.restoreAllMocks();

    if (typeof previousAssistantHome === "string") {
      process.env.LINKEDIN_BUDDY_HOME = previousAssistantHome;
    } else {
      delete process.env.LINKEDIN_BUDDY_HOME;
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

  it("rejects blank base directories instead of resolving them from cwd", () => {
    expect(() =>
      createLocalDataDeletionPlan({ baseDir: "   " })
    ).toThrowError("must not be empty");
  });

  it("canonicalizes targets through a symlinked buddy home", async () => {
    const realBaseDir = path.join(tempDir, "real-home");
    const symlinkBaseDir = path.join(tempDir, "buddy-home-link");

    await mkdir(realBaseDir, { recursive: true });
    await symlink(realBaseDir, symlinkBaseDir);

    const plan = createLocalDataDeletionPlan({ baseDir: symlinkBaseDir });
    const resolvedBaseDir = resolveCanonicalDirectoryPath(realBaseDir);

    expect(plan.baseDir).toBe(resolvedBaseDir);
    expect(plan.targets).toEqual(
      expect.arrayContaining([
        path.join(resolvedBaseDir, "state.sqlite"),
        path.join(resolvedBaseDir, "state.sqlite-journal"),
        path.join(resolvedBaseDir, "state.sqlite-wal"),
        path.join(resolvedBaseDir, "state.sqlite-shm"),
        path.join(resolvedBaseDir, "artifacts"),
        path.join(resolvedBaseDir, "keepalive"),
        path.join(resolvedBaseDir, "rate-limit-state.json")
      ])
    );
    expect(plan.targets).not.toContain(path.resolve(symlinkBaseDir, "artifacts"));
  });

  it("deletes symlinked target entries without touching data outside the buddy home", async () => {
    const paths = resolveConfigPaths(baseDir);
    const externalArtifactsDir = path.join(tempDir, "external-artifacts");
    const externalArtifactFile = path.join(externalArtifactsDir, "outside.jsonl");

    await mkdir(baseDir, { recursive: true });
    await mkdir(externalArtifactsDir, { recursive: true });
    await writeFile(externalArtifactFile, "outside", "utf8");
    await symlink(externalArtifactsDir, paths.artifactsDir);

    const result = await deleteLocalData({ baseDir });

    expect(result.deletedPaths).toContain(
      resolveExpectedDeletionPath(paths.artifactsDir)
    );
    expect(result.failedPaths).toEqual([]);
    expect(await pathExists(paths.artifactsDir)).toBe(false);
    expect(await pathExists(externalArtifactsDir)).toBe(true);
    expect(await pathExists(externalArtifactFile)).toBe(true);
  });

  it("continues deleting other targets after a permission-style failure and returns recovery guidance", async () => {
    const paths = await seedLocalDataFixture();
    const keepAliveDir = resolveKeepAliveDir(baseDir);
    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises"
    );
    const { deleteLocalData: deleteLocalDataWithMock } =
      await importLocalDataWithMockedRm(async (targetPath, options) => {
        if (String(targetPath) === resolveExpectedDeletionPath(paths.artifactsDir)) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }

        await actualFsPromises.rm(targetPath, options);
      });

    await expect(deleteLocalDataWithMock({ baseDir })).rejects.toMatchObject({
      message:
        "Local data deletion completed with some failures. Review failed_paths and retry after following the recovery guidance.",
      details: {
        deleted_paths: expect.arrayContaining([
          resolveExpectedDeletionPath(paths.dbPath),
          resolveExpectedDeletionPath(`${paths.dbPath}-journal`),
          resolveExpectedDeletionPath(`${paths.dbPath}-wal`),
          resolveExpectedDeletionPath(`${paths.dbPath}-shm`),
          resolveExpectedDeletionPath(keepAliveDir),
          resolveExpectedDeletionPath(rateLimitStatePath)
        ]),
        failed_paths: [
          {
            path: resolveExpectedDeletionPath(paths.artifactsDir),
            code: "EACCES",
            message: "permission denied",
            recoveryHint: "Check filesystem permissions for this path and retry."
          }
        ]
      }
    });

    expect(await pathExists(paths.dbPath)).toBe(false);
    expect(await pathExists(`${paths.dbPath}-journal`)).toBe(false);
    expect(await pathExists(`${paths.dbPath}-wal`)).toBe(false);
    expect(await pathExists(`${paths.dbPath}-shm`)).toBe(false);
    expect(await pathExists(keepAliveDir)).toBe(false);
    expect(await pathExists(rateLimitStatePath)).toBe(false);
    expect(await pathExists(paths.artifactsDir)).toBe(true);
    expect(await pathExists(configFilePath)).toBe(true);
    expect(await pathExists(paths.profilesDir)).toBe(true);
  });

  it("treats concurrently removed targets as missing instead of failing", async () => {
    const paths = await seedLocalDataFixture();
    const actualFsPromises = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises"
    );
    const { deleteLocalData: deleteLocalDataWithMock } =
      await importLocalDataWithMockedRm(async (targetPath, options) => {
        if (String(targetPath) === resolveExpectedDeletionPath(paths.artifactsDir)) {
          await actualFsPromises.rm(targetPath, options);
          throw Object.assign(new Error("no such file or directory"), {
            code: "ENOENT"
          });
        }

        await actualFsPromises.rm(targetPath, options);
      });

    const result = await deleteLocalDataWithMock({ baseDir });

    expect(result.missingPaths).toContain(
      resolveExpectedDeletionPath(paths.artifactsDir)
    );
    expect(result.failedPaths).toEqual([]);
    expect(result.startedAt <= result.completedAt).toBe(true);
    expect(await pathExists(paths.artifactsDir)).toBe(false);
    expect(await pathExists(configFilePath)).toBe(true);
  });
});
