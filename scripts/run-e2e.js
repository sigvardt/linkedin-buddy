#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/**
 * Default CDP endpoint probed by the E2E runner when `LINKEDIN_CDP_URL` is
 * unset.
 */
export const DEFAULT_CDP_URL = "http://localhost:18800";
const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const RUNNER_PREFIX = "[linkedin:e2e]";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntrypoint = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");

function log(message) {
  process.stdout.write(`${RUNNER_PREFIX} ${message}\n`);
}

function logError(message) {
  process.stderr.write(`${RUNNER_PREFIX} ${message}\n`);
}

/**
 * Converts unknown errors into a stable single-line message for runner logs.
 */
export function summarizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function readTrimmedEnv(name, env = process.env) {
  const value = env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnabledFlag(name, env = process.env) {
  const value = readTrimmedEnv(name, env);
  return value === "1" || value === "true";
}

function parseFixtureFlag(argument) {
  const prefix = "--fixtures=";
  if (!argument.startsWith(prefix)) {
    return undefined;
  }

  const value = argument.slice(prefix.length).trim();
  if (value.length === 0) {
    throw new Error("--fixtures requires a non-empty file path.");
  }

  return value;
}

/**
 * Parses runner-specific flags while preserving any remaining arguments for
 * direct Vitest forwarding.
 */
export function parseRunnerOptions(argv, env = process.env) {
  let showHelp = false;
  let requireSession = readEnabledFlag("LINKEDIN_E2E_REQUIRE_SESSION", env);
  let refreshFixtures = readEnabledFlag("LINKEDIN_E2E_REFRESH_FIXTURES", env);
  let fixtureFile = readTrimmedEnv("LINKEDIN_E2E_FIXTURE_FILE", env);
  const vitestArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      showHelp = true;
      continue;
    }

    if (argument === "--require-session") {
      requireSession = true;
      continue;
    }

    if (argument === "--refresh-fixtures") {
      refreshFixtures = true;
      continue;
    }

    const inlineFixtureFile = parseFixtureFlag(argument);
    if (inlineFixtureFile) {
      fixtureFile = inlineFixtureFile;
      continue;
    }

    if (argument === "--fixtures") {
      const nextArgument = argv[index + 1];
      const resolvedPath =
        typeof nextArgument === "string" ? nextArgument.trim() : "";
      if (resolvedPath.length === 0) {
        throw new Error("--fixtures requires a file path argument.");
      }

      fixtureFile = resolvedPath;
      index += 1;
      continue;
    }

    vitestArgs.push(argument);
  }

  return {
    showHelp,
    requireSession,
    refreshFixtures,
    fixtureFile,
    vitestArgs
  };
}

function getEnabledOptInLabels(env = process.env) {
  const labels = [];

  if (readEnabledFlag("LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM", env)) {
    labels.push("message");
  }
  if (readEnabledFlag("LINKEDIN_E2E_ENABLE_CONNECTION_CONFIRM", env)) {
    labels.push("connections");
  }
  if (readEnabledFlag("LINKEDIN_E2E_ENABLE_LIKE_CONFIRM", env)) {
    labels.push("like");
  }
  if (readEnabledFlag("LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM", env)) {
    labels.push("comment");
  }
  if (readEnabledFlag("LINKEDIN_ENABLE_POST_WRITE_E2E", env)) {
    labels.push("post");
  }

  return labels;
}

/**
 * Formats the effective runner configuration summary shown before each E2E run.
 */
export function formatRunnerConfiguration(options, env = process.env) {
  const profileName = readTrimmedEnv("LINKEDIN_E2E_PROFILE", env) ?? "default";
  const cdpUrl = readTrimmedEnv("LINKEDIN_CDP_URL", env) ?? DEFAULT_CDP_URL;
  const fixtureFile =
    options.fixtureFile === undefined
      ? "live discovery"
      : path.resolve(projectRoot, options.fixtureFile);
  const enabledWrites = getEnabledOptInLabels(env);

  return [
    `CDP endpoint: ${cdpUrl}`,
    `Profile: ${profileName}`,
    `Session policy: ${options.requireSession ? "required" : "skip when unavailable"}`,
    options.fixtureFile === undefined
      ? `Coverage fixtures: ${fixtureFile}`
      : `Coverage fixtures: ${fixtureFile}${
          options.refreshFixtures ? " (refresh enabled)" : ""
        }`,
    `Opt-in confirms: ${enabledWrites.length > 0 ? enabledWrites.join(", ") : "none"}`,
    ...(options.vitestArgs.length > 0
      ? [`Vitest args: ${options.vitestArgs.join(" ")}`]
      : [])
  ];
}

