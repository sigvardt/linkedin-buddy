import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  expectRateLimitPreview
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

// Minimal valid 1x1 transparent PNG (67 bytes)
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNl7BcQAAAABJRU5ErkJggg==";

/** Create a minimal valid PNG buffer with the given dimensions (1-bit grayscale, all white). */
function createMinimalPngBuffer(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i]!;
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const tag = Buffer.from(type, "ascii");
    const body = Buffer.concat([tag, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // color type: grayscale

  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc((1 + rowBytes) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (1 + rowBytes)] = 0; // filter = None

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// Featured item ID prefix used by the profile module
const FEATURED_ITEM_ID_PREFIX = "pfi_";

/**
 * Creates a synthetic featured item ID that passes decode validation.
 * Format: "pfi_" + base64url(JSON({v:1, kind, sourceId, url, title, subtitle, rawText}))
 */
function createSyntheticFeaturedItemId(kind: string, title: string): string {
  const payload = {
    v: 1,
    kind,
    sourceId: "",
    url: kind === "link" ? "https://example.com" : "",
    title,
    subtitle: "",
    rawText: title
  };
  return `${FEATURED_ITEM_ID_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

describe("Profile E2E", () => {
  const e2e = setupE2ESuite();
  let tempDir: string;
  let tempPngPath: string;
  let tempBannerPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "profile-e2e-"));
    tempPngPath = path.join(tempDir, "test-photo.png");
    writeFileSync(tempPngPath, Buffer.from(MINIMAL_PNG_BASE64, "base64"));
    tempBannerPath = path.join(tempDir, "test-banner.png");
    writeFileSync(tempBannerPath, createMinimalPngBuffer(1584, 396));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("view own profile returns all fields populated", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const profile = await runtime.profile.viewProfile({ target: "me" });

    expect(profile.full_name.length).toBeGreaterThan(0);
    expect(typeof profile.headline).toBe("string");
    expect(profile.profile_url).toContain("linkedin.com/in/");
    expect(typeof profile.about).toBe("string");
    expect(typeof profile.location).toBe("string");
    expect(typeof profile.connection_degree).toBe("string");
    expect(Array.isArray(profile.experience)).toBe(true);
    expect(Array.isArray(profile.education)).toBe(true);
  }, 60_000);

  it("view target profile returns experience and education arrays", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const profile = await runtime.profile.viewProfile({ target: "realsimonmiller" });

    expect(typeof profile.full_name).toBe("string");
    expect(profile.full_name.length).toBeGreaterThan(0);
    expect(profile.profile_url).toContain("/in/");
    expect(Array.isArray(profile.experience)).toBe(true);
    expect(Array.isArray(profile.education)).toBe(true);

    for (const item of profile.experience) {
      expect(typeof item.title).toBe("string");
      expect(typeof item.company).toBe("string");
    }

    for (const item of profile.education) {
      expect(typeof item.school).toBe("string");
    }
  }, 60_000);

  it("view own profile headline and location are non-empty", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const profile = await runtime.profile.viewProfile({ target: "me" });

    expect(profile.headline.trim().length).toBeGreaterThan(0);
    expect(profile.profile_url.startsWith("https://")).toBe(true);
  }, 60_000);

  it("view editable profile returns settings and public profile shapes", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const profile = await runtime.profile.viewEditableProfile();

    expect(profile.settings).toMatchObject({
      supported_fields: ["industry"]
    });
    expect(profile.public_profile).toMatchObject({
      supported_fields: expect.arrayContaining(["vanityName", "publicProfileUrl"])
    });
    expect(profile.featured).toMatchObject({
      can_add: expect.any(Boolean),
      can_remove: expect.any(Boolean),
      can_reorder: expect.any(Boolean),
      items: expect.any(Array)
    });
  }, 60_000);

  it("view editable profile returns intro with supported fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const profile = await runtime.profile.viewEditableProfile();

    expect(profile.profile_url).toContain("/in/");
    expect(profile.intro.full_name.length).toBeGreaterThan(0);
    expect(profile.intro.supported_fields).toContain("headline");
    expect(profile.intro.supported_fields).toContain("location");
  }, 60_000);

  it("view editable profile returns typed section entries", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const profile = await runtime.profile.viewEditableProfile();

    expect(Array.isArray(profile.sections)).toBe(true);
    expect(profile.sections.length).toBeGreaterThan(0);
    for (const section of profile.sections) {
      expect(typeof section.section).toBe("string");
      expect(typeof section.label).toBe("string");
      expect(Array.isArray(section.supported_fields)).toBe(true);
      expect(typeof section.can_add).toBe("boolean");
      expect(Array.isArray(section.items)).toBe(true);
    }
  }, 60_000);

  it("prepareUpdateIntro returns valid preview with rate limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareUpdateIntro({
      headline: "Acid Test Headline"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.update_intro");
    expect(prepared.preview.intro_updates).toHaveProperty("headline");
  }, 60_000);

  it("prepareUpdateSettings returns valid preview with rate limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareUpdateSettings({
      industry: "Technology, Information and Internet"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.update_settings");
  }, 60_000);

  it("prepareUpdatePublicProfile returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareUpdatePublicProfile({
      vanityName: "test-vanity-slug"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.update_public_profile");
    expect(prepared.preview.vanity_name).toBe("test-vanity-slug");
  }, 60_000);

  it("prepareUpsertSectionItem for experience returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareUpsertSectionItem({
      section: "experience",
      values: {
        title: "Software Engineer",
        company: "Acme Corp"
      }
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.upsert_section_item");
    expect(prepared.preview.mode).toBe("create");
    expect(prepared.preview.section).toBe("experience");
  }, 60_000);

  it("prepareUpsertSectionItem for education returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareUpsertSectionItem({
      section: "education",
      values: {
        school: "MIT",
        degree: "BSc Computer Science"
      }
    });

    expectPreparedAction(prepared);
    expect(prepared.preview.section).toBe("education");
  }, 60_000);

  it("prepareUploadPhoto returns valid preview with file metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = await runtime.profile.prepareUploadPhoto({
      filePath: tempPngPath
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.upload_photo");
    expect(prepared.preview.upload).toMatchObject({
      file_name: expect.any(String),
      size_bytes: expect.any(Number),
      sha256_prefix: expect.any(String)
    });
  }, 60_000);

  it("prepareUploadBanner returns valid preview with file metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = await runtime.profile.prepareUploadBanner({
      filePath: tempBannerPath
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.upload_banner");
  }, 60_000);

  it("prepareRemoveBanner returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = await runtime.profile.prepareRemoveBanner({});

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.remove_banner");
  }, 60_000);

  it("prepareFeaturedAdd for link returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const syntheticId = createSyntheticFeaturedItemId("link", "Test Article");
    const prepared = await runtime.profile.prepareFeaturedAdd({
      kind: "link",
      url: "https://example.com/article",
      title: "Test Article"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.featured_add");
    expect(syntheticId.startsWith(FEATURED_ITEM_ID_PREFIX)).toBe(true);
  }, 60_000);

  it("prepareAddSkill returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareAddSkill({
      skillName: "TypeScript"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.skill_add");
    expect(prepared.preview.skill_name).toBe("TypeScript");
  }, 60_000);

  it("prepareReorderSkills returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareReorderSkills({
      skillNames: ["TypeScript", "JavaScript", "Node.js"]
    });

    expectPreparedAction(prepared);
    expect(prepared.preview.skill_names).toEqual([
      "TypeScript",
      "JavaScript",
      "Node.js"
    ]);
  }, 60_000);

  it("prepareEndorseSkill returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareEndorseSkill({
      target: "realsimonmiller",
      skillName: "Product Management"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.profile.skill_endorse");
  }, 60_000);

  it("prepareRequestRecommendation returns valid preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareRequestRecommendation({
      target: "realsimonmiller"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.profile.recommendation_request"
    );
  }, 60_000);

  it("prepareWriteRecommendation returns valid preview with outbound text", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.profile.prepareWriteRecommendation({
      target: "realsimonmiller",
      text: "Outstanding collaborator with deep technical expertise."
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.profile.recommendation_write"
    );
    expect(prepared.preview.fields).toMatchObject({
      text: "Outstanding collaborator with deep technical expertise."
    });
  }, 60_000);

  it("prepareRemoveSectionItem throws without itemId or match for non-about section", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() =>
      runtime.profile.prepareRemoveSectionItem({ section: "experience" })
    ).toThrow(/requires itemId or match/i);
  }, 60_000);
});
