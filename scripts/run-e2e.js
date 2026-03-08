#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

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
    "",
    "Docs:",
    "  docs/e2e-testing.md"
  ].join("\n");
}

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