/**
 * Returns the human-readable `npm run test:e2e -- --help` text.
 */
export function getRunnerHelpText() {
  return [
    "LinkedIn real-session E2E runner",
    "",
    "Usage:",
    "  npm run test:e2e -- [runner options] [vitest args]",
    "",
    "Runner options:",
    "  --help                 Show this help text.",
    "  --require-session      Fail instead of skipping when CDP/auth is unavailable.",
    "  --fixtures <file>      Read or record CLI/MCP coverage fixtures at <file>.",
    "  --refresh-fixtures     Re-discover fixtures and overwrite the fixture file.",
    "",
    "Safe defaults:",
    "  Default runs stay read-only, preview-only, or use test.echo confirms.",
    "  Real outbound confirms stay opt-in behind dedicated environment flags.",
    "",
    "Vitest examples:",
    "  npm run test:e2e -- packages/core/src/__tests__/e2e/cli.e2e.test.ts",
    "  npm run test:e2e -- --reporter=verbose packages/core/src/__tests__/e2e/error-paths.e2e.test.ts",
    "",
    "Fixture replay examples:",
    "  npm run test:e2e -- --fixtures .tmp/e2e-fixtures.json packages/core/src/__tests__/e2e/cli.e2e.test.ts",
    "  npm run test:e2e -- --fixtures .tmp/e2e-fixtures.json --refresh-fixtures packages/core/src/__tests__/e2e/mcp.e2e.test.ts",
    "",
    "Environment overrides:",
    "  LINKEDIN_CDP_URL              CDP endpoint to probe (default: http://localhost:18800)",
    "  LINKEDIN_E2E_PROFILE          Logical profile name used by the E2E helpers",
    "  LINKEDIN_E2E_REQUIRE_SESSION  Same as --require-session when set to 1/true",
    "  LINKEDIN_E2E_FIXTURE_FILE     Same as --fixtures <file>",
    "  LINKEDIN_E2E_REFRESH_FIXTURES Same as --refresh-fixtures when set to 1/true",
    "  LINKEDIN_E2E_JOB_QUERY        Job query used for live fixture discovery",
    "  LINKEDIN_E2E_JOB_LOCATION     Job location used for live fixture discovery",
    "  LINKEDIN_E2E_MESSAGE_TARGET_PATTERN  Regex source for approved inbox-thread discovery",
    "  LINKEDIN_E2E_CONNECTION_TARGET       Connection target slug (default: realsimonmiller)",
    "",
    "Opt-in write confirms:",
    "  LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM     Enable the real message confirm test",
    "  LINKEDIN_E2E_ENABLE_CONNECTION_CONFIRM  Enable one real connection confirm test",
    "  LINKEDIN_E2E_CONNECTION_CONFIRM_MODE    invite | accept | withdraw",
    "  LINKEDIN_E2E_ENABLE_LIKE_CONFIRM        Enable the real like confirm test",
    "  LINKEDIN_E2E_LIKE_POST_URL              Approved post URL for like confirm",
    "  LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM     Enable the real comment confirm test",
    "  LINKEDIN_E2E_COMMENT_POST_URL           Approved post URL for comment confirm",
    "  LINKEDIN_ENABLE_POST_WRITE_E2E          Enable real post publishing after approval",
    "",
    "Docs:",
    "  docs/e2e-testing.md"
  ].join("\n");
}

/**
 * Formats the guidance shown when CDP or LinkedIn authentication is
 * unavailable.
 */
