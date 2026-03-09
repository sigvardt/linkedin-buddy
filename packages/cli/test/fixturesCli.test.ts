import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import type { LinkedInReplayPageType } from "@linkedin-assistant/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@linkedin-assistant/core", async () =>
  await import("../../core/src/index.js")
);

import { runCli } from "../src/bin/linkedin.js";

interface ReplayManifestPageEntry {
  htmlPath: string;
  pageType: LinkedInReplayPageType;
  recordedAt: string;
  title?: string;
  url: string;
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
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
}

async function writeJsonFixture(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createReplayManifest(
  recordedAt: string,
  setName: string = "ci",
  pages: Partial<Record<LinkedInReplayPageType, ReplayManifestPageEntry>> = {
    feed: {
      pageType: "feed",
      url: "https://www.linkedin.com/feed/",
      htmlPath: "pages/app.html",
      recordedAt,
      title: "Feed"
    }
  }
): Record<string, unknown> {
  return {
    format: 1,
    updatedAt: recordedAt,
    defaultSetName: setName,
    sets: {
      [setName]: {
        setName,
        rootDir: setName,
        locale: "en-US",
        capturedAt: recordedAt,
        viewport: {
          width: 1440,
          height: 900
        },
        routesPath: "routes.json",
        pages
      }
    }
  };
}

describe("linkedin fixtures commands", () => {
  let tempDir = "";
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-fixtures-"));
    process.exitCode = undefined;
    setInteractiveMode(false, false);
    vi.clearAllMocks();
    stderrChunks = [];
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
    await rm(tempDir, { recursive: true, force: true });
  });

  function getLastJsonOutput(): Record<string, unknown> {
    return JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "")) as Record<string, unknown>;
  }

  it("warns when replay fixtures are stale", async () => {
    const manifestPath = path.join(tempDir, "manifest.json");
    await writeJsonFixture(manifestPath, createReplayManifest("2025-01-01T00:00:00.000Z"));

    await runCli([
      "node",
      "linkedin",
      "fixtures",
      "check",
      "--manifest",
      manifestPath
    ]);

    expect(getLastJsonOutput()).toMatchObject({
      manifest_path: path.resolve(manifestPath),
      stale: true,
      warning_count: 1,
      set_name: null
    });
    expect(stderrChunks.join("\n")).toContain("Fixture page ci/feed was recorded");
  });

  it("warns when a stale fixture set has no captured page entries", async () => {
    const manifestPath = path.join(tempDir, "manifest.json");
    await writeJsonFixture(
      manifestPath,
      createReplayManifest("2025-01-01T00:00:00.000Z", "manual", {})
    );

    await runCli([
      "node",
      "linkedin",
      "fixtures",
      "check",
      "--manifest",
      manifestPath,
      "--set",
      "manual"
    ]);

    expect(getLastJsonOutput()).toMatchObject({
      manifest_path: path.resolve(manifestPath),
      stale: true,
      warning_count: 1,
      set_name: "manual"
    });
    expect(stderrChunks.join("\n")).toContain("Fixture set manual was captured");
  });

  it("supports the fixtures:check alias and scoped set validation", async () => {
    const manifestPath = path.join(tempDir, "manifest.json");
    await writeJsonFixture(manifestPath, createReplayManifest("2026-03-08T00:00:00.000Z", "manual"));

    await runCli([
      "node",
      "linkedin",
      "fixtures:check",
      "--manifest",
      manifestPath,
      "--set",
      "manual",
      "--max-age-days",
      "30"
    ]);

    expect(getLastJsonOutput()).toMatchObject({
      manifest_path: path.resolve(manifestPath),
      stale: false,
      warning_count: 0,
      set_name: "manual"
    });
  });

  it("fails fast when fixtures check targets an unknown set", async () => {
    const manifestPath = path.join(tempDir, "manifest.json");
    await writeJsonFixture(manifestPath, createReplayManifest("2026-03-08T00:00:00.000Z", "manual"));

    await expect(
      runCli([
        "node",
        "linkedin",
        "fixtures",
        "check",
        "--manifest",
        manifestPath,
        "--set",
        "missing"
      ])
    ).rejects.toThrow(
      `Fixture set missing is not defined in ${path.resolve(manifestPath)}. Available fixture sets: manual.`
    );
  });

  it("rejects non-numeric --max-age-days values", async () => {
    await expect(
      runCli([
        "node",
        "linkedin",
        "fixtures",
        "check",
        "--max-age-days",
        "30days"
      ])
    ).rejects.toThrow("max-age-days must be a positive integer.");
  });

  it("requires an interactive terminal for fixture recording", async () => {
    await expect(
      runCli([
        "node",
        "linkedin",
        "fixtures",
        "record"
      ])
    ).rejects.toThrow("fixtures:record requires an interactive terminal");
  });
});
