import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readlineMocks = vi.hoisted(() => ({
  close: vi.fn(),
  createInterface: vi.fn(),
  question: vi.fn()
}));

vi.mock("@linkedin-buddy/core", async () =>
  await import("../../core/src/index.js")
);

vi.mock("node:readline/promises", () => ({
  createInterface: readlineMocks.createInterface.mockImplementation(() => ({
    close: readlineMocks.close,
    question: readlineMocks.question
  }))
}));

import * as core from "@linkedin-buddy/core";
import { createCliProgram, runCli } from "../src/bin/linkedin.js";

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
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-data-delete-"));
    assistantHome = path.join(tempDir, "assistant-home");
    process.env.LINKEDIN_BUDDY_HOME = assistantHome;
    setInteractiveMode(true, true);
    vi.clearAllMocks();
    readlineMocks.createInterface.mockImplementation(() => ({
      close: readlineMocks.close,
      question: readlineMocks.question
    }));
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.LINKEDIN_BUDDY_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  function getLastJsonOutput(): Record<string, unknown> {
    const finalOutput = consoleLogSpy.mock.calls.at(-1)?.[0];
    return JSON.parse(String(finalOutput)) as Record<string, unknown>;
  }

  async function seedLocalDataFixture(): Promise<{
    artifactsDir: string;
    configFilePath: string;
    dbPath: string;
    keepAliveDir: string;
    profilesDir: string;
    rateLimitStatePath: string;
  }> {
    const paths = core.resolveConfigPaths();
    const keepAliveDir = core.resolveKeepAliveDir();
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

  it("shows a dry-run preview by default without deleting anything", async () => {
    const fixture = await seedLocalDataFixture();
    setInteractiveMode(false, false);

    await runCli(["node", "linkedin", "data", "delete"]);

    expect(readlineMocks.createInterface).not.toHaveBeenCalled();
    expect(await pathExists(fixture.dbPath)).toBe(true);
    expect(await pathExists(`${fixture.dbPath}-journal`)).toBe(true);
    expect(await pathExists(`${fixture.dbPath}-wal`)).toBe(true);
    expect(await pathExists(`${fixture.dbPath}-shm`)).toBe(true);
    expect(await pathExists(fixture.artifactsDir)).toBe(true);
    expect(await pathExists(fixture.keepAliveDir)).toBe(true);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(true);
    expect(await pathExists(fixture.profilesDir)).toBe(true);
    expect(await pathExists(fixture.configFilePath)).toBe(true);

    const finalOutput = getLastJsonOutput();
    expect(finalOutput).toMatchObject({
      confirm_required: true,
      dry_run: true,
      include_profile_requested: false,
      nothing_to_delete: false
    });
    expect(finalOutput.existing_paths).toEqual(
      expect.arrayContaining([
        expect.stringContaining(path.join("assistant-home", "state.sqlite")),
        expect.stringContaining(path.join("assistant-home", "state.sqlite-journal")),
        expect.stringContaining(path.join("assistant-home", "state.sqlite-wal")),
        expect.stringContaining(path.join("assistant-home", "state.sqlite-shm")),
        expect.stringContaining(path.join("assistant-home", "artifacts")),
        expect.stringContaining(path.join("assistant-home", "keepalive")),
        expect.stringContaining(path.join("assistant-home", "rate-limit-state.json"))
      ])
    );
    expect(finalOutput.preserved_paths).toEqual(
      expect.arrayContaining([
        expect.stringContaining(path.join("assistant-home", "profiles")),
        expect.stringContaining(path.join("assistant-home", "config.json"))
      ])
    );
    expect(
      consoleLogSpy.mock.calls.some(([message]) =>
        String(message).includes("Rerun with --confirm")
      )
    ).toBe(true);
  });

  it("refuses destructive deletion in non-interactive mode", async () => {
    await seedLocalDataFixture();
    setInteractiveMode(false, false);

    await expect(
      runCli(["node", "linkedin", "data", "delete", "--confirm"])
    ).rejects.toMatchObject({
      message: "Refusing to delete local data with --confirm in non-interactive mode."
    });

    expect(readlineMocks.createInterface).not.toHaveBeenCalled();
  });

  it("deletes local state while preserving browser profiles by default", async () => {
    const fixture = await seedLocalDataFixture();
    readlineMocks.question.mockResolvedValueOnce("yes");

    await runCli(["node", "linkedin", "data", "delete", "--confirm"]);

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

    expect(getLastJsonOutput()).toMatchObject({
      deleted: true,
      dry_run: false,
      failed_paths: [],
      include_profile_deleted: false,
      include_profile_requested: false,
      started_at: expect.any(String),
      completed_at: expect.any(String)
    });
  });

  it("deletes browser profiles only after the extra confirmation", async () => {
    const fixture = await seedLocalDataFixture();
    readlineMocks.question
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("yes");

    await runCli([
      "node",
      "linkedin",
      "data",
      "delete",
      "--include-profile",
      "--confirm"
    ]);

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

    expect(getLastJsonOutput()).toMatchObject({
      deleted: true,
      include_profile_requested: true,
      include_profile_deleted: true
    });
  });

  it("cancels without deleting anything when the operator declines confirmation", async () => {
    const fixture = await seedLocalDataFixture();
    readlineMocks.question.mockResolvedValueOnce("no");

    await runCli(["node", "linkedin", "data", "delete", "--confirm"]);

    expect(readlineMocks.question).toHaveBeenCalledTimes(1);
    expect(await pathExists(fixture.dbPath)).toBe(true);
    expect(await pathExists(`${fixture.dbPath}-journal`)).toBe(true);
    expect(await pathExists(`${fixture.dbPath}-wal`)).toBe(true);
    expect(await pathExists(`${fixture.dbPath}-shm`)).toBe(true);
    expect(await pathExists(fixture.artifactsDir)).toBe(true);
    expect(await pathExists(fixture.keepAliveDir)).toBe(true);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(true);
    expect(await pathExists(fixture.profilesDir)).toBe(true);
    expect(await pathExists(fixture.configFilePath)).toBe(true);

    expect(getLastJsonOutput()).toMatchObject({
      cancelled: true,
      deleted: false,
      dry_run: false,
      include_profile_deleted: false,
      include_profile_requested: false
    });
  });

  it("preserves profiles when the extra profile confirmation is declined", async () => {
    const fixture = await seedLocalDataFixture();
    readlineMocks.question
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("no");

    await runCli([
      "node",
      "linkedin",
      "data",
      "delete",
      "--include-profile",
      "--confirm"
    ]);

    expect(readlineMocks.question).toHaveBeenCalledTimes(2);
    expect(await pathExists(fixture.dbPath)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-journal`)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-wal`)).toBe(false);
    expect(await pathExists(`${fixture.dbPath}-shm`)).toBe(false);
    expect(await pathExists(fixture.artifactsDir)).toBe(false);
    expect(await pathExists(fixture.keepAliveDir)).toBe(false);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(false);
    expect(await pathExists(fixture.profilesDir)).toBe(true);
    expect(await pathExists(fixture.configFilePath)).toBe(true);
    expect(
      consoleLogSpy.mock.calls.some(([message]) =>
        String(message).includes("Browser profile deletion declined")
      )
    ).toBe(true);
    expect(getLastJsonOutput()).toMatchObject({
      deleted: true,
      include_profile_requested: true,
      include_profile_deleted: false
    });
  });

  it("shows a friendly nothing-to-delete preview when local state is absent", async () => {
    setInteractiveMode(false, false);

    await runCli(["node", "linkedin", "data", "delete"]);

    expect(readlineMocks.createInterface).not.toHaveBeenCalled();
    expect(await pathExists(assistantHome)).toBe(false);
    expect(
      consoleLogSpy.mock.calls.some(([message]) =>
        String(message).includes("Nothing to delete")
      )
    ).toBe(true);
    expect(getLastJsonOutput()).toMatchObject({
      confirm_required: true,
      dry_run: true,
      nothing_to_delete: true
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

  it("allows destructive deletion to proceed when keepalive pid files are stale", async () => {
    const fixture = await seedLocalDataFixture();
    await writeFile(
      path.join(fixture.keepAliveDir, "default.pid"),
      "999999\n",
      "utf8"
    );
    readlineMocks.question.mockResolvedValueOnce("yes");

    await runCli(["node", "linkedin", "data", "delete", "--confirm"]);

    expect(readlineMocks.question).toHaveBeenCalledTimes(1);
    expect(await pathExists(fixture.dbPath)).toBe(false);
    expect(await pathExists(fixture.keepAliveDir)).toBe(false);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(false);
    expect(await pathExists(fixture.profilesDir)).toBe(true);
    expect(await pathExists(fixture.configFilePath)).toBe(true);
  });

  it("refuses destructive deletion while a keepalive daemon is active", async () => {
    const fixture = await seedLocalDataFixture();
    await writeFile(
      path.join(fixture.keepAliveDir, "default.pid"),
      `${process.pid}\n`,
      "utf8"
    );

    await expect(
      runCli(["node", "linkedin", "data", "delete", "--confirm"])
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "Stop running keepalive daemons before deleting local data. Active PID"
      )
    });

    expect(readlineMocks.createInterface).not.toHaveBeenCalled();
    expect(await pathExists(fixture.dbPath)).toBe(true);
    expect(await pathExists(fixture.keepAliveDir)).toBe(true);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(true);
  });

  it("formats actionable partial-failure guidance when deletion fails", async () => {
    const fixture = await seedLocalDataFixture();
    readlineMocks.question.mockResolvedValueOnce("yes");
    const deleteSpy = vi.spyOn(core, "deleteLocalData").mockRejectedValueOnce(
      new core.LinkedInBuddyError(
        "UNKNOWN",
        "Local data deletion completed with some failures.",
        {
          deleted_paths: [fixture.artifactsDir],
          failed_paths: [
            {
              code: "EACCES",
              message: "permission denied",
              path: fixture.dbPath,
              recoveryHint: "Check filesystem permissions for this path and retry."
            }
          ],
          missing_paths: []
        }
      )
    );

    await expect(
      runCli(["node", "linkedin", "data", "delete", "--confirm"])
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "Check filesystem permissions for this path and retry."
      )
    });

    expect(
      consoleErrorSpy.mock.calls.some(([message]) =>
        String(message).includes("Local data deletion could not finish cleanly")
      )
    ).toBe(true);

    deleteSpy.mockRestore();
  });

  it("documents dry-run safety and recovery details in --help", () => {
    const program = createCliProgram();
    const dataCommand = program.commands.find((command) => command.name() === "data");
    const deleteCommand = dataCommand?.commands.find(
      (command) => command.name() === "delete"
    );

    expect(deleteCommand).toBeDefined();

    const help = deleteCommand?.helpInformation() ?? "";
    expect(help).toContain("--confirm");
    expect(help).toContain("Default behavior is a dry-run preview");
    expect(help).toContain("config.json is preserved by design");
    expect(help).toContain("Answering anything other than \"yes\" cancels safely");
    expect(help).toContain("failed_paths");
    expect(help).toContain("recovery guidance");
    expect(help).toContain("--cdp-url");
  });
});