export function formatUnavailableGuidance(reason, options) {
  return [
    `${options.requireSession ? "LinkedIn E2E prerequisites are required but unavailable" : "Skipping LinkedIn E2E suite"}: ${reason}`,
    options.requireSession
      ? "Fix the session prerequisites above and rerun the same command."
      : "Pass --require-session (or set LINKEDIN_E2E_REQUIRE_SESSION=1) to fail instead of skip.",
    "See docs/e2e-testing.md for setup, safe targets, and fixture replay guidance."
  ];
}

function formatVitestFailure(exitCode) {
  return `E2E suite failed with exit code ${exitCode}. Re-run with npm run test:e2e:raw -- <args> if you want direct Vitest output without the availability checks.`;
}

async function detectAuthenticatedSession(cdpUrl) {
  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    if (!response.ok) {
      return {
        ok: false,
        reason: `CDP endpoint responded with HTTP ${response.status}.`
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `CDP endpoint is unavailable at ${cdpUrl}: ${summarizeError(error)}`
    };
  }

  try {
    const browser = await chromium.connectOverCDP(cdpUrl);

    try {
      const context = browser.contexts()[0];
      if (!context) {
        return {
          ok: false,
          reason: "Connected browser has no contexts to inspect."
        };
      }

      const page = await context.newPage();
      try {
        await page.goto(LINKEDIN_FEED_URL, {
          waitUntil: "domcontentloaded",
          timeout: 15_000
        });

        const currentUrl = page.url();
        const authenticated =
          currentUrl.includes("linkedin.com") &&
          !currentUrl.includes("/login") &&
          !currentUrl.includes("/checkpoint");

        if (!authenticated) {
          return {
            ok: false,
            reason: `LinkedIn session is not authenticated (landed on ${currentUrl}).`
          };
        }

        return {
          ok: true,
          reason: `Authenticated LinkedIn session detected at ${currentUrl}.`
        };
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      ok: false,
      reason: `Could not verify LinkedIn authentication over CDP: ${summarizeError(error)}`
    };
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on("exit", (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? 1,
        signal: signal ?? null
      });
    });
    child.on("error", reject);
  });
}

/**
 * Runs the E2E preflight checks and, when available, launches the Vitest E2E
 * suite with the resolved runner configuration.
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseRunnerOptions(argv, env);

  if (options.showHelp) {
    process.stdout.write(`${getRunnerHelpText()}\n`);
    return 0;
  }

  const cdpUrl = readTrimmedEnv("LINKEDIN_CDP_URL", env) ?? DEFAULT_CDP_URL;
  log("Checking LinkedIn session prerequisites.");
  for (const line of formatRunnerConfiguration(options, {
    ...env,
    LINKEDIN_CDP_URL: cdpUrl
  })) {
    log(line);
  }

  const availability = await detectAuthenticatedSession(cdpUrl);

  if (!availability.ok) {
    for (const line of formatUnavailableGuidance(availability.reason, options)) {
      if (options.requireSession) {
        logError(line);
      } else {
        log(line);
      }
    }
    return options.requireSession ? 1 : 0;
  }

  log(availability.reason);
  log("Running Vitest E2E suite.");

  const child = spawn(
    process.execPath,
    [vitestEntrypoint, "run", "-c", "vitest.config.e2e.ts", ...options.vitestArgs],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...env,
        LINKEDIN_E2E: env.LINKEDIN_E2E ?? "1",
        LINKEDIN_CDP_URL: cdpUrl,
        ...(options.fixtureFile
          ? {
              LINKEDIN_E2E_FIXTURE_FILE: options.fixtureFile
            }
          : {}),
        ...(options.refreshFixtures
          ? {
              LINKEDIN_E2E_REFRESH_FIXTURES: "1"
            }
          : {})
      }
    }
  );

  let result;
  try {
    result = await waitForExit(child);
  } catch (error) {
    logError(`Failed to start Vitest: ${summarizeError(error)}`);
    return 1;
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 1;
  }

  if (result.exitCode === 0) {
    log("E2E suite passed.");
    return 0;
  }

  logError(formatVitestFailure(result.exitCode));
  return result.exitCode;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  void main().then(
    (exitCode) => {
      process.exit(exitCode);
    },
    (error) => {
      logError(summarizeError(error));
      process.exit(1);
    }
  );
}
