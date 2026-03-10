import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileCliMocks = vi.hoisted(() => ({
  close: vi.fn(),
  confirmByToken: vi.fn(),
  createCoreRuntime: vi.fn(),
  loggerLog: vi.fn(),
  prepareRemoveSectionItem: vi.fn(),
  prepareUpdateIntro: vi.fn(),
  prepareUpdatePublicProfile: vi.fn(),
  prepareUpdateSettings: vi.fn(),
  prepareUpsertSectionItem: vi.fn(),
  viewEditableProfile: vi.fn(),
  viewProfile: vi.fn()
}));

vi.mock("@linkedin-assistant/core", async () => {
  const actual = await import("../../core/src/index.js");
  return {
    ...actual,
    createCoreRuntime: profileCliMocks.createCoreRuntime
  };
});

import { runCli } from "../src/bin/linkedin.js";

describe("CLI profile commands", () => {
  let tempDir = "";
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-profile-"));
    process.env.LINKEDIN_ASSISTANT_HOME = path.join(tempDir, "assistant-home");
    process.exitCode = undefined;
    stdoutChunks = [];
    stderrChunks = [];
    vi.clearAllMocks();

    profileCliMocks.createCoreRuntime.mockImplementation(() => ({
      close: profileCliMocks.close,
      logger: { log: profileCliMocks.loggerLog },
      profile: {
        viewEditableProfile: profileCliMocks.viewEditableProfile,
        viewProfile: profileCliMocks.viewProfile,
        prepareUpdateIntro: profileCliMocks.prepareUpdateIntro,
        prepareUpdateSettings: profileCliMocks.prepareUpdateSettings,
        prepareUpdatePublicProfile: profileCliMocks.prepareUpdatePublicProfile,
        prepareUpsertSectionItem: profileCliMocks.prepareUpsertSectionItem,
        prepareRemoveSectionItem: profileCliMocks.prepareRemoveSectionItem
      },
      runId: "run-profile-cli",
      twoPhaseCommit: {
        confirmByToken: profileCliMocks.confirmByToken
      }
    }));

    profileCliMocks.viewEditableProfile.mockResolvedValue({
      profile_url: "https://www.linkedin.com/in/me/",
      intro: {
        full_name: "Avery Cole",
        headline: "Software Engineer",
        location: "Copenhagen, Denmark",
        supported_fields: ["firstName", "lastName", "headline", "location"]
      },
      settings: {
        industry: "Technology, Information and Internet",
        supported_fields: ["industry"]
      },
      public_profile: {
        vanity_name: "avery-cole",
        public_profile_url: "https://www.linkedin.com/in/avery-cole/",
        supported_fields: ["vanityName", "publicProfileUrl"]
      },
      sections: []
    });
    profileCliMocks.viewProfile.mockResolvedValue({
      profile_url: "https://www.linkedin.com/in/avery-cole-example/",
      vanity_name: "avery-cole-example",
      full_name: "Avery Cole",
      headline: "Automation Engineer at Example Labs",
      location: "Copenhagen, Capital Region of Denmark, Denmark",
      about: "Building production LLM systems.",
      connection_degree: "",
      experience: [],
      education: []
    });
    profileCliMocks.prepareUpdateIntro.mockReturnValue({
      preparedActionId: "pa_intro",
      confirmToken: "ct_intro",
      expiresAtMs: 1,
      preview: { summary: "Update intro" }
    });
    profileCliMocks.prepareUpsertSectionItem.mockReturnValue({
      preparedActionId: "pa_about",
      confirmToken: "ct_about",
      expiresAtMs: 1,
      preview: { summary: "Update about" }
    });
    profileCliMocks.prepareUpdateSettings.mockReturnValue({
      preparedActionId: "pa_settings",
      confirmToken: "ct_settings",
      expiresAtMs: 1,
      preview: { summary: "Update settings" }
    });
    profileCliMocks.prepareUpdatePublicProfile.mockReturnValue({
      preparedActionId: "pa_public_profile",
      confirmToken: "ct_public_profile",
      expiresAtMs: 1,
      preview: { summary: "Update public profile" }
    });
    profileCliMocks.prepareRemoveSectionItem.mockReturnValue({
      preparedActionId: "pa_remove",
      confirmToken: "ct_remove",
      expiresAtMs: 1,
      preview: { summary: "Remove item" }
    });
    profileCliMocks.confirmByToken
      .mockResolvedValueOnce({
        preparedActionId: "pa_intro",
        status: "executed",
        actionType: "profile.update_intro",
        result: { status: "profile_intro_updated" },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa_settings",
        status: "executed",
        actionType: "profile.update_settings",
        result: { status: "profile_settings_updated" },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa_public_profile",
        status: "executed",
        actionType: "profile.update_public_profile",
        result: { status: "profile_public_profile_updated" },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa_about",
        status: "executed",
        actionType: "profile.upsert_section_item",
        result: { status: "profile_section_item_upserted" },
        artifacts: []
      });

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      stdoutChunks.push(String(value ?? ""));
    });
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
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prints the editable profile surface", async () => {
    await runCli(["node", "linkedin", "profile", "editable", "--profile", "smoke"]);

    const output = JSON.parse(stdoutChunks.join("\n")) as {
      profile: {
        intro: {
          full_name: string;
        };
      };
      profile_name: string;
      run_id: string;
    };

    expect(output.profile_name).toBe("smoke");
    expect(output.run_id).toBe("run-profile-cli");
    expect(output.profile.intro.full_name).toBe("Avery Cole");
    expect(profileCliMocks.viewEditableProfile).toHaveBeenCalledWith({
      profileName: "smoke"
    });
  });

  it("prepares a profile settings update", async () => {
    await runCli([
      "node",
      "linkedin",
      "profile",
      "prepare-update-settings",
      "--profile",
      "smoke",
      "--industry",
      "Software Development"
    ]);

    const output = JSON.parse(stdoutChunks.join("\n")) as {
      confirmToken: string;
      preparedActionId: string;
      profile_name: string;
    };

    expect(output.profile_name).toBe("smoke");
    expect(output.preparedActionId).toBe("pa_settings");
    expect(profileCliMocks.prepareUpdateSettings).toHaveBeenCalledWith({
      profileName: "smoke",
      industry: "Software Development"
    });
  });

  it("prepares a public profile URL update", async () => {
    await runCli([
      "node",
      "linkedin",
      "profile",
      "prepare-update-public-profile",
      "--profile",
      "smoke",
      "--vanity-name",
      "avery-cole-example"
    ]);

    const output = JSON.parse(stdoutChunks.join("\n")) as {
      confirmToken: string;
      preparedActionId: string;
      profile_name: string;
    };

    expect(output.profile_name).toBe("smoke");
    expect(output.preparedActionId).toBe("pa_public_profile");
    expect(profileCliMocks.prepareUpdatePublicProfile).toHaveBeenCalledWith({
      profileName: "smoke",
      vanityName: "avery-cole-example"
    });
  });

  it("applies a profile seed spec and reports unsupported fields when partial mode is enabled", async () => {
    const specPath = path.join(tempDir, "profile-spec.json");
    await writeFile(
      specPath,
      JSON.stringify(
        {
          intro: {
            headline: "Automation Engineer at Example Labs",
            location: "Copenhagen, Capital Region of Denmark, Denmark",
            industry: "Software Development",
            customProfileUrl: "avery-cole-example"
          },
          about: "Building production LLM systems.",
          skills: ["TypeScript", "Python"]
        },
        null,
        2
      )
    );

    await runCli([
      "node",
      "linkedin",
      "profile",
      "apply-spec",
      "--profile",
      "smoke",
      "--spec",
      specPath,
      "--allow-partial",
      "--yes",
      "--delay-ms",
      "0"
    ]);

    const output = JSON.parse(stdoutChunks.join("\n")) as {
      actions: Array<{ action_type: string }>;
      executed_action_count: number;
      profile_name: string;
      unsupported_fields: Array<{ issueNumber: number; path: string }>;
    };

    expect(output.profile_name).toBe("smoke");
    expect(output.executed_action_count).toBe(4);
    expect(output.actions.map((action) => action.action_type)).toEqual([
      "profile.update_intro",
      "profile.update_settings",
      "profile.update_public_profile",
      "profile.upsert_section_item"
    ]);
    expect(output.unsupported_fields).toEqual([
      {
        path: "skills",
        reason: "Skills are not exposed by the current LinkedIn profile edit automation.",
        issueNumber: 228
      }
    ]);
    expect(profileCliMocks.prepareUpdateIntro).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "smoke",
        headline: "Automation Engineer at Example Labs",
        location: "Copenhagen, Capital Region of Denmark, Denmark"
      })
    );
    expect(profileCliMocks.prepareUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "smoke",
        industry: "Software Development"
      })
    );
    expect(profileCliMocks.prepareUpdatePublicProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "smoke",
        publicProfileUrl: "avery-cole-example"
      })
    );
    expect(profileCliMocks.prepareUpsertSectionItem).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "smoke",
        section: "about",
        values: { text: "Building production LLM systems." }
      })
    );
    expect(stderrChunks.join("")).toContain("Ignoring unsupported profile fields");
  });

  it("rejects unsupported fields when partial mode is disabled", async () => {
    const specPath = path.join(tempDir, "profile-spec-strict.json");
    await writeFile(
      specPath,
      JSON.stringify(
        {
          intro: {
            headline: "Automation Engineer at Example Labs"
          },
          skills: ["TypeScript"]
        },
        null,
        2
      )
    );

    await expect(
      runCli([
        "node",
        "linkedin",
        "profile",
        "apply-spec",
        "--profile",
        "smoke",
        "--spec",
        specPath,
        "--yes"
      ])
    ).rejects.toThrow("Profile seed spec includes unsupported fields: skills (#228)");

    expect(profileCliMocks.prepareUpdateIntro).not.toHaveBeenCalled();
    expect(profileCliMocks.confirmByToken).not.toHaveBeenCalled();
  });
});
