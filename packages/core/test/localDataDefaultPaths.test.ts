import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function importLocalDataModules(mockHomeDir: string): Promise<{
  config: typeof import("../src/config.js");
  localData: typeof import("../src/localData.js");
  rateLimitState: typeof import("../src/auth/rateLimitState.js");
}> {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");

    return {
      ...actual,
      default: {
        ...actual,
        homedir: () => mockHomeDir
      },
      homedir: () => mockHomeDir
    };
  });

  const [config, localData, rateLimitState] = await Promise.all([
    import("../src/config.js"),
    import("../src/localData.js"),
    import("../src/auth/rateLimitState.js")
  ]);

  return {
    config,
    localData,
    rateLimitState
  };
}

describe("local data deletion default paths", () => {
  let previousAssistantHome: string | undefined;
  let tempDir = "";
  let mockHomeDir = "";

  beforeEach(async () => {
    previousAssistantHome = process.env.LINKEDIN_ASSISTANT_HOME;
    delete process.env.LINKEDIN_ASSISTANT_HOME;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-local-defaults-"));
    mockHomeDir = path.join(tempDir, "mock-home");
    await mkdir(mockHomeDir, { recursive: true });
  });

  afterEach(async () => {
    vi.unmock("node:os");
    vi.resetModules();

    if (typeof previousAssistantHome === "string") {
      process.env.LINKEDIN_ASSISTANT_HOME = previousAssistantHome;
    } else {
      delete process.env.LINKEDIN_ASSISTANT_HOME;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("includes both current and legacy rate-limit files on the default paths", async () => {
    const { config, localData, rateLimitState } = await importLocalDataModules(
      mockHomeDir
    );

    const plan = localData.createLocalDataDeletionPlan();
    const currentRateLimitStatePath = rateLimitState.resolveRateLimitStateFilePath();
    const legacyRateLimitStatePath =
      rateLimitState.resolveLegacyRateLimitStateFilePath();

    expect(config.resolveConfigPaths().baseDir).toBe(
      path.join(mockHomeDir, ".linkedin-assistant", "linkedin-owa-agentools")
    );
    expect(plan.targets).toEqual(
      expect.arrayContaining([
        resolveExpectedDeletionPath(currentRateLimitStatePath),
        resolveExpectedDeletionPath(legacyRateLimitStatePath)
      ])
    );
    expect(currentRateLimitStatePath).not.toBe(legacyRateLimitStatePath);
  });

  it("removes both current and legacy rate-limit files while preserving config.json", async () => {
    const { config, localData, rateLimitState } = await importLocalDataModules(
      mockHomeDir
    );

    const paths = config.resolveConfigPaths();
    const currentRateLimitStatePath = rateLimitState.resolveRateLimitStateFilePath();
    const legacyRateLimitStatePath =
      rateLimitState.resolveLegacyRateLimitStateFilePath();
    const configFilePath = path.join(paths.baseDir, "config.json");

    await mkdir(path.dirname(currentRateLimitStatePath), { recursive: true });
    await writeFile(currentRateLimitStatePath, "{\"cooldown\":true}\n", "utf8");
    await mkdir(path.dirname(legacyRateLimitStatePath), { recursive: true });
    await writeFile(legacyRateLimitStatePath, "{\"legacy\":true}\n", "utf8");
    await writeFile(configFilePath, "{\"safe\":true}\n", "utf8");

    const result = await localData.deleteLocalData();

    expect(result.deletedPaths).toEqual(
      expect.arrayContaining([
        resolveExpectedDeletionPath(currentRateLimitStatePath),
        resolveExpectedDeletionPath(legacyRateLimitStatePath)
      ])
    );
    expect(result.failedPaths).toEqual([]);
    expect(await pathExists(currentRateLimitStatePath)).toBe(false);
    expect(await pathExists(legacyRateLimitStatePath)).toBe(false);
    expect(await pathExists(configFilePath)).toBe(true);
  });
});
