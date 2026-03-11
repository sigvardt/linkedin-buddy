import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { errors as playwrightErrors, type Locator, type Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantDatabase } from "../db/database.js";
import {
  ADD_PROFILE_FEATURED_ACTION_TYPE,
  ADD_PROFILE_SKILL_ACTION_TYPE,
  ENDORSE_PROFILE_SKILL_ACTION_TYPE,
  LINKEDIN_PROFILE_SECTION_TYPES,
  LINKEDIN_PROFILE_FEATURED_ITEM_KINDS,
  PROFILE_GLOBAL_ADD_SECTION_CONTROL,
  PROFILE_MEDIA_STRUCTURAL_SELECTORS,
  PROFILE_TOP_CARD_HEADING_SELECTORS,
  PROFILE_TOP_CARD_STRUCTURAL_SELECTORS,
  REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE,
  REMOVE_PROFILE_FEATURED_ACTION_TYPE,
  REORDER_PROFILE_FEATURED_ACTION_TYPE,
  REORDER_PROFILE_SKILLS_ACTION_TYPE,
  REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE,
  UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE,
  UPDATE_PROFILE_SETTINGS_ACTION_TYPE,
  UPLOAD_PROFILE_BANNER_ACTION_TYPE,
  UPLOAD_PROFILE_PHOTO_ACTION_TYPE,
  UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE,
  UPDATE_PROFILE_INTRO_ACTION_TYPE,
  WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE,
  LinkedInProfileService,
  createProfileActionExecutors,
  findIntroLocationFieldLocator,
  isProfileIntroEditHref,
  navigateToOwnProfile,
  resolveFirstVisibleLocator,
  resolveProfileUrl,
  splitProfileIntroLocationValue,
  type LinkedInProfileRuntime
} from "../linkedinProfile.js";
import { TwoPhaseCommitService } from "../twoPhaseCommit.js";
import { createAllowedRateLimiterStub } from "./rateLimiterTestUtils.js";

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
  const rateLimiter = createAllowedRateLimiterStub();

  return {
    auth: {
      ensureAuthenticated: vi.fn(async () => undefined)
    },
    cdpUrl: undefined,
    selectorLocale: "en",
    profileManager: {
      runWithContext: vi.fn()
    },
    rateLimiter: rateLimiter as unknown as LinkedInProfileRuntime["rateLimiter"],
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

class MockLocator {
  constructor(
    private readonly visibility: readonly boolean[],
    readonly resolvedIndex: number | null = null
  ) {}

  async count(): Promise<number> {
    return this.resolvedIndex === null ? this.visibility.length : 1;
  }

  nth(index: number): MockLocator {
    if (this.resolvedIndex !== null) {
      return this;
    }

    return new MockLocator(this.visibility, index);
  }

  async isVisible(): Promise<boolean> {
    const index = this.resolvedIndex ?? 0;
    return this.visibility[index] ?? false;
  }
}

class MockDialogFieldLocator {
  constructor(
    readonly label: string,
    readonly visible: boolean = true
  ) {}
}

class MockDialogQueryLocator {
  constructor(
    readonly fields: readonly MockDialogFieldLocator[],
    readonly resolvedIndex: number | null = null
  ) {}

  get resolvedLabel(): string | null {
    return this.fields[this.resolvedIndex ?? 0]?.label ?? null;
  }

  async count(): Promise<number> {
    return this.resolvedIndex === null ? this.fields.length : 1;
  }

  first(): MockDialogQueryLocator {
    if (this.resolvedIndex !== null) {
      return this;
    }

    return new MockDialogQueryLocator(this.fields, 0);
  }

  nth(index: number): MockDialogQueryLocator {
    if (this.resolvedIndex !== null) {
      return this;
    }

    return new MockDialogQueryLocator(this.fields, index);
  }

  locator(): MockDialogQueryLocator {
    return this;
  }

  async isVisible(): Promise<boolean> {
    return this.fields[this.resolvedIndex ?? 0]?.visible ?? false;
  }
}

class MockDialogLocator {
  constructor(private readonly fields: readonly MockDialogFieldLocator[]) {}

  getByLabel(labelMatcher: RegExp): MockDialogQueryLocator {
    return new MockDialogQueryLocator(
      this.fields.filter((field) => labelMatcher.test(field.label))
    );
  }

  getByRole(_role: string, options: { name?: RegExp } = {}): MockDialogQueryLocator {
    const labelMatcher = options.name ?? /.*/;

    return new MockDialogQueryLocator(
      this.fields.filter((field) => labelMatcher.test(field.label))
    );
  }

  getByText(labelMatcher: RegExp): MockDialogQueryLocator {
    return new MockDialogQueryLocator(
      this.fields.filter((field) => labelMatcher.test(field.label))
    );
  }

  locator(selector: string): MockDialogQueryLocator {
    const matches = Array.from(selector.matchAll(/"([^"]+)"/g));
    const rawAlias = matches.at(-1)?.[1] ?? "";
    const normalizedAlias = rawAlias.toLowerCase();

    return new MockDialogQueryLocator(
      this.fields.filter((field) => field.label.toLowerCase().includes(normalizedAlias))
    );
  }
}

function createNavigationMockPage(options: {
  canonicalUrl?: string | null;
  gotoError?: Error;
  headingVisible?: boolean;
  introEditVisible?: boolean;
  introEditPresent?: boolean;
  menuProfileUrl?: string | null;
  networkIdleError?: Error;
  ogProfileUrl?: string | null;
  title?: string;
  urlAfterGoto?: string;
}): Page {
  let currentUrl = "https://www.linkedin.com/feed/";

  return {
    goto: vi.fn(async (url: string) => {
      currentUrl = options.urlAfterGoto ?? url;

      if (options.gotoError) {
        throw options.gotoError;
      }
    }),
    locator: vi.fn((selector: string) => {
      const isIntroEditSelector =
        selector.includes("/edit/intro/") || selector.includes("/edit/forms/intro/");
      const isHeadingSelector = selector.includes("h1") || selector.includes("h2");
      const introEditCount =
        isIntroEditSelector && (options.introEditVisible || options.introEditPresent)
          ? 1
          : 0;
      const headingCount = isHeadingSelector && (options.headingVisible ?? false) ? 1 : 0;
      const visible =
        isHeadingSelector
          ? (options.headingVisible ?? false)
          : isIntroEditSelector
            ? (options.introEditVisible ?? false)
            : false;
      const attributeValue =
        selector === "a[data-control-name='nav.settings_view_profile']"
          ? options.menuProfileUrl
          : selector === "link[rel='canonical']"
            ? options.canonicalUrl
            : selector === "meta[property='og:url']"
              ? options.ogProfileUrl
              : null;

      const count = vi.fn(async () => (isHeadingSelector ? headingCount : introEditCount));
      const isVisible = vi.fn(async () => visible);
      const getAttribute = vi.fn(async () => attributeValue ?? null);
      const nth = vi.fn();
      const waitFor = vi.fn(async () => undefined);
      const first = vi.fn();
      const mockLocator = {
        count,
        first,
        getAttribute,
        isVisible,
        nth,
        waitFor
      } as unknown as Locator;
      first.mockReturnValue(mockLocator);
      nth.mockReturnValue(mockLocator);
      return mockLocator;
    }),
    title: vi.fn(async () => options.title ?? "LinkedIn"),
    url: vi.fn(() => currentUrl),
    waitForLoadState: vi.fn(async () => {
      if (options.networkIdleError) {
        throw options.networkIdleError;
      }
    })
  } as unknown as Page;
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

describe("isProfileIntroEditHref", () => {
  it("accepts the classic intro editor URL", () => {
    expect(
      isProfileIntroEditHref("/in/me/edit/intro/?profileFormEntryPoint=PROFILE_SECTION")
    ).toBe(true);
  });

  it("accepts the live self-profile intro editor page URL", () => {
    expect(
      isProfileIntroEditHref(
        "https://www.linkedin.com/in/joi-ascend-a534b73b6/edit/intro/"
      )
    ).toBe(true);
  });

  it("accepts the current intro form URL", () => {
    expect(
      isProfileIntroEditHref(
        "https://www.linkedin.com/in/me/edit/forms/intro/new/?profileFormEntryPoint=PROFILE_SECTION"
      )
    ).toBe(true);
  });

  it("rejects the job opportunities edit URL", () => {
    expect(
      isProfileIntroEditHref(
        "https://www.linkedin.com/in/me/opportunities/job-opportunities/edit/?jobOpportunitiesOrigin=PROFILE_TOP_CARD"
      )
    ).toBe(false);
  });

  it("rejects empty and unrelated URLs", () => {
    expect(isProfileIntroEditHref("")).toBe(false);
    expect(isProfileIntroEditHref("/in/me/overlay/contact-info/")).toBe(false);
    expect(isProfileIntroEditHref(undefined)).toBe(false);
  });
});

describe("resolveFirstVisibleLocator", () => {
  it("returns the first visible match even when the first locator match is hidden", async () => {
    const locator = new MockLocator([false, true, true]);

    const resolved = await resolveFirstVisibleLocator(locator as unknown as Locator);

    expect(resolved).not.toBeNull();
    expect((resolved as unknown as MockLocator).resolvedIndex).toBe(1);
  });

  it("scans beyond an initial batch of hidden matches", async () => {
    const locator = new MockLocator([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true
    ]);

    const resolved = await resolveFirstVisibleLocator(locator as unknown as Locator);

    expect(resolved).not.toBeNull();
    expect((resolved as unknown as MockLocator).resolvedIndex).toBe(8);
  });

  it("returns null when no locator match is visible", async () => {
    const locator = new MockLocator([false, false]);

    await expect(
      resolveFirstVisibleLocator(locator as unknown as Locator)
    ).resolves.toBeNull();
  });
});

describe("findIntroLocationFieldLocator", () => {
  it("prefers the live split city field over the country field", async () => {
    const dialog = new MockDialogLocator([
      new MockDialogFieldLocator("Country/Region*"),
      new MockDialogFieldLocator("City")
    ]);

    const locator = await findIntroLocationFieldLocator(dialog as unknown as Locator);

    expect(locator).not.toBeNull();
    expect((locator as unknown as MockDialogQueryLocator).resolvedLabel).toBe("City");
  });

  it("falls back to the classic single location label", async () => {
    const dialog = new MockDialogLocator([new MockDialogFieldLocator("Location")]);

    const locator = await findIntroLocationFieldLocator(dialog as unknown as Locator);

    expect(locator).not.toBeNull();
    expect((locator as unknown as MockDialogQueryLocator).resolvedLabel).toBe("Location");
  });
});

describe("splitProfileIntroLocationValue", () => {
  it("splits country and city for the current intro editor layout", () => {
    expect(splitProfileIntroLocationValue("Copenhagen, Denmark")).toEqual({
      city: "Copenhagen",
      countryOrRegion: "Denmark"
    });
  });

  it("keeps detailed locality text while peeling off the country", () => {
    expect(
      splitProfileIntroLocationValue(
        "2800, Copenhagen, Capital Region of Denmark, Denmark"
      )
    ).toEqual({
      city: "2800, Copenhagen, Capital Region of Denmark",
      countryOrRegion: "Denmark"
    });
  });

  it("leaves single-part locations untouched", () => {
    expect(splitProfileIntroLocationValue("Copenhagen")).toEqual({
      city: "Copenhagen",
      countryOrRegion: null
    });
  });
});

describe("navigateToOwnProfile", () => {
  it("recovers from /in/me/ navigation timeouts once self-only edit controls are present", async () => {
    const timeoutError = new playwrightErrors.TimeoutError("Navigation timeout");
    const page = createNavigationMockPage({
      gotoError: timeoutError,
      headingVisible: true,
      introEditPresent: true,
      urlAfterGoto: "https://www.linkedin.com/in/me/"
    });

    await expect(navigateToOwnProfile(page)).resolves.toBeUndefined();
    expect(page.goto).toHaveBeenCalledWith("https://www.linkedin.com/in/me/", {
      waitUntil: "domcontentloaded"
    });
    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 5_000
    });
  });

  it("recovers when LinkedIn resolves /in/me/ to the authenticated member vanity URL", async () => {
    const timeoutError = new playwrightErrors.TimeoutError("Navigation timeout");
    const page = createNavigationMockPage({
      canonicalUrl: "https://www.linkedin.com/in/joi-ascend/",
      gotoError: timeoutError,
      headingVisible: true,
      menuProfileUrl: "https://www.linkedin.com/in/joi-ascend/",
      urlAfterGoto: "https://www.linkedin.com/in/joi-ascend/"
    });

    await expect(navigateToOwnProfile(page)).resolves.toBeUndefined();
  });

  it("recovers on a resolved vanity URL when a self-only edit control is already visible", async () => {
    const timeoutError = new playwrightErrors.TimeoutError("Navigation timeout");
    const page = createNavigationMockPage({
      gotoError: timeoutError,
      introEditVisible: true,
      urlAfterGoto: "https://www.linkedin.com/in/joi-ascend/"
    });

    await expect(navigateToOwnProfile(page)).resolves.toBeUndefined();
  });

  it("rethrows /in/me/ timeouts when no self-profile signals are available", async () => {
    const timeoutError = new playwrightErrors.TimeoutError("Navigation timeout");
    const page = createNavigationMockPage({
      gotoError: timeoutError,
      title: "Feed | LinkedIn",
      urlAfterGoto: "https://www.linkedin.com/in/me/"
    });

    await expect(navigateToOwnProfile(page)).rejects.toBe(timeoutError);
  });

  it("rethrows /in/me/ timeouts when the profile metadata points to another member", async () => {
    const timeoutError = new playwrightErrors.TimeoutError("Navigation timeout");
    const page = createNavigationMockPage({
      canonicalUrl: "https://www.linkedin.com/in/someone-else/",
      gotoError: timeoutError,
      urlAfterGoto: "https://www.linkedin.com/in/me/"
    });

    await expect(navigateToOwnProfile(page)).rejects.toBe(timeoutError);
  });

  it("rethrows timeouts when the current page is another member profile", async () => {
    const timeoutError = new playwrightErrors.TimeoutError("Navigation timeout");
    const page = createNavigationMockPage({
      canonicalUrl: "https://www.linkedin.com/in/someone-else/",
      gotoError: timeoutError,
      menuProfileUrl: "https://www.linkedin.com/in/joi-ascend/",
      title: "Someone Else | LinkedIn",
      urlAfterGoto: "https://www.linkedin.com/in/someone-else/"
    });

    await expect(navigateToOwnProfile(page)).rejects.toBe(timeoutError);
  });

  it("rethrows timeouts when only hidden edit-control DOM is present on another page", async () => {
    const timeoutError = new playwrightErrors.TimeoutError("Navigation timeout");
    const page = createNavigationMockPage({
      gotoError: timeoutError,
      introEditPresent: true,
      urlAfterGoto: "https://www.linkedin.com/in/someone-else/"
    });

    await expect(navigateToOwnProfile(page)).rejects.toBe(timeoutError);
  });
});

