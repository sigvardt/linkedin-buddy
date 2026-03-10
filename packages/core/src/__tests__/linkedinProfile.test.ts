import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantDatabase } from "../db/database.js";
import {
  LINKEDIN_PROFILE_SECTION_TYPES,
  REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE,
  UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE,
  UPDATE_PROFILE_INTRO_ACTION_TYPE,
  LinkedInProfileService,
  createProfileActionExecutors,
  resolveProfileUrl,
  type LinkedInProfileRuntime
} from "../linkedinProfile.js";
import { TwoPhaseCommitService } from "../twoPhaseCommit.js";

function createTestRuntime(db: AssistantDatabase): LinkedInProfileRuntime {
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
      resolve: vi.fn((relativePath: string) => relativePath),
      registerArtifact: vi.fn()
    },
    confirmFailureArtifacts: {
      traceMaxBytes: 2 * 1024 * 1024
    },
    twoPhaseCommit: new TwoPhaseCommitService(db)
  } as unknown as LinkedInProfileRuntime;
}

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE).toBe(
      "profile.upsert_section_item"
    );
    expect(REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE).toBe(
      "profile.remove_section_item"
    );
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
  });
});

describe("createProfileActionExecutors", () => {
  it("registers all three profile action executors", () => {
    const executors = createProfileActionExecutors();

    expect(Object.keys(executors)).toHaveLength(3);
    expect(executors[UPDATE_PROFILE_INTRO_ACTION_TYPE]).toBeDefined();
    expect(executors[UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE]).toBeDefined();
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
});
