import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_E2E_CDP_URL,
  E2E_BASE_DIR_PREFIX,
  E2E_OWNER_METADATA_FILE,
  cleanupRuntime,
  getCdpUrl,
  getE2EAvailability,
  getE2EBaseDir,
  skipIfE2EUnavailable,
  withAssistantHome,
  withE2EEnvironment,
  type E2ESuite
} from "./e2e/setup.js";

const originalAssistantHome = process.env.LINKEDIN_BUDDY_HOME;
const originalCdpUrl = process.env.LINKEDIN_CDP_URL;
const originalReplayEnabled = process.env.LINKEDIN_E2E_REPLAY;
const originalFixtureManifest = process.env.LINKEDIN_E2E_FIXTURE_MANIFEST;
const originalFixtureSet = process.env.LINKEDIN_E2E_FIXTURE_SET;

function restoreOptionalEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  Reflect.set(process.env, key, value);
}

afterEach(() => {
  cleanupRuntime();
  vi.restoreAllMocks();

  restoreOptionalEnvVar("LINKEDIN_BUDDY_HOME", originalAssistantHome);
  restoreOptionalEnvVar("LINKEDIN_CDP_URL", originalCdpUrl);
  restoreOptionalEnvVar("LINKEDIN_E2E_REPLAY", originalReplayEnabled);
  restoreOptionalEnvVar("LINKEDIN_E2E_FIXTURE_MANIFEST", originalFixtureManifest);
  restoreOptionalEnvVar("LINKEDIN_E2E_FIXTURE_SET", originalFixtureSet);
});

describe("E2E setup helpers", () => {
  it("uses a stable assistant home inside E2E environment callbacks", async () => {
    process.env.LINKEDIN_BUDDY_HOME = "/tmp/original-linkedin-home";

    const baseDir = getE2EBaseDir();
    expect(existsSync(baseDir)).toBe(true);

    await withE2EEnvironment(async () => {
      expect(process.env.LINKEDIN_BUDDY_HOME).toBe(baseDir);
      expect(getE2EBaseDir()).toBe(baseDir);
    });

    expect(process.env.LINKEDIN_BUDDY_HOME).toBe("/tmp/original-linkedin-home");
  });

  it("restores the previous assistant home after explicit overrides", async () => {
    process.env.LINKEDIN_BUDDY_HOME = "/tmp/original-linkedin-home";

    await withAssistantHome("/tmp/isolated-linkedin-home", async () => {
      expect(process.env.LINKEDIN_BUDDY_HOME).toBe("/tmp/isolated-linkedin-home");
    });

    expect(process.env.LINKEDIN_BUDDY_HOME).toBe("/tmp/original-linkedin-home");
  });

  it("cleans up the shared E2E assistant home between runs", () => {
    const firstDir = getE2EBaseDir();
    expect(existsSync(firstDir)).toBe(true);

    cleanupRuntime();
    expect(existsSync(firstDir)).toBe(false);
    expect(() => cleanupRuntime()).not.toThrow();

    const secondDir = getE2EBaseDir();
    expect(secondDir).not.toBe(firstDir);
    expect(existsSync(secondDir)).toBe(true);
    cleanupRuntime();

    expect(existsSync(secondDir)).toBe(false);
  });

  it("defaults the CDP URL when LINKEDIN_CDP_URL is unset", () => {
    delete process.env.LINKEDIN_CDP_URL;

    expect(getCdpUrl()).toBe(DEFAULT_E2E_CDP_URL);
  });

  it("switches to fixture replay availability when replay mode is enabled", async () => {
    process.env.LINKEDIN_E2E_REPLAY = "1";
    process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = path.resolve("test/fixtures/manifest.json");
    process.env.LINKEDIN_E2E_FIXTURE_SET = "ci";
    delete process.env.LINKEDIN_CDP_URL;

    expect(getCdpUrl()).toBeUndefined();

    const availability = await getE2EAvailability();

    expect(availability).toMatchObject({
      cdpAvailable: true,
      authenticated: true,
      canRun: true
    });
    expect(availability.reason).toContain("Fixture replay is active for set ci");
  });

  it("fails fast when replay mode is enabled but the replay harness is misconfigured", async () => {
    process.env.LINKEDIN_E2E_REPLAY = "1";
    process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = path.resolve("test/fixtures/missing-manifest.json");
    delete process.env.LINKEDIN_CDP_URL;

    await expect(getE2EAvailability()).rejects.toThrow(
      `Fixture replay could not start. Fixture manifest ${path.resolve("test/fixtures/missing-manifest.json")} does not exist.`
    );
  });

  it("reports malformed CDP URLs as unavailable", async () => {
    process.env.LINKEDIN_CDP_URL = "not-a-url";

    const availability = await getE2EAvailability();

    expect(availability).toMatchObject({
      cdpAvailable: false,
      authenticated: false,
      canRun: false
    });
    expect(availability.reason).toContain("absolute http(s) URL");
  });

  it("reports unreachable CDP endpoints with actionable guidance", async () => {
    process.env.LINKEDIN_CDP_URL = "http://127.0.0.1:45555";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));

    const availability = await getE2EAvailability();

    expect(availability).toMatchObject({
      cdpAvailable: false,
      authenticated: false,
      canRun: false
    });
    expect(availability.reason).toContain("http://127.0.0.1:45555");
    expect(availability.reason).toContain("LINKEDIN_CDP_URL");
  });

  it("cleans stale shared E2E directories left by crashed processes", () => {
    const staleDir = mkdtempSync(path.join(os.tmpdir(), E2E_BASE_DIR_PREFIX));
    writeFileSync(
      path.join(staleDir, E2E_OWNER_METADATA_FILE),
      JSON.stringify({
        pid: 999_999,
        createdAtMs: Date.now() - 1_000
      }),
      "utf8"
    );

    const baseDir = getE2EBaseDir();

    expect(baseDir).not.toBe(staleDir);
    expect(existsSync(baseDir)).toBe(true);
    expect(existsSync(staleDir)).toBe(false);
  });
});

describe("skipIfE2EUnavailable", () => {
  it("returns true when availability is missing and context is null", () => {
    const suite = {
      availability: () => undefined,
      canRun: () => false,
      runtime: () => {
        throw new Error("runtime should not be used");
      },
      fixtures: () => undefined
    } as unknown as E2ESuite;

    expect(skipIfE2EUnavailable(suite, null)).toBe(true);
  });

  it("uses a fallback reason when the suite has no availability details", () => {
    const context = {
      skip: vi.fn()
    };
    const suite = {
      availability: () => undefined,
      canRun: () => false,
      runtime: () => {
        throw new Error("runtime should not be used");
      },
      fixtures: () => undefined
    } as unknown as E2ESuite;

    expect(skipIfE2EUnavailable(suite, context)).toBe(true);
    expect(context.skip).toHaveBeenCalledWith(
      "Skipping LinkedIn E2E: LinkedIn E2E prerequisites are unavailable."
    );
  });
});
