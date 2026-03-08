import { describe, expect, it } from "vitest";
import {
  formatRunnerConfiguration,
  formatUnavailableGuidance,
  getRunnerHelpText,
  parseRunnerOptions
} from "../../../../scripts/run-e2e.js";

describe("run-e2e runner options", () => {
  it("parses runner flags and preserves remaining vitest args", () => {
    const options = parseRunnerOptions([
      "--require-session",
      "--fixtures",
      ".tmp/e2e-fixtures.json",
      "--refresh-fixtures",
      "--reporter=verbose",
      "packages/core/src/__tests__/e2e/cli.e2e.test.ts"
    ]);

    expect(options).toEqual({
      showHelp: false,
      requireSession: true,
      refreshFixtures: true,
      fixtureFile: ".tmp/e2e-fixtures.json",
      vitestArgs: [
        "--reporter=verbose",
        "packages/core/src/__tests__/e2e/cli.e2e.test.ts"
      ]
    });
  });

  it("starts from environment defaults before applying CLI overrides", () => {
    const options = parseRunnerOptions(["packages/core/src/__tests__/e2e/mcp.e2e.test.ts"], {
      LINKEDIN_E2E_REQUIRE_SESSION: "true",
      LINKEDIN_E2E_FIXTURE_FILE: ".tmp/from-env.json",
      LINKEDIN_E2E_REFRESH_FIXTURES: "1"
    });

    expect(options).toEqual({
      showHelp: false,
      requireSession: true,
      refreshFixtures: true,
      fixtureFile: ".tmp/from-env.json",
      vitestArgs: ["packages/core/src/__tests__/e2e/mcp.e2e.test.ts"]
    });
  });

  it("rejects empty fixture flag values", () => {
    expect(() => parseRunnerOptions(["--fixtures", ""]))
      .toThrow("--fixtures requires a file path argument");
    expect(() => parseRunnerOptions(["--fixtures="]))
      .toThrow("--fixtures requires a non-empty file path");
  });
});

describe("run-e2e runner messaging", () => {
  it("formats a readable configuration summary", () => {
    const lines = formatRunnerConfiguration(
      {
        showHelp: false,
        requireSession: true,
        refreshFixtures: true,
        fixtureFile: ".tmp/e2e-fixtures.json",
        vitestArgs: ["packages/core/src/__tests__/e2e/error-paths.e2e.test.ts"]
      },
      {
        LINKEDIN_CDP_URL: "http://127.0.0.1:18800",
        LINKEDIN_E2E_PROFILE: "review-profile",
        LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM: "1"
      }
    );

    expect(lines).toEqual(
      expect.arrayContaining([
        "CDP endpoint: http://127.0.0.1:18800",
        "Profile: review-profile",
        "Session policy: required",
        expect.stringContaining("Coverage fixtures:"),
        "Opt-in confirms: message",
        "Vitest args: packages/core/src/__tests__/e2e/error-paths.e2e.test.ts"
      ])
    );
  });

  it("distinguishes skip guidance from required-session failures", () => {
    expect(
      formatUnavailableGuidance("session missing", {
        showHelp: false,
        requireSession: false,
        refreshFixtures: false,
        fixtureFile: undefined,
        vitestArgs: []
      })
    ).toEqual(
      expect.arrayContaining([
        "Skipping LinkedIn E2E suite: session missing",
        expect.stringContaining("--require-session")
      ])
    );

    expect(
      formatUnavailableGuidance("session missing", {
        showHelp: false,
        requireSession: true,
        refreshFixtures: false,
        fixtureFile: undefined,
        vitestArgs: []
      })
    ).toEqual(
      expect.arrayContaining([
        "LinkedIn E2E prerequisites are required but unavailable: session missing",
        "Fix the session prerequisites above and rerun the same command."
      ])
    );
  });

  it("documents fixture replay and strict mode in the help text", () => {
    const helpText = getRunnerHelpText();

    expect(helpText).toContain("--require-session");
    expect(helpText).toContain("--fixtures <file>");
    expect(helpText).toContain("--refresh-fixtures");
    expect(helpText).toContain("LINKEDIN_E2E_REQUIRE_SESSION");
    expect(helpText).toContain("docs/e2e-testing.md");
  });
});
