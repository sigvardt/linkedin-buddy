import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assetsCliMocks = vi.hoisted(() => ({
  close: vi.fn(),
  createCoreRuntime: vi.fn(),
  generatePersonaImageSet: vi.fn(),
  loggerLog: vi.fn()
}));

vi.mock("@linkedin-buddy/core", async () => {
  const actual = await import("../../core/src/index.js");
  return {
    ...actual,
    createCoreRuntime: assetsCliMocks.createCoreRuntime
  };
});

import { runCli } from "../src/bin/linkedin.js";

describe("CLI assets commands", () => {
  let tempDir = "";
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-assets-"));
    process.env.LINKEDIN_BUDDY_HOME = path.join(tempDir, "buddy-home");
    stdoutChunks = [];
    vi.clearAllMocks();

    assetsCliMocks.createCoreRuntime.mockImplementation(() => ({
      close: assetsCliMocks.close,
      logger: {
        log: assetsCliMocks.loggerLog
      },
      imageAssets: {
        generatePersonaImageSet: assetsCliMocks.generatePersonaImageSet
      },
      runId: "run-assets-cli"
    }));

    assetsCliMocks.generatePersonaImageSet.mockResolvedValue({
      generated_at: "2026-03-10T10:00:00.000Z",
      model: "gpt-image-1.5",
      bundle_relative_dir: "linkedin-ai-assets/emil-sorensen/2026-03-10T10-00-00-000Z",
      bundle_absolute_dir: path.join(tempDir, "artifacts", "bundle"),
      manifest_path: path.join(tempDir, "artifacts", "bundle", "manifest.json"),
      persona: {
        slug: "emil-sorensen",
        full_name: "Emil Sorensen",
        headline: "AI/ML Engineer at Signikant",
        location: "Copenhagen, Denmark",
        summary: "I build AI products that have to work outside the demo.",
        current_role: "AI/ML Engineer",
        current_company: "Signikant",
        focus_areas: ["TypeScript", "Python", "LLMs"],
        project_titles: ["LLM Evaluation Toolkit"]
      },
      profile_photo: {
        kind: "profile_photo",
        title: "Profile Photo",
        concept_key: "profile-photo",
        file_name: "emil-sorensen-profile-photo.png",
        relative_path: "linkedin-ai-assets/emil-sorensen/profile-photo.png",
        absolute_path: path.join(tempDir, "artifacts", "profile-photo.png"),
        mime_type: "image/png",
        width: 800,
        height: 800,
        size_bytes: 1200,
        sha256: "abc123",
        prompt: "Create a headshot.",
        revised_prompt: "Create a refined headshot."
      },
      banner: {
        kind: "banner",
        title: "Profile Banner",
        concept_key: "profile-banner",
        file_name: "emil-sorensen-banner-ai-systems.png",
        relative_path: "linkedin-ai-assets/emil-sorensen/banner.png",
        absolute_path: path.join(tempDir, "artifacts", "banner.png"),
        mime_type: "image/png",
        width: 1584,
        height: 396,
        size_bytes: 2200,
        sha256: "def456",
        prompt: "Create a banner.",
        revised_prompt: null
      },
      post_images: [
        {
          kind: "post_image",
          title: "Workspace",
          concept_key: "copenhagen-workspace",
          file_name: "emil-sorensen-post-01-copenhagen-workspace.png",
          relative_path: "linkedin-ai-assets/emil-sorensen/post-01.png",
          absolute_path: path.join(tempDir, "artifacts", "post-01.png"),
          mime_type: "image/png",
          width: 1536,
          height: 1024,
          size_bytes: 1400,
          sha256: "ghi789",
          prompt: "Create a workspace scene.",
          revised_prompt: null
        }
      ]
    });

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      stdoutChunks.push(String(value ?? ""));
    });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    delete process.env.LINKEDIN_BUDDY_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates profile image assets from a persona spec and writes the report", async () => {
    const specPath = path.join(tempDir, "persona-spec.json");
    const outputPath = path.join(tempDir, "report.json");
    await writeFile(
      specPath,
      JSON.stringify(
        {
          intro: {
            firstName: "Emil",
            lastName: "Sorensen",
            headline:
              "AI/ML Engineer at Signikant | TypeScript, Python, LLM Systems, MLOps",
            location: "Copenhagen, Capital Region of Denmark, Denmark"
          },
          about: "I build AI products that have to work outside the demo.",
          experience: [
            {
              title: "AI/ML Engineer",
              company: "Signikant"
            }
          ],
          skills: ["TypeScript", "Python", "LLMs"]
        },
        null,
        2
      )
    );

    await runCli([
      "node",
      "linkedin",
      "assets",
      "generate-profile-images",
      "--profile",
      "smoke",
      "--spec",
      specPath,
      "--post-count",
      "6",
      "--model",
      "gpt-image-1.5",
      "--upload-profile-media",
      "--upload-delay-ms",
      "0",
      "--output",
      outputPath
    ]);

    const output = JSON.parse(stdoutChunks.join("\n")) as {
      output_path: string;
      profile_name: string;
      run_id: string;
      spec_path: string;
    };
    const writtenReport = JSON.parse(await readFile(outputPath, "utf8")) as {
      profile_name: string;
      profile_photo: { file_name: string };
    };

    expect(output.run_id).toBe("run-assets-cli");
    expect(output.profile_name).toBe("smoke");
    expect(output.spec_path).toBe(path.resolve(specPath));
    expect(output.output_path).toBe(path.resolve(outputPath));
    expect(writtenReport.profile_name).toBe("smoke");
    expect(writtenReport.profile_photo.file_name).toBe(
      "emil-sorensen-profile-photo.png"
    );
    expect(assetsCliMocks.generatePersonaImageSet).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "smoke",
        postImageCount: 6,
        uploadProfileMedia: true,
        uploadDelayMs: 0,
        model: "gpt-image-1.5",
        operatorNote: "issue-211 persona images: persona-spec.json",
        persona: expect.objectContaining({
          full_name: "Emil Sorensen",
          current_company: "Signikant"
        })
      })
    );
  });
});