describe("profile action type constants", () => {
  it("exposes the expected action type names", () => {
    expect(UPDATE_PROFILE_INTRO_ACTION_TYPE).toBe("profile.update_intro");
    expect(UPDATE_PROFILE_SETTINGS_ACTION_TYPE).toBe("profile.update_settings");
    expect(UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE).toBe(
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
    expect(ADD_PROFILE_SKILL_ACTION_TYPE).toBe("profile.skill_add");
    expect(REORDER_PROFILE_SKILLS_ACTION_TYPE).toBe("profile.skills_reorder");
    expect(ENDORSE_PROFILE_SKILL_ACTION_TYPE).toBe("profile.skill_endorse");
    expect(REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE).toBe(
      "profile.recommendation_request"
    );
    expect(WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE).toBe(
      "profile.recommendation_write"
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
    expect(LINKEDIN_PROFILE_SECTION_TYPES).not.toContain("featured");
    expect(LINKEDIN_PROFILE_FEATURED_ITEM_KINDS).toEqual(["link", "media", "post"]);
  });
});

describe("createProfileActionExecutors", () => {
  it("registers the profile action executors", () => {
    const executors = createProfileActionExecutors();

    expect(executors[UPDATE_PROFILE_INTRO_ACTION_TYPE]).toBeDefined();
    expect(executors[UPDATE_PROFILE_SETTINGS_ACTION_TYPE]).toBeDefined();
    expect(executors[UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE]).toBeDefined();
    expect(executors[UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE]).toBeDefined();
    expect(executors[UPLOAD_PROFILE_PHOTO_ACTION_TYPE]).toBeDefined();
    expect(executors[UPLOAD_PROFILE_BANNER_ACTION_TYPE]).toBeDefined();
    expect(executors[ADD_PROFILE_FEATURED_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_PROFILE_FEATURED_ACTION_TYPE]).toBeDefined();
    expect(executors[REORDER_PROFILE_FEATURED_ACTION_TYPE]).toBeDefined();
    expect(executors[ADD_PROFILE_SKILL_ACTION_TYPE]).toBeDefined();
    expect(executors[REORDER_PROFILE_SKILLS_ACTION_TYPE]).toBeDefined();
    expect(executors[ENDORSE_PROFILE_SKILL_ACTION_TYPE]).toBeDefined();
    expect(executors[REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE]).toBeDefined();
    expect(executors[WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE]).toBeDefined();
  });

  it("exposes execute methods for each profile action executor", () => {
    const executors = createProfileActionExecutors();

    for (const executor of Object.values(executors)) {
      expect(typeof executor.execute).toBe("function");
    }
  });

  it("keeps structural fallbacks for the current profile media edit controls", () => {
    expect(PROFILE_MEDIA_STRUCTURAL_SELECTORS.photo).toContain(
      "button.profile-photo-edit__edit-btn"
    );
    expect(PROFILE_MEDIA_STRUCTURAL_SELECTORS.photo).toContain(".profile-photo-edit button");
    expect(PROFILE_MEDIA_STRUCTURAL_SELECTORS.banner).toContain(
      "[id^='cover-photo-dropdown-button-trigger-']"
    );
  });

  it("keeps selector fallbacks for the current self-profile top card", () => {
    expect(PROFILE_TOP_CARD_HEADING_SELECTORS).toContain("h2");
    expect(PROFILE_TOP_CARD_STRUCTURAL_SELECTORS).toContain(
      "section[componentkey*='topcard' i]"
    );
    expect(PROFILE_TOP_CARD_STRUCTURAL_SELECTORS).toContain(
      "div[componentkey*='topcard' i]"
    );
  });

  it("keeps selector fallbacks for the current self-profile add section control", () => {
    expect(PROFILE_GLOBAL_ADD_SECTION_CONTROL.labels.en).toContain(
      "Add profile section"
    );
    expect(PROFILE_GLOBAL_ADD_SECTION_CONTROL.labels.en).toContain("Add section");
    expect(PROFILE_GLOBAL_ADD_SECTION_CONTROL.roles).toContain("button");
    expect(PROFILE_GLOBAL_ADD_SECTION_CONTROL.roles).toContain("link");
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
          },
          rate_limit: {
            counter_key: "linkedin.profile.update_intro"
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

  it("prepares custom public profile URL updates", () => {
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
          summary: "Update LinkedIn public profile URL",
          vanity_name: "avery-cole-example",
          public_profile_url: "https://www.linkedin.com/in/avery-cole-example/"
        }
      });
    } finally {
      db.close();
    }
  });

  it("accepts a full LinkedIn profile URL when preparing a custom public profile URL update", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareUpdatePublicProfile({
        profileName: "default",
        publicProfileUrl: "https://www.linkedin.com/in/avery-cole-example/"
      });

      expect(prepared.preview).toMatchObject({
        vanity_name: "avery-cole-example",
        public_profile_url: "https://www.linkedin.com/in/avery-cole-example/"
      });
    } finally {
      db.close();
    }
  });

  it("accepts the customProfileUrl alias when preparing a custom public profile URL update", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareUpdatePublicProfile({
        profileName: "default",
        customProfileUrl: "https://www.linkedin.com/in/avery-cole-example/"
      });

      expect(prepared.preview).toMatchObject({
        vanity_name: "avery-cole-example",
        public_profile_url: "https://www.linkedin.com/in/avery-cole-example/"
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

  it("prepares skill additions", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareAddSkill({
        profileName: "default",
        skillName: "TypeScript"
      });

      expect(prepared.preview).toMatchObject({
        summary: 'Add "TypeScript" to LinkedIn profile skills',
        target: {
          profile_name: "default"
        },
        skill_name: "TypeScript"
      });
    } finally {
      db.close();
    }
  });

  it("prepares skill reorder requests", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareReorderSkills({
        profileName: "default",
        skillNames: ["TypeScript", "Playwright"]
      });

      expect(prepared.preview).toMatchObject({
        summary: "Reorder LinkedIn skills (2)",
        target: {
          profile_name: "default"
        },
        skill_names: ["TypeScript", "Playwright"]
      });
    } finally {
      db.close();
    }
  });

  it("prepares skill endorsements against another profile", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareEndorseSkill({
        profileName: "default",
        target: "realsimonmiller",
        skillName: "JavaScript"
      });

      expect(prepared.preview).toMatchObject({
        summary: 'Endorse "JavaScript" on a LinkedIn profile',
        target: {
          profile_name: "default",
          target_profile: "realsimonmiller",
          target_profile_url: "https://www.linkedin.com/in/realsimonmiller/"
        },
        skill_name: "JavaScript"
      });
    } finally {
      db.close();
    }
  });

  it("prepares recommendation requests with optional dialog fields", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareRequestRecommendation({
        profileName: "default",
        target: "realsimonmiller",
        relationship: "colleague",
        message: "Would love a short recommendation when you have time."
      });

      expect(prepared.preview).toMatchObject({
        summary: "Request a LinkedIn recommendation",
        target: {
          profile_name: "default",
          target_profile: "realsimonmiller",
          target_profile_url: "https://www.linkedin.com/in/realsimonmiller/"
        },
        fields: {
          relationship: "colleague",
          message: "Would love a short recommendation when you have time."
        }
      });
    } finally {
      db.close();
    }
  });

  it("requires text when preparing written recommendations", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));

      expect(() =>
        service.prepareWriteRecommendation({
          profileName: "default",
          target: "realsimonmiller",
          text: " "
        })
      ).toThrow("text is required");
    } finally {
      db.close();
    }
  });

  it("prepares written recommendations", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      const service = new LinkedInProfileService(createTestRuntime(db));
      const prepared = service.prepareWriteRecommendation({
        profileName: "default",
        target: "realsimonmiller",
        relationship: "colleague",
        text: "A thoughtful collaborator who consistently follows through."
      });

      expect(prepared.preview).toMatchObject({
        summary: "Write a LinkedIn recommendation",
        target: {
          profile_name: "default",
          target_profile: "realsimonmiller",
          target_profile_url: "https://www.linkedin.com/in/realsimonmiller/"
        },
        fields: {
          relationship: "colleague",
          text: "A thoughtful collaborator who consistently follows through."
        },
        rate_limit: {
          counter_key: "linkedin.profile.recommendation_write"
        }
      });
    } finally {
      db.close();
    }
  });
});
