import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV,
  createCoreRuntime,
  resolveConfigPaths
} from "../src/index.js";

interface LoggedEvent {
  level: string;
  event: string;
  payload: Record<string, unknown>;
}

async function readRunEvents(baseDir: string, runId: string): Promise<LoggedEvent[]> {
  const eventsPath = path.join(resolveConfigPaths(baseDir).artifactsDir, runId, "events.jsonl");
  const contents = await readFile(eventsPath, "utf8");

  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedEvent);
}

describe("runtime selector locale logging", () => {
  let baseDir = "";
  let previousSelectorLocaleEnv: string | undefined;

  beforeEach(async () => {
    previousSelectorLocaleEnv = process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
    delete process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
    baseDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-runtime-selector-locale-"));
  });

  afterEach(async () => {
    if (typeof previousSelectorLocaleEnv === "string") {
      process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV] = previousSelectorLocaleEnv;
    } else {
      delete process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
    }

    await rm(baseDir, { recursive: true, force: true });
  });

  it("logs a warning when an explicit selector locale falls back to english", async () => {
    const runtime = createCoreRuntime({
      baseDir,
      dbPath: ":memory:",
      runId: "run-selector-locale-warning",
      selectorLocale: "fr-CA"
    });
    let closed = false;

    try {
      runtime.close();
      closed = true;

      const events = await readRunEvents(baseDir, "run-selector-locale-warning");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "warn",
            event: "runtime.selector_locale.fallback_to_english",
            payload: expect.objectContaining({
              selector_locale_source: "option",
              resolved_selector_locale: "en",
              reason: "unsupported_locale",
              normalized_selector_locale: "fr-ca",
              requested_selector_locale_length: 5
            })
          })
        ])
      );
    } finally {
      if (!closed) {
        runtime.close();
      }
    }
  });

  it("does not log a warning for supported selector locales", async () => {
    const runtime = createCoreRuntime({
      baseDir,
      dbPath: ":memory:",
      runId: "run-selector-locale-supported",
      selectorLocale: "da-DK"
    });
    let closed = false;

    try {
      runtime.close();
      closed = true;

      const events = await readRunEvents(baseDir, "run-selector-locale-supported");
      expect(
        events.some(
          (event) => event.event === "runtime.selector_locale.fallback_to_english"
        )
      ).toBe(false);
    } finally {
      if (!closed) {
        runtime.close();
      }
    }
  });

  it("logs env-based fallback warnings when the configured locale is invalid", async () => {
    process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV] = "fr-CA";

    const runtime = createCoreRuntime({
      baseDir,
      dbPath: ":memory:",
      runId: "run-selector-locale-env-warning"
    });
    let closed = false;

    try {
      runtime.close();
      closed = true;

      const events = await readRunEvents(baseDir, "run-selector-locale-env-warning");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "warn",
            event: "runtime.selector_locale.fallback_to_english",
            payload: expect.objectContaining({
              selector_locale_source: "env",
              resolved_selector_locale: "en",
              reason: "unsupported_locale",
              normalized_selector_locale: "fr-ca",
              requested_selector_locale_length: 5
            })
          })
        ])
      );
    } finally {
      if (!closed) {
        runtime.close();
      }
    }
  });
});
