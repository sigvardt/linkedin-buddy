import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliSelectorLocaleMocks = vi.hoisted(() => ({
  loggerLog: vi.fn(),
  authStatus: vi.fn(async () => ({ authenticated: true })),
  close: vi.fn(),
  createCoreRuntime: vi.fn(() => ({
    runId: "run-selector-locale-cli",
    logger: { log: cliSelectorLocaleMocks.loggerLog },
    auth: { status: cliSelectorLocaleMocks.authStatus },
    close: cliSelectorLocaleMocks.close
  })),
  spawn: vi.fn(() => ({
    pid: 12_345,
    unref: vi.fn()
  }))
}));

vi.mock("@linkedin-assistant/core", async () => {
  const actual = await import("../../core/src/index.js");
  return {
    ...actual,
    createCoreRuntime: cliSelectorLocaleMocks.createCoreRuntime
  };
});

vi.mock("node:child_process", () => ({
  spawn: cliSelectorLocaleMocks.spawn
}));

import {
  LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV
} from "../../core/src/index.js";
import { runCli } from "../src/bin/linkedin.js";

describe("CLI selector locale messaging", () => {
  let tempDir = "";
  let previousSelectorLocaleEnv: string | undefined;
  let stderrChunks: string[] = [];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-selector-locale-"));
    previousSelectorLocaleEnv = process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
    delete process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
    process.env.LINKEDIN_ASSISTANT_HOME = path.join(tempDir, "assistant-home");
    process.exitCode = undefined;
    stderrChunks = [];
    vi.clearAllMocks();
    cliSelectorLocaleMocks.authStatus.mockResolvedValue({ authenticated: true });
    cliSelectorLocaleMocks.createCoreRuntime.mockImplementation(() => ({
      runId: "run-selector-locale-cli",
      logger: { log: cliSelectorLocaleMocks.loggerLog },
      auth: { status: cliSelectorLocaleMocks.authStatus },
      close: cliSelectorLocaleMocks.close
    }));
    cliSelectorLocaleMocks.spawn.mockImplementation(() => ({
      pid: 12_345,
      unref: vi.fn()
    }));
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        const [chunk] = args;
        stderrChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = undefined;
    delete process.env.LINKEDIN_ASSISTANT_HOME;
    if (typeof previousSelectorLocaleEnv === "string") {
      process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV] = previousSelectorLocaleEnv;
    } else {
      delete process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("warns when --selector-locale falls back to English for runtime commands", async () => {
    await runCli(["node", "linkedin", "--selector-locale", "fr-CA", "status"]);

    const stderrOutput = stderrChunks.join("");

    expect(stderrOutput).toContain(
      '[linkedin] Warning: Unsupported selector locale "fr-ca" from --selector-locale.'
    );
    expect(stderrOutput).toContain(
      '[linkedin] Using English ("en") selector phrases for this run.'
    );
    expect(stderrOutput).toContain("Supported locales: en, da.");
    expect(cliSelectorLocaleMocks.createCoreRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        privacy: expect.any(Object),
        selectorLocale: "fr-CA"
      })
    );
  });

  it("warns before starting keepalive when env locale falls back to English", async () => {
    process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV] = "fr-CA";

    await runCli(["node", "linkedin", "keepalive", "start"]);

    const stderrOutput = stderrChunks.join("");

    expect(stderrOutput).toContain(
      `[linkedin] Warning: Unsupported selector locale "fr-ca" from ${LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV}.`
    );
    expect(stderrOutput).toContain(
      "override it for one command with --selector-locale <locale>."
    );
    expect(cliSelectorLocaleMocks.spawn).toHaveBeenCalledTimes(1);
    expect(cliSelectorLocaleMocks.createCoreRuntime).not.toHaveBeenCalled();
  });

  it("stays quiet for supported locales", async () => {
    await runCli(["node", "linkedin", "--selector-locale", "da-DK", "status"]);

    expect(stderrChunks.join("")).toBe("");
  });
});
