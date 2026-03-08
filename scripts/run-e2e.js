#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const DEFAULT_CDP_URL = "http://localhost:18800";
const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntrypoint = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function summarizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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

async function main() {
  const cdpUrl = process.env.LINKEDIN_CDP_URL ?? DEFAULT_CDP_URL;
  const availability = await detectAuthenticatedSession(cdpUrl);

  if (!availability.ok) {
    log(`[e2e] Skipping LinkedIn E2E suite: ${availability.reason}`);
    process.exit(0);
  }

  log(`[e2e] ${availability.reason}`);
  log("[e2e] Running Vitest E2E suite.");

  const child = spawn(
    process.execPath,
    [vitestEntrypoint, "run", "-c", "vitest.config.e2e.ts"],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        LINKEDIN_E2E: process.env.LINKEDIN_E2E ?? "1",
        LINKEDIN_CDP_URL: cdpUrl
      }
    }
  );

  let result;
  try {
    result = await waitForExit(child);
  } catch (error) {
    log(`[e2e] Failed to start Vitest: ${summarizeError(error)}`);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }

  process.exit(result.exitCode);
}

void main();
