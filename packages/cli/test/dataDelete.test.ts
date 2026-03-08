import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPaths } from "../../core/src/index.js";

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
    dbPath: string;
    keepAliveDir: string;
    profilesDir: string;
    rateLimitStatePath: string;
  }> {
    const paths = resolveConfigPaths();
    const keepAliveDir = path.join(paths.baseDir, "keepalive");
    const rateLimitStatePath = path.join(paths.baseDir, "rate-limit-state.json");

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

    return {
      artifactsDir: paths.artifactsDir,
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
    expect(await pathExists(fixture.artifactsDir)).toBe(false);
    expect(await pathExists(fixture.keepAliveDir)).toBe(false);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(false);
    expect(await pathExists(fixture.profilesDir)).toBe(true);

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
    expect(await pathExists(fixture.artifactsDir)).toBe(false);
    expect(await pathExists(fixture.keepAliveDir)).toBe(false);
    expect(await pathExists(fixture.rateLimitStatePath)).toBe(false);
    expect(await pathExists(fixture.profilesDir)).toBe(false);

    const finalOutput = consoleLogSpy.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(finalOutput))).toMatchObject({
      deleted: true,
      include_profile_requested: true,
      include_profile_deleted: true
    });
  });
});
