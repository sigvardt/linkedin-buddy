import { mkdtemp, readFile, rm } from "node:fs/promises";
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

vi.mock("@linkedin-buddy/core", async () => {
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
  LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV
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
    previousSelectorLocaleEnv = process.env[LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV];
    delete process.env[LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV];
    process.env.LINKEDIN_BUDDY_HOME = path.join(tempDir, "buddy-home");
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
    delete process.env.LINKEDIN_BUDDY_HOME;
    if (typeof previousSelectorLocaleEnv === "string") {
      process.env[LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV] = previousSelectorLocaleEnv;
    } else {
      delete process.env[LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV];
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
    process.env[LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV] = "fr-CA";

    await runCli(["node", "linkedin", "keepalive", "start"]);

    const stderrOutput = stderrChunks.join("");

    expect(stderrOutput).toContain(
      `[linkedin] Warning: Unsupported selector locale "fr-ca" from ${LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV}.`
    );
    expect(stderrOutput).toContain(
      "override it for one command with --selector-locale <locale>."
    );
    expect(cliSelectorLocaleMocks.spawn).toHaveBeenCalledTimes(1);
    expect(cliSelectorLocaleMocks.createCoreRuntime).not.toHaveBeenCalled();
  });

  it("rejects invalid keepalive profile names before touching daemon state", async () => {
    await expect(
      runCli(["node", "linkedin", "keepalive", "status", "--profile", "../bad"])
    ).rejects.toThrow(
      "profile must not contain path separators or relative path segments."
    );

    expect(cliSelectorLocaleMocks.spawn).not.toHaveBeenCalled();
    expect(cliSelectorLocaleMocks.createCoreRuntime).not.toHaveBeenCalled();
  });

  it("allows zero jitter for the hidden keepalive daemon runner", async () => {
    cliSelectorLocaleMocks.createCoreRuntime.mockImplementation(() => ({
      runId: "run-selector-locale-cli",
      logger: { log: cliSelectorLocaleMocks.loggerLog },
      healthCheck: vi.fn(async () => {
        process.emit("SIGTERM");
        return {
          browser: {
            healthy: true,
            browserConnected: true,
            pageResponsive: true,
            checkedAt: "2026-03-09T00:00:00.000Z"
          },
          session: {
            authenticated: true,
            checkpointDetected: false,
            cookieExpiringSoon: false,
            currentUrl: "https://www.linkedin.com/feed/",
            loginWallDetected: false,
            nextCookieExpiryAt: null,
            rateLimited: false,
            reason: "LinkedIn session appears authenticated.",
            checkedAt: "2026-03-09T00:00:00.000Z",
            sessionCookieFingerprint: "selector-locale-keepalive-fingerprint",
            sessionCookiePresent: true,
            sessionCookies: []
          }
        };
      }),
      close: cliSelectorLocaleMocks.close
    }));

    await runCli([
      "node",
      "linkedin",
      "keepalive",
      "__run",
      "--profile",
      "default",
      "--interval-seconds",
      "1",
      "--jitter-seconds",
      "0",
      "--max-consecutive-failures",
      "5"
    ]);

    const statePath = path.join(
      tempDir,
      "buddy-home",
      "keepalive",
      "default.state.json"
    );
    const state = JSON.parse(
      await readFile(statePath, "utf8")
    ) as {
      jitterMs: number;
      status: string;
    };

    expect(state.jitterMs).toBe(0);
    expect(state.status).toBe("stopped");
    expect(cliSelectorLocaleMocks.close).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for supported locales", async () => {
    await runCli(["node", "linkedin", "--selector-locale", "da-DK", "status"]);

    expect(stderrChunks.join("")).toBe("");
  });
});
