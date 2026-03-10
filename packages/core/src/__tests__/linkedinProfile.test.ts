import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantDatabase } from "../db/database.js";
import {
  ADD_PROFILE_FEATURED_ACTION_TYPE,
  LINKEDIN_PROFILE_SECTION_TYPES,
  LINKEDIN_PROFILE_FEATURED_ITEM_KINDS,
  REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE,
  REMOVE_PROFILE_FEATURED_ACTION_TYPE,
  REORDER_PROFILE_FEATURED_ACTION_TYPE,
  UPLOAD_PROFILE_BANNER_ACTION_TYPE,
  UPLOAD_PROFILE_PHOTO_ACTION_TYPE,
  UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE,
  UPDATE_PROFILE_INTRO_ACTION_TYPE,
  UPDATE_PROFILE_SETTINGS_ACTION_TYPE,
  UPDATE_PUBLIC_PROFILE_ACTION_TYPE,
  LinkedInProfileService,
  createProfileActionExecutors,
  resolveProfileUrl,
  type LinkedInProfileRuntime
} from "../linkedinProfile.js";
import { TwoPhaseCommitService } from "../twoPhaseCommit.js";

const tempDirs: string[] = [];

function createTempArtifactsDir(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-profile-test-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createFeaturedItemId(
  kind: "link" | "media" | "post",
  data: {
    sourceId?: string;
    url?: string;
    title?: string;
    subtitle?: string;
    rawText?: string;
  }
): string {
  return `pfi_${Buffer.from(
    JSON.stringify({
      v: 1,
      kind,
      sourceId: data.sourceId ?? "",
      url: data.url ?? "",
      title: data.title ?? "",
      subtitle: data.subtitle ?? "",
      rawText: data.rawText ?? ""
    })
  ).toString("base64url")}`;
}

function createTestRuntime(
  db: AssistantDatabase,
  artifactsRoot: string = createTempArtifactsDir()
): LinkedInProfileRuntime {
  return {
    auth: {
      ensureAuthenticated: vi.fn(async () => undefined)
    },
    cdpUrl: undefined,
    selectorLocale: "en",
    profileManager: {
      runWithContext: vi.fn()
    },
    logger: {
      log: vi.fn()
    },
    artifacts: {
      resolve: vi.fn((relativePath: string) => path.join(artifactsRoot, relativePath)),
      registerArtifact: vi.fn(),
      getRunDir: vi.fn(() => artifactsRoot)
    },
    confirmFailureArtifacts: {
      traceMaxBytes: 2 * 1024 * 1024
    },
    twoPhaseCommit: new TwoPhaseCommitService(db)
  } as unknown as LinkedInProfileRuntime;
}

afterEach(() => {
  vi.restoreAllMocks();

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("resolveProfileUrl", () => {
  it("defaults to /in/me/ for undefined input", () => {
    expect(resolveProfileUrl(undefined)).toBe("https://www.linkedin.com/in/me/");
  });

  it("defaults to /in/me/ for empty string", () => {
    expect(resolveProfileUrl("")).toBe("https://www.linkedin.com/in/me/");
  });

  it("defaults to /in/me/ for 'me'", () => {
    expect(resolveProfileUrl("me")).toBe("https://www.linkedin.com/in/me/");
  });

  it("passes through a full linkedin URL", () => {
    expect(resolveProfileUrl("https://www.linkedin.com/in/johndoe/")).toBe(
      "https://www.linkedin.com/in/johndoe/"
    );
  });

  it("prepends origin for /in/ path", () => {
    expect(resolveProfileUrl("/in/johndoe")).toBe(
      "https://www.linkedin.com/in/johndoe"
    );
  });

  it("treats plain string as vanity name", () => {
    expect(resolveProfileUrl("johndoe")).toBe(
      "https://www.linkedin.com/in/johndoe/"
    );
  });

  it("encodes special characters in vanity name", () => {
    expect(resolveProfileUrl("john doe")).toBe(
      "https://www.linkedin.com/in/john%20doe/"
    );
  });
});

describe("profile action type constants", () => {
  it("exposes the expected action type names", () => {
    expect(UPDATE_PROFILE_INTRO_ACTION_TYPE).toBe("profile.update_intro");
    expect(UPDATE_PROFILE_SETTINGS_ACTION_TYPE).toBe("profile.update_settings");
    expect(UPDATE_PUBLIC_PROFILE_ACTION_TYPE).toBe(
      "profile.update_public_profile"
    );
    expect(UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE).toBe(
      "profile.upsert_section_item"
    );
    expect(REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE).toBe(
      "profile.remove_section_item"
    );
    expect(UPLOAD_PROFILE_PHOTO_ACTION_TYPE).toBe("profile.upload_photo");
    expect(UPLOAD_PROFILE_BANNER_ACTION_TYPE).toBe("profile.upload_banner");
    expect(ADD_PROFILE_FEATURED_ACTION_TYPE).toBe("profile.featured_add");
    expect(REMOVE_PROFILE_FEATURED_ACTION_TYPE).toBe("profile.featured_remove");
    expect(REORDER_PROFILE_FEATURED_ACTION_TYPE).toBe("profile.featured_reorder");
  });

  it("lists the supported editable profile sections", () => {
    expect(LINKEDIN_PROFILE_SECTION_TYPES).toEqual([
      "about",
      "experience",
      "education",
      "certifications",
      "languages",
      "projects",
      "volunteer_experience",
      "honors_awards"
    ]);
    expect(LINKEDIN_PROFILE_SECTION_TYPES).not.toContain("featured");
    expect(LINKEDIN_PROFILE_FEATURED_ITEM_KINDS).toEqual(["link", "media", "post"]);
  });
});

describe("createProfileActionExecutors", () => {
  it("registers the profile action executors", () => {
    const executors = createProfileActionExecutors();

    expect(executors[UPDATE_PROFILE_INTRO_ACTION_TYPE]).toBeDefined();
    expect(executors[UPDATE_PROFILE_SETTINGS_ACTION_TYPE]).toBeDefined();
    expect(executors[UPDATE_PUBLIC_PROFILE_ACTION_TYPE]).toBeDefined();
    expect(executors[UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE]).toBeDefined();
    expect(executors[UPLOAD_PROFILE_PHOTO_ACTION_TYPE]).toBeDefined();
    expect(executors[UPLOAD_PROFILE_BANNER_ACTION_TYPE]).toBeDefined();
    expect(executors[ADD_PROFILE_FEATURED_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_PROFILE_FEATURED_ACTION_TYPE]).toBeDefined();
    expect(executors[REORDER_PROFILE_FEATURED_ACTION_TYPE]).toBeDefined();
  });

  it("exposes execute methods for each profile action executor", () => {
    const executors = createProfileActionExecutors();

    for (const executor of Object.values(executors)) {
      expect(typeof executor.execute).toBe("function");
    }
  });
});

describe("LinkedInProfileService prepare helpers", () => {
  it("prepares intro updates through two-phase confirm", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareUpdateIntro({
        profileName: "default",
        headline: "Automation Engineer",
        location: "Copenhagen"
      });

      expect(prepared).toMatchObject({
        preparedActionId: expect.stringMatching(/^pa_/),
        confirmToken: expect.stringMatching(/^ct_/),
        preview: {
          summary: "Update LinkedIn profile intro (headline, location)",
          intro_updates: {
            headline: "Automation Engineer",
            location: "Copenhagen"
          }
        }
      });
    } finally {
      db.close();
    }
  });

  it("prepares profile settings updates through two-phase confirm", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareUpdateSettings({
        profileName: "default",
        industry: "Software Development"
      });

      expect(prepared).toMatchObject({
        preparedActionId: expect.stringMatching(/^pa_/),
        confirmToken: expect.stringMatching(/^ct_/),
        preview: {
          summary: "Update LinkedIn profile settings (industry)",
          settings_updates: {
            industry: "Software Development"
          }
        }
      });
    } finally {
      db.close();
    }
  });

  it("prepares public profile URL updates through two-phase confirm", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareUpdatePublicProfile({
        profileName: "default",
        vanityName: "avery-cole-example"
      });

      expect(prepared).toMatchObject({
        preparedActionId: expect.stringMatching(/^pa_/),
        confirmToken: expect.stringMatching(/^ct_/),
        preview: {
          summary: "Update LinkedIn public profile URL (avery-cole-example)",
          public_profile: {
            vanity_name: "avery-cole-example",
            public_profile_url: "https://www.linkedin.com/in/avery-cole-example/"
          }
        }
      });
    } finally {
      db.close();
    }
  });

  it("prepares section upserts and normalizes section aliases", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareUpsertSectionItem({
        profileName: "default",
        section: "certification",
        values: {
          name: "AWS Certified Developer",
          issuingOrganization: "Amazon Web Services"
        }
      });

      expect(prepared).toMatchObject({
        preparedActionId: expect.stringMatching(/^pa_/),
        confirmToken: expect.stringMatching(/^ct_/),
        preview: {
          summary: "Create certifications profile section item",
          section: "certifications",
          mode: "create",
          values: {
            name: "AWS Certified Developer",
            issuingOrganization: "Amazon Web Services"
          }
        }
      });
    } finally {
      db.close();
    }
  });

  it("prepares section removals for about without an item id", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareRemoveSectionItem({
        profileName: "default",
        section: "about"
      });

      expect(prepared.preview).toMatchObject({
        summary: "Clear LinkedIn about summary",
        section: "about"
      });
    } finally {
      db.close();
    }
  });

  it("requires item matching details when removing non-about section items", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));

      expect(() =>
        service.prepareRemoveSectionItem({
          profileName: "default",
          section: "experience"
        })
      ).toThrow("requires itemId or match details");
    } finally {
      db.close();
    }
  });

  it("stages profile photo uploads into artifacts during prepare", async () => {
    const db = new AssistantDatabase(":memory:");
    const artifactsRoot = createTempArtifactsDir();
    const sourcePath = path.join(artifactsRoot, "photo.png");
    writeFileSync(sourcePath, "fake-image-bytes", "utf8");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db, artifactsRoot));
      const prepared = await service.prepareUploadPhoto({
        profileName: "default",
        filePath: sourcePath
      });

      const uploadPreview = prepared.preview.upload as Record<string, unknown>;
      const artifactPath = String(uploadPreview.artifact_path ?? "");

      expect(prepared.preview).toMatchObject({
        summary: "Upload LinkedIn profile photo (photo.png)",
        upload: {
          file_name: "photo.png",
          mime_type: "image/png",
          size_bytes: "fake-image-bytes".length
        }
      });
      expect(artifactPath).toContain("linkedin/input-profile-photo-");
      expect(existsSync(path.join(artifactsRoot, artifactPath))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rejects unsupported profile photo upload file types", async () => {
    const db = new AssistantDatabase(":memory:");
    const artifactsRoot = createTempArtifactsDir();
    const sourcePath = path.join(artifactsRoot, "photo.txt");
    writeFileSync(sourcePath, "not-an-image", "utf8");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db, artifactsRoot));

      await expect(
        service.prepareUploadPhoto({
          profileName: "default",
          filePath: sourcePath
        })
      ).rejects.toThrow("not supported");
    } finally {
      db.close();
    }
  });

  it("prepares featured link additions", async () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = await service.prepareFeaturedAdd({
        profileName: "default",
        kind: "link",
        url: "https://example.com/launch",
        title: "Launch page"
      });

      expect(prepared.preview).toMatchObject({
        summary: "Add link item to LinkedIn Featured section",
        target: {
          profile_name: "default",
          kind: "link"
        },
        title: "Launch page"
      });
      expect(String(prepared.preview.url ?? "")).toContain("https://example.com/launch");
    } finally {
      db.close();
    }
  });

  it("requires item matching details when removing featured items", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));

      expect(() => service.prepareFeaturedRemove({ profileName: "default" })).toThrow(
        "requires itemId or match details"
      );
    } finally {
      db.close();
    }
  });

  it("rejects duplicate featured reorder item ids", () => {
    const db = new AssistantDatabase(":memory:");
    const featuredItemId = createFeaturedItemId("link", {
      url: "https://example.com/launch",
      title: "Launch page",
      rawText: "Launch page"
    });

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));

      expect(() =>
        service.prepareFeaturedReorder({
          profileName: "default",
          itemIds: [featuredItemId, featuredItemId]
        })
      ).toThrow("must be unique");
    } finally {
      db.close();
    }
  });

  it("rejects featured reorder item ids that were not issued by view_editable", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));

      expect(() =>
        service.prepareFeaturedReorder({
          profileName: "default",
          itemIds: ["not-a-featured-id"]
        })
      ).toThrow("view_editable.featured.items");
    } finally {
      db.close();
    }
  });
});
