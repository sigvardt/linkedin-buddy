import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPaths, resolveKeepAliveDir } from "../../core/src/index.js";

const readlineMocks = vi.hoisted(() => ({
  close: vi.fn(),
  createInterface: vi.fn(),
  question: vi.fn()
}));

vi.mock("@linkedin-assistant/core", async () => await import("../../core/src/index.js"));

vi.mock("node:readline/promises", () => ({
  createInterface: readlineMocks.createInterface.mockImplementation(() => ({
    close: readlineMocks.close,
    question: readlineMocks.question
  }))
}));

import { runCli } from "../src/bin/linkedin.js";

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

function setInteractiveMode(inputIsTty: boolean, outputIsTty: boolean): void {
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: inputIsTty
  });
  Object.defineProperty(stdout, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
}

describe("linkedin data delete", () => {
  let tempDir = "";
  let assistantHome = "";
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-data-delete-"));
    assistantHome = path.join(tempDir, "assistant-home");
    process.env.LINKEDIN_ASSISTANT_HOME = assistantHome;
    setInteractiveMode(true, true);
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    delete process.env.LINKEDIN_ASSISTANT_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedLocalDataFixture(): Promise<{
    artifactsDir: string;
    configFilePath: string;
    dbPath: string;
    keepAliveDir: string;
    profilesDir: string;
    rateLimitStatePath: string;
  }> {
    const paths = resolveConfigPaths();
    const keepAliveDir = resolveKeepAliveDir();
    const rateLimitStatePath = path.join(paths.baseDir, "rate-limit-state.json");
    const configFilePath = path.join(paths.baseDir, "config.json");

    await mkdir(path.dirname(paths.dbPath), { recursive: true });
    await writeFile(paths.dbPath, "sqlite-data", "utf8");
    await writeFile(`${paths.dbPath}-journal`, "sqlite-journal", "utf8");
    await writeFile(`${paths.dbPath}-wal`, "sqlite-wal", "utf8");
    await writeFile(`${paths.dbPath}-shm`, "sqlite-shm", "utf8");
    await mkdir(path.join(paths.artifactsDir, "run-1"), { recursive: true });
    await writeFile(
      path.join(paths.artifactsDir, "run-1", "events.jsonl"),
      "{\"event\":\"runtime.started\"}\n",
      "utf8"
    );
    await mkdir(keepAliveDir, { recursive: true });
    await writeFile(path.join(keepAliveDir, "default.pid"), "0\n", "utf8");
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

    return {
      artifactsDir: paths.artifactsDir,
      configFilePath,
      dbPath: paths.dbPath,
      keepAliveDir,
      profilesDir: paths.profilesDir,
      rateLimitStatePath
    };
  }

  it("refuses to run in non-interactive mode", async () => {
    setInteractiveMode(false, false);

    await expect(
      runCli(["node", "linkedin", "data", "delete"])
    ).rejects.toMatchObject({
      message: "Refusing to delete local data in non-interactive mode."
    });

    expect(readlineMocks.createInterface).not.toHaveBeenCalled();
    expect(await pathExists(assistantHome)).toBe(false);
  });

  it("deletes local state while preserving browser profiles by default", async () => {
    const fixture = await seedLocalDataFixture();
    readlineMocks.question.mockResolvedValueOnce("yes");

    await runCli(["node", "linkedin", "data", "delete"]);

    expect(readlineMocks.question).toHaveBeenCalledTimes(1);
    expect(await pathExists(fixture.dbPath)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-journal`)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-wal`)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-shm`)).toBe(false);
    expect(await pathExists(fixture.artifactsDir)).toBe(false);
    expect(await pathExists(fixture.keepAliveDir)).toBe(false);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(false);
    expect(await pathExists(fixture.profilesDir)).toBe(true);
    expect(await pathExists(fixture.configFilePath)).toBe(true);

    const finalOutput = consoleLogSpy.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(finalOutput))).toMatchObject({
      deleted: true,
      include_profile_requested: false,
      include_profile_deleted: false
    });
  });

  it("deletes browser profiles only after the extra confirmation", async () => {
    const fixture = await seedLocalDataFixture();
    readlineMocks.question
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("yes");

    await runCli(["node", "linkedin", "data", "delete", "--include-profile"]);

    expect(readlineMocks.question).toHaveBeenCalledTimes(2);
    expect(await pathExists(fixture.dbPath)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-journal`)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-wal`)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-shm`)).toBe(false);
    expect(await pathExists(fixture.artifactsDir)).toBe(false);
    expect(await pathExists(fixture.keepAliveDir)).toBe(false);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(false);
    expect(await pathExists(fixture.profilesDir)).toBe(false);
    expect(await pathExists(fixture.configFilePath)).toBe(true);

    const finalOutput = consoleLogSpy.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(finalOutput))).toMatchObject({
      deleted: true,
      include_profile_requested: true,
      include_profile_deleted: true
    });
  });

  it("refuses to run with --cdp-url", async () => {
    await expect(
      runCli([
        "node",
        "linkedin",
        "--cdp-url",
        "ws://127.0.0.1:9222/devtools/browser/test",
        "data",
        "delete"
      ])
    ).rejects.toMatchObject({
      message:
        "The data delete command only deletes tool-owned local filesystem state and does not support --cdp-url."
    });

    expect(readlineMocks.createInterface).not.toHaveBeenCalled();
    expect(await pathExists(assistantHome)).toBe(false);
  });

  it("refuses to run while a keepalive daemon is active", async () => {
    const fixture = await seedLocalDataFixture();
    await writeFile(
      path.join(fixture.keepAliveDir, "default.pid"),
      `${process.pid}\n`,
      "utf8"
    );

    await expect(
      runCli(["node", "linkedin", "data", "delete"])
    ).rejects.toMatchObject({
      message: "Stop running keepalive daemons before deleting local data."
    });

    expect(readlineMocks.createInterface).not.toHaveBeenCalled();
    expect(await pathExists(fixture.dbPath)).toBe(true);
    expect(await pathExists(fixture.keepAliveDir)).toBe(true);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(true);
  });
});
