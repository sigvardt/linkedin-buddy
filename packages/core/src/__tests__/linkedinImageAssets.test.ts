import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { ArtifactHelpers } from "../artifacts.js";
import {
  buildLinkedInImagePersonaFromProfileSeed,
  LinkedInImageAssetsService
} from "../linkedinImageAssets.js";

const tempDirs: string[] = [];

function createTempArtifactsRoot(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-image-assets-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createSolidPng(
  width: number,
  height: number,
  color: { red: number; green: number; blue: number }
): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = color.red;
    png.data[index + 1] = color.green;
    png.data[index + 2] = color.blue;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

function createFetchMock() {
  return vi.fn(async (_input: string | URL | Request, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { size?: string };
    const size = body.size;
    const dimensions =
      size === "1024x1536"
        ? { width: 1024, height: 1536, color: { red: 50, green: 90, blue: 140 } }
        : size === "1536x1024"
          ? { width: 1536, height: 1024, color: { red: 80, green: 130, blue: 180 } }
          : { width: 1024, height: 1024, color: { red: 120, green: 80, blue: 160 } };

    return new Response(
      JSON.stringify({
        data: [
          {
            b64_json: createSolidPng(
              dimensions.width,
              dimensions.height,
              dimensions.color
            ).toString("base64"),
            revised_prompt: "refined prompt"
          }
        ],
        usage: {
          size
        }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  });
}

function createService() {
  const artifactsRoot = createTempArtifactsRoot();
  const artifacts = new ArtifactHelpers(
    {
      baseDir: artifactsRoot,
      artifactsDir: artifactsRoot,
      profilesDir: path.join(artifactsRoot, "profiles"),
      dbPath: path.join(artifactsRoot, "state.sqlite")
    },
    "run-test"
  );
  const prepareUploadPhoto = vi.fn();
  const prepareUploadBanner = vi.fn();
  const confirmPreparedAction = vi.fn();

  return {
    artifacts,
    prepareUploadPhoto,
    prepareUploadBanner,
    confirmPreparedAction,
    service: new LinkedInImageAssetsService(
      {
        logger: {
          log: vi.fn()
        },
        artifacts,
        profile: {
          prepareUploadPhoto,
          prepareUploadBanner
        },
        confirmPreparedAction
      },
      {
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-image-1.5"
      }
    )
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("buildLinkedInImagePersonaFromProfileSeed", () => {
  it("extracts the issue-210 persona fields needed for image generation", () => {
    const persona = buildLinkedInImagePersonaFromProfileSeed({
      intro: {
        firstName: "Emil",
        lastName: "Sorensen",
        headline: "AI/ML Engineer at Signikant | TypeScript, Python, LLM Systems, MLOps",
        location: "Copenhagen, Capital Region of Denmark, Denmark"
      },
      about: "I build AI products that have to work outside the demo.",
      experience: [
        {
          title: "AI/ML Engineer",
          company: "Signikant"
        }
      ],
      skills: ["TypeScript", "Python", "LLMs", "MLOps"],
      projects: [{ title: "LLM Evaluation Toolkit" }]
    });

    expect(persona).toMatchObject({
      slug: "emil-sorensen",
      full_name: "Emil Sorensen",
      current_role: "AI/ML Engineer",
      current_company: "Signikant",
      focus_areas: [
        "TypeScript",
        "Python",
        "LLMs",
        "MLOps",
        "LLM Evaluation Toolkit"
      ]
    });
  });
});

describe("LinkedInImageAssetsService", () => {
  it("generates a cohesive image bundle with the required dimensions", async () => {
    const { service } = createService();
    vi.stubGlobal("fetch", createFetchMock());

    const persona = buildLinkedInImagePersonaFromProfileSeed({
      intro: {
        firstName: "Emil",
        lastName: "Sorensen",
        headline: "AI/ML Engineer at Signikant | TypeScript, Python, LLM Systems, MLOps",
        location: "Copenhagen, Capital Region of Denmark, Denmark"
      },
      about: "I build AI products that have to work outside the demo.",
      experience: [
        {
          title: "AI/ML Engineer",
          company: "Signikant"
        }
      ],
      skills: ["TypeScript", "Python", "LLMs", "MLOps"],
      projects: [{ title: "LLM Evaluation Toolkit" }]
    });

    const result = await service.generatePersonaImageSet({
      persona,
      postImageCount: 5
    });

    expect(result.model).toBe("gpt-image-1.5");
    expect(result.post_images).toHaveLength(5);
    expect(result.profile_photo.file_name).toBe("emil-sorensen-profile-photo.png");
    expect(result.banner.file_name).toBe("emil-sorensen-banner-ai-systems.png");
    expect(existsSync(result.manifest_path)).toBe(true);
    expect(existsSync(result.profile_photo.absolute_path)).toBe(true);
    expect(existsSync(result.banner.absolute_path)).toBe(true);

    const profilePng = PNG.sync.read(readFileSync(result.profile_photo.absolute_path));
    const bannerPng = PNG.sync.read(readFileSync(result.banner.absolute_path));

    expect(profilePng.width).toBe(800);
    expect(profilePng.height).toBe(800);
    expect(bannerPng.width).toBe(1584);
    expect(bannerPng.height).toBe(396);

    const manifest = JSON.parse(readFileSync(result.manifest_path, "utf8")) as {
      post_images: unknown[];
      profile_photo: { file_name: string };
    };
    expect(manifest.profile_photo.file_name).toBe(
      "emil-sorensen-profile-photo.png"
    );
    expect(manifest.post_images).toHaveLength(5);
  }, 20_000);

  it("optionally uploads the generated photo and banner through the existing profile flow", async () => {
    const {
      service,
      prepareUploadPhoto,
      prepareUploadBanner,
      confirmPreparedAction
    } = createService();
    vi.stubGlobal("fetch", createFetchMock());

    prepareUploadPhoto.mockResolvedValue({
      confirmToken: "ct-photo"
    });
    prepareUploadBanner.mockResolvedValue({
      confirmToken: "ct-banner"
    });
    confirmPreparedAction
      .mockResolvedValueOnce({
        preparedActionId: "pa-photo",
        actionType: "profile.upload_photo",
        status: "executed",
        result: { status: "profile_photo_uploaded" },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa-banner",
        actionType: "profile.upload_banner",
        status: "executed",
        result: { status: "profile_banner_uploaded" },
        artifacts: []
      });

    const persona = buildLinkedInImagePersonaFromProfileSeed({
      intro: {
        firstName: "Emil",
        lastName: "Sorensen",
        headline: "AI/ML Engineer at Signikant | TypeScript, Python, LLM Systems, MLOps",
        location: "Copenhagen, Capital Region of Denmark, Denmark"
      },
      about: "I build AI products that have to work outside the demo.",
      experience: [
        {
          title: "AI/ML Engineer",
          company: "Signikant"
        }
      ]
    });

    const result = await service.generatePersonaImageSet({
      persona,
      postImageCount: 2,
      uploadProfileMedia: true,
      profileName: "default",
      uploadDelayMs: 0,
      operatorNote: "Issue 211"
    });

    expect(prepareUploadPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "default",
        filePath: result.profile_photo.absolute_path,
        operatorNote: "Issue 211"
      })
    );
    expect(prepareUploadBanner).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "default",
        filePath: result.banner.absolute_path,
        operatorNote: "Issue 211"
      })
    );
    expect(confirmPreparedAction).toHaveBeenCalledTimes(2);
    expect(result.upload_results).toEqual({
      profile_photo: {
        prepared_action_id: "pa-photo",
        action_type: "profile.upload_photo",
        status: "executed",
        file_name: "emil-sorensen-profile-photo.png",
        result: { status: "profile_photo_uploaded" },
        artifacts: []
      },
      banner: {
        prepared_action_id: "pa-banner",
        action_type: "profile.upload_banner",
        status: "executed",
        file_name: "emil-sorensen-banner-ai-systems.png",
        result: { status: "profile_banner_uploaded" },
        artifacts: []
      }
    });
  }, 20_000);
});
