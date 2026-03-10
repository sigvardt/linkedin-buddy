import { describe, expect, it } from "vitest";
import {
  createProfileSeedPlan,
  parseProfileSeedSpec,
  type ProfileSeedSpec
} from "../src/profileSeed.js";

const baseEditableProfile = {
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
  sections: [
    {
      section: "about",
      label: "About",
      supported_fields: ["text"],
      can_add: true,
      items: []
    },
    {
      section: "certifications",
      label: "Licenses & certifications",
      supported_fields: [
        "name",
        "issuingOrganization",
        "issueMonth",
        "issueYear",
        "credentialId",
        "credentialUrl"
      ],
      can_add: true,
      items: [
        {
          item_id: "cert-1",
          section: "certifications",
          primary_text: "Old Cert",
          secondary_text: "Old Org",
          tertiary_text: "Issued 2020",
          description: "",
          raw_text: "Old Cert Old Org Issued 2020",
          source_id: null
        }
      ]
    }
  ],
  featured: {
    label: "Featured",
    can_add: true,
    can_remove: true,
    can_reorder: false,
    supported_kinds: ["link", "media", "post"],
    items: []
  }
} as const;

describe("profile seed planner", () => {
  it("parses supported sections and records unsupported fields", () => {
    const spec = parseProfileSeedSpec({
      intro: {
        firstName: "Avery",
        headline: "Automation Engineer at Example Labs",
        industry: "Software Development",
        customProfileUrl: "avery-cole-example"
      },
      about: "Building production LLM systems.",
      certifications: [
        {
          name: "Google Cloud Professional Machine Learning Engineer",
          issuingOrganization: "Google Cloud",
          issueMonth: "May",
          issueYear: "2024"
        }
      ],
      skills: ["TypeScript", "Python"]
    });

    expect(spec.intro).toMatchObject({
      firstName: "Avery",
      headline: "Automation Engineer at Example Labs"
    });
    expect(spec.settings).toMatchObject({
      industry: "Software Development"
    });
    expect(spec.about).toBe("Building production LLM systems.");
    expect(spec.publicProfile).toMatchObject({
      publicProfileUrl: "avery-cole-example"
    });
    expect(spec.sections.certifications).toHaveLength(1);
    expect(spec.unsupportedFields).toEqual([
      {
        path: "skills",
        reason: "Skills are not exposed by the current LinkedIn profile edit automation.",
        issueNumber: 228
      }
    ]);
  });

  it("includes unsupported field names in validation errors", () => {
    expect(() =>
      parseProfileSeedSpec({
        intro: {
          unknownField: "unexpected"
        }
      })
    ).toThrow('Unsupported intro field "unknownField" in profile seed spec.');
  });

  it("builds intro, about, upsert, and replace actions", () => {
    const spec = parseProfileSeedSpec({
      intro: {
        headline: "Automation Engineer at Example Labs",
        location: "Copenhagen, Capital Region of Denmark, Denmark",
        industry: "Software Development",
        customProfileUrl: "avery-cole-example"
      },
      about: "Building production LLM systems.",
      certifications: [],
      languages: [
        {
          name: "English",
          proficiency: "Full professional proficiency"
        }
      ]
    }) as ProfileSeedSpec;

    const plan = createProfileSeedPlan(baseEditableProfile, spec, {
      profileName: "smoke",
      operatorNote: "issue-210 test",
      replace: true
    });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      "update_intro",
      "update_settings",
      "update_public_profile",
      "upsert_section_item",
      "remove_section_item",
      "upsert_section_item"
    ]);
    expect(plan.actions[0]).toMatchObject({
      kind: "update_intro",
      input: {
        profileName: "smoke",
        headline: "Automation Engineer at Example Labs",
        location: "Copenhagen, Capital Region of Denmark, Denmark"
      }
    });
    expect(plan.actions[1]).toMatchObject({
      kind: "update_settings",
      input: {
        profileName: "smoke",
        industry: "Software Development"
      }
    });
    expect(plan.actions[2]).toMatchObject({
      kind: "update_public_profile",
      input: {
        profileName: "smoke",
        publicProfileUrl: "avery-cole-example"
      }
    });
    expect(plan.actions[3]).toMatchObject({
      kind: "upsert_section_item",
      input: {
        profileName: "smoke",
        section: "about",
        values: {
          text: "Building production LLM systems."
        }
      }
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "remove_section_item",
        input: expect.objectContaining({
          profileName: "smoke",
          section: "certifications",
          itemId: "cert-1"
        })
      })
    );
  });

  it("treats vanity and LinkedIn public profile URL forms as no-op equivalents", () => {
    for (const publicProfileUrl of [
      "avery-cole",
      "/in/avery-cole/",
      "https://www.linkedin.com/in/avery-cole/"
    ]) {
      const spec = parseProfileSeedSpec({
        publicProfile: {
          publicProfileUrl
        }
      }) as ProfileSeedSpec;

      const plan = createProfileSeedPlan(baseEditableProfile, spec, {
        profileName: "smoke",
        replace: false
      });

      expect(plan.actions).toEqual([]);
    }
  });
});
