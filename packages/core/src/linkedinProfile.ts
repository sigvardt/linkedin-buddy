import { createHash } from "node:crypto";
import { type BrowserContext, type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import { getLinkedInSelectorPhrases } from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  PreparedActionResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

export interface LinkedInExperience {
  title: string;
  company: string;
  duration: string;
  location: string;
  description: string;
}

export interface LinkedInEducation {
  school: string;
  degree: string;
  field_of_study: string;
  dates: string;
}

export interface LinkedInProfile {
  profile_url: string;
  vanity_name: string | null;
  full_name: string;
  headline: string;
  location: string;
  about: string;
  connection_degree: string;
  experience: LinkedInExperience[];
  education: LinkedInEducation[];
}

export interface ViewProfileInput {
  profileName?: string;
  target?: string;
}

interface LinkedInProfileRuntimeBase {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
}

export const UPDATE_PROFILE_INTRO_ACTION_TYPE = "profile.update_intro";
export const UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE =
  "profile.upsert_section_item";
export const REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE =
  "profile.remove_section_item";

export const LINKEDIN_PROFILE_SECTION_TYPES = [
  "about",
  "experience",
  "education",
  "certifications",
  "languages",
  "projects",
  "volunteer_experience",
  "honors_awards"
] as const;

export type LinkedInProfileSectionType =
  (typeof LINKEDIN_PROFILE_SECTION_TYPES)[number];

type EditableControlType = "text" | "textarea" | "checkbox" | "select";

type IntroFieldKey = "firstName" | "lastName" | "headline" | "location";

interface EditableFieldDefinition {
  key: string;
  aliases: readonly string[];
  control: EditableControlType;
}

export interface LinkedInProfileEditableIntro {
  full_name: string;
  headline: string;
  location: string;
  supported_fields: IntroFieldKey[];
}

export interface LinkedInProfileEditableSectionItem {
  item_id: string;
  section: LinkedInProfileSectionType;
  primary_text: string;
  secondary_text: string;
  tertiary_text: string;
  description: string;
  raw_text: string;
  source_id: string | null;
}

export interface LinkedInProfileEditableSection {
  section: LinkedInProfileSectionType;
  label: string;
  supported_fields: string[];
  can_add: boolean;
  items: LinkedInProfileEditableSectionItem[];
}

export interface LinkedInEditableProfile {
  profile_url: string;
  intro: LinkedInProfileEditableIntro;
  sections: LinkedInProfileEditableSection[];
}

export interface ViewEditableProfileInput {
  profileName?: string;
}

export interface LinkedInProfileSectionItemMatch {
  sourceId?: string;
  primaryText?: string;
  secondaryText?: string;
  tertiaryText?: string;
  rawText?: string;
}

export interface PrepareUpdateIntroInput {
  profileName?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  location?: string;
  operatorNote?: string;
}

export interface PrepareUpsertSectionItemInput {
  profileName?: string;
  section: LinkedInProfileSectionType | string;
  itemId?: string;
  match?: LinkedInProfileSectionItemMatch | Record<string, unknown>;
  values: Record<string, unknown>;
  operatorNote?: string;
}

export interface PrepareRemoveSectionItemInput {
  profileName?: string;
  section: LinkedInProfileSectionType | string;
  itemId?: string;
  match?: LinkedInProfileSectionItemMatch | Record<string, unknown>;
  operatorNote?: string;
}

export interface LinkedInProfileExecutorRuntime
  extends LinkedInProfileRuntimeBase {
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInProfileRuntime extends LinkedInProfileExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInProfileExecutorRuntime>,
    "prepare"
  >;
}

interface ExtractedEditableSectionItem {
  source_id: string | null;
  primary_text: string;
  secondary_text: string;
  tertiary_text: string;
  description: string;
  raw_text: string;
}

interface DecodedProfileSectionItemId {
  section: LinkedInProfileSectionType;
  sourceId?: string;
  primaryText?: string;
  secondaryText?: string;
  tertiaryText?: string;
  rawText?: string;
}

type NormalizedEditableValue = string | boolean;

const PROFILE_SECTION_ITEM_ID_PREFIX = "psi_";

const PROFILE_ACTION_LABELS = {
  add: {
    en: ["Add"],
    da: ["Tilføj"]
  },
  addProfileSection: {
    en: ["Add profile section"],
    da: ["Tilføj profilsektion"]
  },
  edit: {
    en: ["Edit"],
    da: ["Rediger"]
  },
  delete: {
    en: ["Delete", "Remove"],
    da: ["Slet", "Fjern"]
  },
  more: {
    en: ["More", "More actions"],
    da: ["Mere", "Flere handlinger"]
  },
  save: {
    en: ["Save", "Done"],
    da: ["Gem", "Færdig", "Udført"]
  },
  close: {
    en: ["Close", "Dismiss"],
    da: ["Luk"]
  }
} as const;

const PROFILE_SECTION_LABELS: Record<
  LinkedInProfileSectionType,
  Record<LinkedInSelectorLocale, readonly string[]>
> = {
  about: {
    en: ["About"],
    da: ["Om"]
  },
  experience: {
    en: ["Experience"],
    da: ["Erfaring"]
  },
  education: {
    en: ["Education"],
    da: ["Uddannelse"]
  },
  certifications: {
    en: [
      "Licenses & certifications",
      "Licenses and certifications",
      "Certifications"
    ],
    da: ["Licenser og certificeringer", "Certificeringer"]
  },
  languages: {
    en: ["Languages"],
    da: ["Sprog"]
  },
  projects: {
    en: ["Projects"],
    da: ["Projekter"]
  },
  volunteer_experience: {
    en: ["Volunteer experience", "Volunteering"],
    da: ["Frivilligt arbejde"]
  },
  honors_awards: {
    en: ["Honors & awards", "Honours & awards", "Awards"],
    da: ["Udmærkelser og priser", "Priser"]
  }
};

const PROFILE_INTRO_FIELD_DEFINITIONS: readonly EditableFieldDefinition[] = [
  {
    key: "firstName",
    aliases: ["firstName", "first_name", "First name", "Fornavn"],
    control: "text"
  },
  {
    key: "lastName",
    aliases: ["lastName", "last_name", "Last name", "Efternavn"],
    control: "text"
  },
  {
    key: "headline",
    aliases: ["headline", "Headline", "Overskrift"],
    control: "text"
  },
  {
    key: "location",
    aliases: ["location", "Location", "Lokation", "By"],
    control: "text"
  }
] as const;

const PROFILE_SECTION_FIELD_DEFINITIONS: Record<
  LinkedInProfileSectionType,
  readonly EditableFieldDefinition[]
> = {
  about: [
    {
      key: "text",
      aliases: ["text", "about", "summary", "description", "Om", "Beskrivelse"],
      control: "textarea"
    }
  ],
  experience: [
    {
      key: "title",
      aliases: ["title", "Title", "Titel"],
      control: "text"
    },
    {
      key: "company",
      aliases: [
        "company",
        "Company",
        "Company or organization",
        "Virksomhed",
        "Virksomhed eller organisation"
      ],
      control: "text"
    },
    {
      key: "location",
      aliases: ["location", "Location", "Lokation"],
      control: "text"
    },
    {
      key: "description",
      aliases: ["description", "Description", "Beskrivelse"],
      control: "textarea"
    },
    {
      key: "employmentType",
      aliases: ["employmentType", "Employment type", "Ansættelsestype"],
      control: "select"
    },
    {
      key: "currentlyWorkingHere",
      aliases: [
        "currentlyWorkingHere",
        "current",
        "I am currently working in this role",
        "I currently work here",
        "Jeg arbejder i øjeblikket i denne rolle"
      ],
      control: "checkbox"
    },
    {
      key: "startMonth",
      aliases: ["startMonth", "Start month", "Startmåned"],
      control: "select"
    },
    {
      key: "startYear",
      aliases: ["startYear", "Start year", "Startår"],
      control: "text"
    },
    {
      key: "endMonth",
      aliases: ["endMonth", "End month", "Slutmåned"],
      control: "select"
    },
    {
      key: "endYear",
      aliases: ["endYear", "End year", "Slutår"],
      control: "text"
    }
  ],
  education: [
    {
      key: "school",
      aliases: ["school", "School", "Skole"],
      control: "text"
    },
    {
      key: "degree",
      aliases: ["degree", "Degree", "Grad"],
      control: "text"
    },
    {
      key: "fieldOfStudy",
      aliases: ["fieldOfStudy", "field_of_study", "Field of study", "Studieretning"],
      control: "text"
    },
    {
      key: "description",
      aliases: ["description", "Description", "Beskrivelse"],
      control: "textarea"
    },
    {
      key: "startMonth",
      aliases: ["startMonth", "Start month", "Startmåned"],
      control: "select"
    },
    {
      key: "startYear",
      aliases: ["startYear", "Start year", "Startår"],
      control: "text"
    },
    {
      key: "endMonth",
      aliases: ["endMonth", "End month", "Slutmåned"],
      control: "select"
    },
    {
      key: "endYear",
      aliases: ["endYear", "End year", "Slutår"],
      control: "text"
    }
  ],
  certifications: [
    {
      key: "name",
      aliases: ["name", "Name", "Navn"],
      control: "text"
    },
    {
      key: "issuingOrganization",
      aliases: [
        "issuingOrganization",
        "issuing_organization",
        "Issuing organization",
        "Udstedende organisation"
      ],
      control: "text"
    },
    {
      key: "issueMonth",
      aliases: ["issueMonth", "Issue month", "Udstedelsesmåned"],
      control: "select"
    },
    {
      key: "issueYear",
      aliases: ["issueYear", "Issue year", "Udstedelsesår"],
      control: "text"
    },
    {
      key: "credentialId",
      aliases: ["credentialId", "credential_id", "Credential ID"],
      control: "text"
    },
    {
      key: "credentialUrl",
      aliases: ["credentialUrl", "credential_url", "Credential URL"],
      control: "text"
    }
  ],
  languages: [
    {
      key: "name",
      aliases: ["name", "language", "Language", "Sprog"],
      control: "text"
    },
    {
      key: "proficiency",
      aliases: ["proficiency", "Proficiency", "Færdighedsniveau"],
      control: "select"
    }
  ],
  projects: [
    {
      key: "title",
      aliases: ["title", "name", "Project name", "Name", "Navn"],
      control: "text"
    },
    {
      key: "url",
      aliases: ["url", "projectUrl", "project_url", "Project URL"],
      control: "text"
    },
    {
      key: "description",
      aliases: ["description", "Description", "Beskrivelse"],
      control: "textarea"
    },
    {
      key: "startMonth",
      aliases: ["startMonth", "Start month", "Startmåned"],
      control: "select"
    },
    {
      key: "startYear",
      aliases: ["startYear", "Start year", "Startår"],
      control: "text"
    },
    {
      key: "endMonth",
      aliases: ["endMonth", "End month", "Slutmåned"],
      control: "select"
    },
    {
      key: "endYear",
      aliases: ["endYear", "End year", "Slutår"],
      control: "text"
    }
  ],
  volunteer_experience: [
    {
      key: "role",
      aliases: ["role", "Role", "Rolle"],
      control: "text"
    },
    {
      key: "organization",
      aliases: [
        "organization",
        "Organisation",
        "Organization",
        "Virksomhed eller organisation"
      ],
      control: "text"
    },
    {
      key: "cause",
      aliases: ["cause", "Cause", "Sag"],
      control: "select"
    },
    {
      key: "description",
      aliases: ["description", "Description", "Beskrivelse"],
      control: "textarea"
    },
    {
      key: "startMonth",
      aliases: ["startMonth", "Start month", "Startmåned"],
      control: "select"
    },
    {
      key: "startYear",
      aliases: ["startYear", "Start year", "Startår"],
      control: "text"
    },
    {
      key: "endMonth",
      aliases: ["endMonth", "End month", "Slutmåned"],
      control: "select"
    },
    {
      key: "endYear",
      aliases: ["endYear", "End year", "Slutår"],
      control: "text"
    }
  ],
  honors_awards: [
    {
      key: "title",
      aliases: ["title", "Title", "Titel"],
      control: "text"
    },
    {
      key: "issuer",
      aliases: ["issuer", "Issuer", "Udsteder"],
      control: "text"
    },
    {
      key: "issueMonth",
      aliases: ["issueMonth", "Issue month", "Udstedelsesmåned"],
      control: "select"
    },
    {
      key: "issueYear",
      aliases: ["issueYear", "Issue year", "Udstedelsesår"],
      control: "text"
    },
    {
      key: "description",
      aliases: ["description", "Description", "Beskrivelse"],
      control: "textarea"
    }
  ]
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function resolveProfileUrl(target: string | undefined): string {
  const trimmedTarget = normalizeText(target);
  if (!trimmedTarget || trimmedTarget.toLowerCase() === "me") {
    return "https://www.linkedin.com/in/me/";
  }

  if (isAbsoluteUrl(trimmedTarget)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedTarget);
    } catch (error) {
      throw asLinkedInAssistantError(
        error,
        "ACTION_PRECONDITION_FAILED",
        "Profile URL must be a valid URL."
      );
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const isLinkedInDomain =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    if (!isLinkedInDomain || !parsedUrl.pathname.startsWith("/in/")) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Profile URL must point to linkedin.com/in/.",
        { target: trimmedTarget }
      );
    }

    return trimmedTarget;
  }

  if (trimmedTarget.startsWith("/in/")) {
    return `https://www.linkedin.com${trimmedTarget}`;
  }

  return `https://www.linkedin.com/in/${encodeURIComponent(trimmedTarget)}/`;
}

export function normalizeLinkedInProfileUrl(target: string): string {
  const resolved = resolveProfileUrl(target);

  try {
    const parsedUrl = new URL(resolved);
    parsedUrl.search = "";
    parsedUrl.hash = "";

    const pathname = parsedUrl.pathname.endsWith("/")
      ? parsedUrl.pathname
      : `${parsedUrl.pathname}/`;

    return `${parsedUrl.origin}${pathname}`;
  } catch {
    return resolved;
  }
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

/* eslint-disable no-undef -- DOM types (ParentNode, Element) are valid inside page.evaluate() */
async function extractProfileData(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<LinkedInProfile> {
  const extracted = await page.evaluate((sectionLabels) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const emptyProfile = {
      profile_url: globalThis.window.location.href,
      vanity_name: null,
      full_name: "",
      headline: "",
      location: "",
      about: "",
      connection_degree: "",
      experience: [],
      education: []
    };

    const pickText = (
      selectors: string[],
      root: ParentNode = globalThis.document
    ): string => {
      for (const selector of selectors) {
        const text = normalize(root.querySelector(selector)?.textContent);
        if (text) {
          return text;
        }
      }
      return "";
    };

    const pickList = (
      selectors: string[],
      root: ParentNode = globalThis.document
    ): string[] => {
      for (const selector of selectors) {
        const values = Array.from(root.querySelectorAll(selector))
          .map((node) => normalize(node.textContent))
          .filter((value) => value.length > 0);
        if (values.length > 0) {
          return values;
        }
      }
      return [];
    };

    const includesAnyLabel = (
      value: string,
      labels: string[]
    ): boolean => {
      const normalizedValue = normalize(value).toLowerCase();
      return labels.some((label) => normalizedValue.includes(normalize(label).toLowerCase()));
    };

    const findSectionRoot = (id: string, labels: string[]): Element | null => {
      const byId = globalThis.document.querySelector(`#${id}`);
      if (byId) {
        return byId.closest("section") ?? byId;
      }

      const sections = Array.from(
        globalThis.document.querySelectorAll("section, div.pv-profile-card")
      );
      for (const section of sections) {
        const heading = normalize(
          section.querySelector("h2, h3, .pvs-header__title")?.textContent
        );
        if (includesAnyLabel(heading, labels)) {
          return section;
        }
      }

      return null;
    };

    const collectSectionItems = (sectionRoot: Element | null): Element[] => {
      if (!sectionRoot) {
        return [];
      }

      const itemSelectors = [
        ".pvs-list__paged-list-item",
        ".pvs-list__item--line-separated",
        "li.artdeco-list__item",
        "li[class*='pvs-list__item']"
      ];
      for (const selector of itemSelectors) {
        const items = Array.from(sectionRoot.querySelectorAll(selector));
        if (items.length > 0) {
          return items;
        }
      }

      return Array.from(sectionRoot.querySelectorAll("li"));
    };

    const textLooksLikeDuration = (value: string): boolean =>
      /\b(present|\d+\s*(?:yr|yrs|year|years|mo|mos|month|months))\b/i.test(
        value
      );

    try {
      const vanityMatch = /\/in\/([^/]+)/.exec(
        globalThis.window.location.pathname
      );
      const vanityNameRaw = vanityMatch?.[1];
      let vanityName: string | null = null;
      if (vanityNameRaw) {
        try {
          vanityName = decodeURIComponent(vanityNameRaw);
        } catch {
          vanityName = vanityNameRaw;
        }
      }

      const nameSelectors = [
        "h1.text-heading-xlarge",
        "h1[class*='text-heading']",
        "h1"
      ];
      const fullName = pickText(nameSelectors);
      const nameElement =
        globalThis.document.querySelector("h1.text-heading-xlarge") ??
        globalThis.document.querySelector("h1[class*='text-heading']") ??
        globalThis.document.querySelector("h1");
      const headerContainer =
        nameElement?.closest(".pv-text-details__left-panel") ??
        nameElement?.parentElement?.parentElement ??
        nameElement?.closest("section") ??
        globalThis.document;

      let headline = pickText(
        [
          ".text-body-medium[data-anonymize='headline']",
          ".text-body-medium"
        ],
        headerContainer
      );
      if (!headline) {
        headline = pickText([
          ".text-body-medium[data-anonymize='headline']",
          ".text-body-medium"
        ]);
      }

      let location = pickText(
        [
          "span.text-body-small[data-anonymize='location']",
          ".text-body-small.inline"
        ],
        headerContainer
      );
      if (!location) {
        location = pickText([
          "span.text-body-small[data-anonymize='location']",
          ".text-body-small.inline"
        ]);
      }

      let about = pickText([
        "#about .inline-show-more-text span[aria-hidden='true']",
        "#about .inline-show-more-text",
        "#about ~ .display-flex .inline-show-more-text span[aria-hidden='true']",
        "#about ~ .display-flex .inline-show-more-text"
      ]);

      if (!about) {
        const sections = Array.from(
          globalThis.document.querySelectorAll("section, div")
        );
        for (const section of sections) {
          const heading = normalize(
            section.querySelector("h2, h3, .pvs-header__title")?.textContent
          );
          if (!heading || !includesAnyLabel(heading, sectionLabels.about)) {
            continue;
          }

          about = pickText(
            [
              ".inline-show-more-text span[aria-hidden='true']",
              ".inline-show-more-text",
              ".pv-shared-text-with-see-more",
              "p"
            ],
            section
          );
          if (about) {
            break;
          }
        }
      }

      let connectionDegree = pickText([
        ".dist-value",
        ".distance-badge",
        "[class*='distance']"
      ]);

      if (!connectionDegree) {
        const bodyText = normalize(globalThis.document.body?.textContent);
        const degreeMatch = /\b(1st|2nd|3rd\+?)\b/i.exec(bodyText);
        connectionDegree = degreeMatch ? normalize(degreeMatch[1]) : "";
      }

      const experienceSection = findSectionRoot(
        "experience",
        sectionLabels.experience
      );
      const experience = collectSectionItems(experienceSection)
        .map((item) => {
          const lines = pickList(
            [
              ".t-bold span[aria-hidden='true']",
              ".t-normal span[aria-hidden='true']",
              ".pvs-entity__caption-wrapper span[aria-hidden='true']",
              ".pvs-entity__description-wrapper span[aria-hidden='true']",
              ".inline-show-more-text span[aria-hidden='true']"
            ],
            item
          );

          const title =
            pickText(
              [
                ".t-bold span[aria-hidden='true']",
                ".t-bold",
                "[data-field='title']"
              ],
              item
            ) ?? "";
          const company =
            pickText(
              [
                ".t-normal span[aria-hidden='true']",
                ".pv-entity__secondary-title",
                "[data-field='company']"
              ],
              item
            ) ?? "";
          let duration = pickText(
            [
              ".pvs-entity__caption-wrapper[aria-hidden='true']",
              ".pv-entity__date-range span:nth-child(2)",
              "[data-field='date-range']"
            ],
            item
          );
          if (!duration) {
            duration =
              lines.find((line) => textLooksLikeDuration(line) && line !== company) ??
              "";
          }

          let itemLocation = pickText(
            [
              ".pvs-entity__caption-wrapper + .pvs-entity__caption-wrapper span[aria-hidden='true']",
              ".pv-entity__location span:nth-child(2)",
              "[data-field='location']"
            ],
            item
          );
          if (!itemLocation) {
            itemLocation =
              lines.find(
                (line) =>
                  line !== title &&
                  line !== company &&
                  line !== duration &&
                  !textLooksLikeDuration(line)
              ) ?? "";
          }

          const description = pickText(
            [
              ".pvs-entity__description-wrapper span[aria-hidden='true']",
              ".inline-show-more-text span[aria-hidden='true']",
              ".inline-show-more-text"
            ],
            item
          );

          return {
            title,
            company,
            duration,
            location: itemLocation,
            description
          };
        })
        .filter(
          (item) =>
            item.title ||
            item.company ||
            item.duration ||
            item.location ||
            item.description
        );

      const educationSection = findSectionRoot(
        "education",
        sectionLabels.education
      );
      const education = collectSectionItems(educationSection)
        .map((item) => {
          const lines = pickList(
            [
              ".t-bold span[aria-hidden='true']",
              ".t-normal span[aria-hidden='true']",
              ".pvs-entity__caption-wrapper span[aria-hidden='true']"
            ],
            item
          );

          const school =
            pickText(
              [
                ".t-bold span[aria-hidden='true']",
                ".pv-entity__school-name",
                "[data-field='school']"
              ],
              item
            ) ?? "";
          const degree =
            pickText(
              [
                ".t-normal span[aria-hidden='true']",
                ".pv-entity__degree-name span:nth-child(2)",
                "[data-field='degree']"
              ],
              item
            ) ?? "";
          const fieldOfStudy =
            pickText(
              [".pv-entity__fos span:nth-child(2)", "[data-field='field_of_study']"],
              item
            ) ?? "";
          let dates = pickText(
            [
              ".pvs-entity__caption-wrapper[aria-hidden='true']",
              ".pv-entity__dates span:nth-child(2)",
              "[data-field='dates']"
            ],
            item
          );
          if (!dates) {
            dates = lines.find(textLooksLikeDuration) ?? "";
          }

          return {
            school,
            degree,
            field_of_study: fieldOfStudy,
            dates
          };
        })
        .filter((item) => item.school || item.degree || item.field_of_study || item.dates);

      return {
        profile_url: globalThis.window.location.href,
        vanity_name: vanityName,
        full_name: fullName,
        headline,
        location,
        about,
        connection_degree: connectionDegree,
        experience,
        education
      };
    } catch {
      return emptyProfile;
    }
  }, {
    about: getLinkedInSelectorPhrases("about", selectorLocale),
    experience: getLinkedInSelectorPhrases("experience", selectorLocale),
    education: getLinkedInSelectorPhrases("education", selectorLocale)
  });

  return {
    profile_url: normalizeText(extracted.profile_url),
    vanity_name: extracted.vanity_name
      ? normalizeText(extracted.vanity_name)
      : null,
    full_name: normalizeText(extracted.full_name),
    headline: normalizeText(extracted.headline),
    location: normalizeText(extracted.location),
    about: normalizeText(extracted.about),
    connection_degree: normalizeText(extracted.connection_degree),
    experience: extracted.experience.map((item) => ({
      title: normalizeText(item.title),
      company: normalizeText(item.company),
      duration: normalizeText(item.duration),
      location: normalizeText(item.location),
      description: normalizeText(item.description)
    })),
    education: extracted.education.map((item) => ({
      school: normalizeText(item.school),
      degree: normalizeText(item.degree),
      field_of_study: normalizeText(item.field_of_study),
      dates: normalizeText(item.dates)
    }))
  };
}
/* eslint-enable no-undef */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function normalizeFieldKey(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildTextRegex(labels: readonly string[], exact = false): RegExp {
  const normalizedLabels = dedupeStrings(labels);
  const pattern = normalizedLabels.map((label) => escapeRegExp(label)).join("|");
  return new RegExp(exact ? `^(?:${pattern})$` : `(?:${pattern})`, "i");
}

function buildAriaLabelContainsSelector(
  tagName: string,
  labels: readonly string[]
): string {
  return dedupeStrings(labels)
    .map(
      (label) =>
        `${tagName}[aria-label*="${escapeCssAttributeValue(label)}" i]`
    )
    .join(", ");
}

function getLocalizedLabels(
  labels: Record<LinkedInSelectorLocale, readonly string[]>,
  locale: LinkedInSelectorLocale
): string[] {
  return dedupeStrings([...(labels[locale] ?? labels.en), ...labels.en]);
}

function getUiActionLabels(
  action: keyof typeof PROFILE_ACTION_LABELS,
  locale: LinkedInSelectorLocale
): string[] {
  return getLocalizedLabels(PROFILE_ACTION_LABELS[action], locale);
}

function getSectionLabels(
  section: LinkedInProfileSectionType,
  locale: LinkedInSelectorLocale
): string[] {
  return getLocalizedLabels(PROFILE_SECTION_LABELS[section], locale);
}

function getSectionDisplayLabel(
  section: LinkedInProfileSectionType,
  locale: LinkedInSelectorLocale
): string {
  return getSectionLabels(section, locale)[0] ?? section;
}

function normalizeProfileSectionType(
  value: string
): LinkedInProfileSectionType {
  const normalized = normalizeFieldKey(value);

  const sectionAliases = new Map<string, LinkedInProfileSectionType>([
    ["about", "about"],
    ["experience", "experience"],
    ["education", "education"],
    ["certification", "certifications"],
    ["certifications", "certifications"],
    ["licensescertifications", "certifications"],
    ["licencescertifications", "certifications"],
    ["language", "languages"],
    ["languages", "languages"],
    ["project", "projects"],
    ["projects", "projects"],
    ["volunteer", "volunteer_experience"],
    ["volunteerexperience", "volunteer_experience"],
    ["volunteering", "volunteer_experience"],
    ["honorsawards", "honors_awards"],
    ["honoursawards", "honors_awards"],
    ["honoraward", "honors_awards"],
    ["honouraward", "honors_awards"],
    ["awards", "honors_awards"]
  ]);

  const section = sectionAliases.get(normalized);
  if (section) {
    return section;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `section must be one of: ${LINKEDIN_PROFILE_SECTION_TYPES.join(", ")}.`,
    { provided_section: value }
  );
}

function createProfileSectionItemFingerprint(
  input: Pick<
    DecodedProfileSectionItemId,
    "section" | "sourceId" | "primaryText" | "secondaryText" | "tertiaryText" | "rawText"
  >
): string {
  const hash = createHash("sha256");
  hash.update(input.section);
  hash.update("\u001f");
  hash.update(normalizeText(input.sourceId));
  hash.update("\u001f");
  hash.update(normalizeText(input.primaryText));
  hash.update("\u001f");
  hash.update(normalizeText(input.secondaryText));
  hash.update("\u001f");
  hash.update(normalizeText(input.tertiaryText));
  hash.update("\u001f");
  hash.update(normalizeText(input.rawText));
  return hash.digest("base64url").slice(0, 18);
}

function createProfileSectionItemId(
  identity: DecodedProfileSectionItemId
): string {
  const payload = {
    v: 1,
    section: identity.section,
    sourceId: normalizeText(identity.sourceId),
    primaryText: normalizeText(identity.primaryText),
    secondaryText: normalizeText(identity.secondaryText),
    tertiaryText: normalizeText(identity.tertiaryText),
    rawText: normalizeText(identity.rawText)
  };

  return `${PROFILE_SECTION_ITEM_ID_PREFIX}${Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url")}`;
}

function decodeProfileSectionItemId(
  itemId: string | undefined
): DecodedProfileSectionItemId | null {
  if (!itemId || !itemId.startsWith(PROFILE_SECTION_ITEM_ID_PREFIX)) {
    return null;
  }

  try {
    const decoded = Buffer.from(
      itemId.slice(PROFILE_SECTION_ITEM_ID_PREFIX.length),
      "base64url"
    ).toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!isRecord(parsed) || typeof parsed.section !== "string") {
      return null;
    }

    return {
      section: normalizeProfileSectionType(parsed.section),
      ...(typeof parsed.sourceId === "string"
        ? { sourceId: normalizeText(parsed.sourceId) }
        : {}),
      ...(typeof parsed.primaryText === "string"
        ? { primaryText: normalizeText(parsed.primaryText) }
        : {}),
      ...(typeof parsed.secondaryText === "string"
        ? { secondaryText: normalizeText(parsed.secondaryText) }
        : {}),
      ...(typeof parsed.tertiaryText === "string"
        ? { tertiaryText: normalizeText(parsed.tertiaryText) }
        : {}),
      ...(typeof parsed.rawText === "string"
        ? { rawText: normalizeText(parsed.rawText) }
        : {})
    };
  } catch {
    return null;
  }
}

function getEditableFieldDefinitions(
  section: LinkedInProfileSectionType
): readonly EditableFieldDefinition[] {
  return PROFILE_SECTION_FIELD_DEFINITIONS[section];
}

function buildEditableFieldAliasMap(
  definitions: readonly EditableFieldDefinition[]
): Map<string, EditableFieldDefinition> {
  const fieldMap = new Map<string, EditableFieldDefinition>();

  for (const definition of definitions) {
    fieldMap.set(normalizeFieldKey(definition.key), definition);
    for (const alias of definition.aliases) {
      fieldMap.set(normalizeFieldKey(alias), definition);
    }
  }

  return fieldMap;
}

function normalizeEditableValue(value: unknown): NormalizedEditableValue {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return normalizeText(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    "Editable field values must be strings, booleans, or finite numbers."
  );
}

function normalizeEditableValues(
  values: Record<string, unknown>,
  definitions: readonly EditableFieldDefinition[],
  label: string
): Record<string, NormalizedEditableValue> {
  const fieldMap = buildEditableFieldAliasMap(definitions);
  const normalized: Record<string, NormalizedEditableValue> = {};

  for (const [rawKey, rawValue] of Object.entries(values)) {
    const definition = fieldMap.get(normalizeFieldKey(rawKey));
    if (!definition) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Unsupported ${label} field "${rawKey}".`,
        {
          field: rawKey,
          allowed_fields: definitions.map((definitionItem) => definitionItem.key)
        }
      );
    }

    const normalizedValue = normalizeEditableValue(rawValue);
    if (typeof normalizedValue === "string" && normalizedValue.length === 0) {
      continue;
    }

    normalized[definition.key] = normalizedValue;
  }

  if (Object.keys(normalized).length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} values must include at least one non-empty field.`
    );
  }

  return normalized;
}

function normalizeProfileSectionItemMatch(
  match: LinkedInProfileSectionItemMatch | Record<string, unknown> | undefined,
  itemId: string | undefined,
  section: LinkedInProfileSectionType
): LinkedInProfileSectionItemMatch | undefined {
  const decodedItem = decodeProfileSectionItemId(itemId);
  const candidate = isRecord(match) ? match : {};

  const normalized = {
    ...(decodedItem?.sourceId ? { sourceId: decodedItem.sourceId } : {}),
    ...(decodedItem?.primaryText ? { primaryText: decodedItem.primaryText } : {}),
    ...(decodedItem?.secondaryText
      ? { secondaryText: decodedItem.secondaryText }
      : {}),
    ...(decodedItem?.tertiaryText ? { tertiaryText: decodedItem.tertiaryText } : {}),
    ...(decodedItem?.rawText ? { rawText: decodedItem.rawText } : {}),
    ...(typeof candidate.sourceId === "string"
      ? { sourceId: normalizeText(candidate.sourceId) }
      : {}),
    ...(typeof candidate.source_id === "string"
      ? { sourceId: normalizeText(candidate.source_id) }
      : {}),
    ...(typeof candidate.primaryText === "string"
      ? { primaryText: normalizeText(candidate.primaryText) }
      : {}),
    ...(typeof candidate.primary_text === "string"
      ? { primaryText: normalizeText(candidate.primary_text) }
      : {}),
    ...(typeof candidate.secondaryText === "string"
      ? { secondaryText: normalizeText(candidate.secondaryText) }
      : {}),
    ...(typeof candidate.secondary_text === "string"
      ? { secondaryText: normalizeText(candidate.secondary_text) }
      : {}),
    ...(typeof candidate.tertiaryText === "string"
      ? { tertiaryText: normalizeText(candidate.tertiaryText) }
      : {}),
    ...(typeof candidate.tertiary_text === "string"
      ? { tertiaryText: normalizeText(candidate.tertiary_text) }
      : {}),
    ...(typeof candidate.rawText === "string"
      ? { rawText: normalizeText(candidate.rawText) }
      : {}),
    ...(typeof candidate.raw_text === "string"
      ? { rawText: normalizeText(candidate.raw_text) }
      : {})
  };

  if (
    !normalized.sourceId &&
    !normalized.primaryText &&
    !normalized.secondaryText &&
    !normalized.tertiaryText &&
    !normalized.rawText
  ) {
    return undefined;
  }

  if (decodedItem && decodedItem.section !== section) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "itemId belongs to a different profile section.",
      {
        expected_section: section,
        item_section: decodedItem.section
      }
    );
  }

  return normalized;
}

interface LocatorCandidate {
  key: string;
  locator: Locator;
}

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function findFirstVisibleLocator(
  candidates: readonly LocatorCandidate[]
): Promise<LocatorCandidate | null> {
  for (const candidate of candidates) {
    if (await isLocatorVisible(candidate.locator)) {
      return candidate;
    }
  }

  return null;
}

function createActionCandidates(
  root: Page | Locator,
  labels: readonly string[],
  keyPrefix: string,
  role: "button" | "link" = "button"
): LocatorCandidate[] {
  const textRegex = buildTextRegex(labels);
  const exactRegex = buildTextRegex(labels, true);
  const tagName = role === "button" ? "button" : "a";

  return [
    {
      key: `${keyPrefix}-${role}-exact`,
      locator: root.getByRole(role, { name: exactRegex })
    },
    {
      key: `${keyPrefix}-${role}-text`,
      locator: root.getByRole(role, { name: textRegex })
    },
    {
      key: `${keyPrefix}-${role}-aria`,
      locator: root.locator(buildAriaLabelContainsSelector(tagName, labels))
    },
    {
      key: `${keyPrefix}-generic-text`,
      locator: root
        .locator(`${tagName}, [role='${role}']`)
        .filter({ hasText: textRegex })
    }
  ];
}

async function waitForProfilePageReady(page: Page): Promise<void> {
  await page
    .locator("h1")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
}

async function waitForVisibleDialog(page: Page): Promise<Locator> {
  const dialog = page.locator("[role='dialog']").last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  return dialog;
}

async function clickLocatorAndWaitForDialog(
  page: Page,
  locator: Locator
): Promise<Locator> {
  await locator.first().click();
  return waitForVisibleDialog(page);
}

async function navigateToOwnProfile(page: Page): Promise<void> {
  await page.goto(resolveProfileUrl("me"), { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  await waitForProfilePageReady(page);
}

function getTopCardRoot(page: Page): Locator {
  return page.locator("main .pv-top-card, main .top-card-layout, main section, main").first();
}

async function findProfileSectionRoot(
  page: Page,
  section: LinkedInProfileSectionType,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator | null> {
  const headingRegex = buildTextRegex(getSectionLabels(section, selectorLocale), true);
  const candidate = page
    .locator("section, div.pv-profile-card, div.artdeco-card")
    .filter({
      has: page.locator("h2, h3, .pvs-header__title").filter({ hasText: headingRegex }).first()
    })
    .first();

  return (await isLocatorVisible(candidate)) ? candidate : null;
}

async function readExtractedSectionItem(
  locator: Locator
): Promise<ExtractedEditableSectionItem> {
  return locator.evaluate((element) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const root = element;
    const sourceCandidates = [
      root.getAttribute("data-entity-urn"),
      root.getAttribute("data-urn"),
      root.id,
      ...Array.from(root.querySelectorAll("[data-entity-urn], [data-urn], a[href]"))
        .map((candidate) =>
          candidate.getAttribute("data-entity-urn") ??
          candidate.getAttribute("data-urn") ??
          candidate.getAttribute("href")
        )
        .filter((candidate): candidate is string => typeof candidate === "string")
    ]
      .map((candidate) => normalize(candidate))
      .filter((candidate) => candidate.length > 0);

    const lineSelectors = [
      ".t-bold span[aria-hidden='true']",
      ".t-normal span[aria-hidden='true']",
      ".pvs-entity__caption-wrapper span[aria-hidden='true']",
      ".pvs-entity__description-wrapper span[aria-hidden='true']",
      ".inline-show-more-text span[aria-hidden='true']",
      ".inline-show-more-text"
    ];

    let lines = lineSelectors.flatMap((selector) =>
      Array.from(root.querySelectorAll(selector)).map((node) => normalize(node.textContent))
    );

    lines = lines.filter((line) => line.length > 0);
    if (lines.length === 0) {
      lines = normalize(root.textContent)
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter((line) => line.length > 0);
    }

    const rawText = normalize(root.textContent);
    const primaryText = lines[0] ?? "";
    const secondaryText = lines[1] ?? "";
    const tertiaryText = lines[2] ?? "";
    const description =
      lines
        .slice(3)
        .filter((line) => line !== primaryText && line !== secondaryText && line !== tertiaryText)
        .join(" ") || rawText;

    return {
      source_id: sourceCandidates[0] ?? null,
      primary_text: primaryText,
      secondary_text: secondaryText,
      tertiary_text: tertiaryText,
      description,
      raw_text: rawText
    };
  });
}

function doesSectionItemMatch(
  candidate: ExtractedEditableSectionItem,
  match: LinkedInProfileSectionItemMatch
): boolean {
  const candidateSourceId = normalizeText(candidate.source_id);
  const candidateRawText = normalizeText(candidate.raw_text);
  const candidatePrimaryText = normalizeText(candidate.primary_text);
  const candidateSecondaryText = normalizeText(candidate.secondary_text);
  const candidateTertiaryText = normalizeText(candidate.tertiary_text);

  if (match.sourceId && candidateSourceId) {
    if (candidateSourceId === normalizeText(match.sourceId)) {
      return true;
    }
  }

  let matchedFieldCount = 0;
  const comparisons: Array<[string | undefined, string]> = [
    [match.primaryText, candidatePrimaryText],
    [match.secondaryText, candidateSecondaryText],
    [match.tertiaryText, candidateTertiaryText],
    [match.rawText, candidateRawText]
  ];

  for (const [expected, actual] of comparisons) {
    if (!expected) {
      continue;
    }

    const normalizedExpected = normalizeText(expected);
    if (!normalizedExpected) {
      continue;
    }

    if (actual === normalizedExpected || actual.includes(normalizedExpected)) {
      matchedFieldCount += 1;
      continue;
    }

    return false;
  }

  return matchedFieldCount > 0;
}

async function findMatchingSectionItemLocator(
  sectionRoot: Locator,
  match: LinkedInProfileSectionItemMatch
): Promise<Locator | null> {
  const items = sectionRoot.locator(
    ".pvs-list__paged-list-item, .pvs-list__item--line-separated, li.artdeco-list__item, li[class*='pvs-list__item']"
  );
  const itemCount = await items.count();

  for (let index = 0; index < itemCount; index += 1) {
    const candidate = items.nth(index);
    const extracted = await readExtractedSectionItem(candidate);
    if (doesSectionItemMatch(extracted, match)) {
      return candidate;
    }
  }

  return null;
}

async function openIntroEditDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const topCardRoot = getTopCardRoot(page);
  const editCandidates = createActionCandidates(
    topCardRoot,
    getUiActionLabels("edit", selectorLocale),
    "intro-edit"
  );
  const resolved = await findFirstVisibleLocator(editCandidates);
  if (!resolved) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the intro edit control on the profile page."
    );
  }

  return clickLocatorAndWaitForDialog(page, resolved.locator);
}

async function openGlobalAddSectionDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const topCardRoot = getTopCardRoot(page);
  const addCandidates = createActionCandidates(
    topCardRoot,
    getUiActionLabels("addProfileSection", selectorLocale),
    "profile-section-add"
  );
  const resolved = await findFirstVisibleLocator(addCandidates);

  if (!resolved) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the global add profile section control."
    );
  }

  return clickLocatorAndWaitForDialog(page, resolved.locator);
}

async function openSectionCreateDialog(
  page: Page,
  section: LinkedInProfileSectionType,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const sectionRoot = await findProfileSectionRoot(page, section, selectorLocale);
  const addLabels = getUiActionLabels("add", selectorLocale);

  if (sectionRoot) {
    const sectionAddCandidates = createActionCandidates(
      sectionRoot,
      addLabels,
      `${section}-add`
    );
    const resolvedSectionAdd = await findFirstVisibleLocator(sectionAddCandidates);
    if (resolvedSectionAdd) {
      return clickLocatorAndWaitForDialog(page, resolvedSectionAdd.locator);
    }
  }

  const addSectionDialog = await openGlobalAddSectionDialog(page, selectorLocale);
  const sectionLabels = getSectionLabels(section, selectorLocale);
  const sectionTextRegex = buildTextRegex(sectionLabels);
  const sectionCandidates: LocatorCandidate[] = [
    ...createActionCandidates(addSectionDialog, sectionLabels, `${section}-global-button`),
    ...createActionCandidates(
      addSectionDialog,
      sectionLabels,
      `${section}-global-link`,
      "link"
    ),
    {
      key: `${section}-global-generic`,
      locator: addSectionDialog
        .locator("button, a, div[role='button'], li")
        .filter({ hasText: sectionTextRegex })
    }
  ];

  const resolved = await findFirstVisibleLocator(sectionCandidates);
  if (!resolved) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      `Could not find an add flow for the ${getSectionDisplayLabel(section, selectorLocale)} section.`
    );
  }

  await resolved.locator.first().click();
  await page.waitForTimeout(500);
  return waitForVisibleDialog(page);
}

async function openExistingSectionItemDialog(
  page: Page,
  section: LinkedInProfileSectionType,
  match: LinkedInProfileSectionItemMatch,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const sectionRoot = await findProfileSectionRoot(page, section, selectorLocale);
  if (!sectionRoot) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      `Could not find the ${getSectionDisplayLabel(section, selectorLocale)} section on the profile page.`
    );
  }

  const itemLocator = await findMatchingSectionItemLocator(sectionRoot, match);
  if (!itemLocator) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      `Could not find a matching item in the ${getSectionDisplayLabel(section, selectorLocale)} section.`,
      {
        section,
        match
      }
    );
  }

  const editCandidates = createActionCandidates(
    itemLocator,
    getUiActionLabels("edit", selectorLocale),
    `${section}-item-edit`
  );
  const resolvedEdit = await findFirstVisibleLocator(editCandidates);
  if (resolvedEdit) {
    return clickLocatorAndWaitForDialog(page, resolvedEdit.locator);
  }

  const moreCandidates = createActionCandidates(
    itemLocator,
    getUiActionLabels("more", selectorLocale),
    `${section}-item-more`
  );
  const resolvedMore = await findFirstVisibleLocator(moreCandidates);
  if (!resolvedMore) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      `Could not find edit controls for the selected ${getSectionDisplayLabel(section, selectorLocale)} item.`
    );
  }

  await resolvedMore.locator.first().click();
  const editMenuCandidates: LocatorCandidate[] = [
    ...createActionCandidates(page, getUiActionLabels("edit", selectorLocale), `${section}-menu-edit`),
    {
      key: `${section}-menu-edit-item`,
      locator: page
        .locator("[role='menuitem'], button, div[role='button']")
        .filter({ hasText: buildTextRegex(getUiActionLabels("edit", selectorLocale)) })
    }
  ];
  const resolvedMenuEdit = await findFirstVisibleLocator(editMenuCandidates);
  if (!resolvedMenuEdit) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      `Could not find the edit menu entry for the selected ${getSectionDisplayLabel(section, selectorLocale)} item.`
    );
  }

  return clickLocatorAndWaitForDialog(page, resolvedMenuEdit.locator);
}

async function findDialogFieldLocator(
  dialog: Locator,
  definition: EditableFieldDefinition
): Promise<Locator | null> {
  const labelRegex = buildTextRegex(definition.aliases);
  const byLabel = dialog.getByLabel(labelRegex).first();
  if (await isLocatorVisible(byLabel)) {
    return byLabel;
  }

  for (const alias of definition.aliases) {
    const normalizedAlias = normalizeText(alias).toLowerCase();
    const xpath = dialog
      .locator(
        `xpath=.//label[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ', 'abcdefghijklmnopqrstuvwxyzæøå'), "${normalizedAlias}")]/following::*[(self::input or self::textarea or self::select or @role='combobox')][1]`
      )
      .first();
    if (await isLocatorVisible(xpath)) {
      return xpath;
    }
  }

  return null;
}

async function fillDialogField(
  page: Page,
  dialog: Locator,
  definition: EditableFieldDefinition,
  value: NormalizedEditableValue
): Promise<void> {
  const locator = await findDialogFieldLocator(dialog, definition);
  if (!locator) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      `Could not find the "${definition.key}" field in the profile editor.`
    );
  }

  if (definition.control === "checkbox") {
    const checked = Boolean(value);
    if (checked) {
      await locator.check().catch(async () => {
        await locator.click();
      });
    } else {
      await locator.uncheck().catch(async () => {
        await locator.click();
      });
    }
    return;
  }

  const stringValue = String(value);
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());

  if (definition.control === "select" && tagName === "select") {
    await locator.selectOption({ label: stringValue }).catch(async () => {
      await locator.selectOption({ value: stringValue }).catch(async () => {
        await locator.selectOption({ index: 0 });
      });
    });
    return;
  }

  await locator.click();
  await locator.fill(stringValue).catch(async () => {
    await locator.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`).catch(
      () => undefined
    );
    await locator.press("Backspace").catch(() => undefined);
    await locator.type(stringValue);
  });

  if (definition.control === "select") {
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
  }
}

async function clickSaveInDialog(
  page: Page,
  dialog: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<void> {
  const saveCandidates: LocatorCandidate[] = [
    ...createActionCandidates(dialog, getUiActionLabels("save", selectorLocale), "dialog-save"),
    {
      key: "dialog-save-submit",
      locator: dialog.locator("button[type='submit']")
    }
  ];
  const resolved = await findFirstVisibleLocator(saveCandidates);
  if (!resolved) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the save button in the profile editor dialog."
    );
  }

  await resolved.locator.first().click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
  await waitForNetworkIdleBestEffort(page);
}

async function clickDeleteInDialog(
  page: Page,
  dialog: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<void> {
  const deleteCandidates = createActionCandidates(
    dialog,
    getUiActionLabels("delete", selectorLocale),
    "dialog-delete"
  );
  const resolvedDelete = await findFirstVisibleLocator(deleteCandidates);
  if (!resolvedDelete) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the delete button in the profile editor dialog."
    );
  }

  await resolvedDelete.locator.first().click();
  await page.waitForTimeout(500);

  const confirmDeleteCandidates: LocatorCandidate[] = [
    ...createActionCandidates(page, getUiActionLabels("delete", selectorLocale), "confirm-delete"),
    {
      key: "confirm-delete-generic",
      locator: page
        .locator("[role='dialog'] button, [role='dialog'] [role='button']")
        .filter({ hasText: buildTextRegex(getUiActionLabels("delete", selectorLocale)) })
    }
  ];
  const resolvedConfirmDelete = await findFirstVisibleLocator(confirmDeleteCandidates);
  if (resolvedConfirmDelete) {
    await resolvedConfirmDelete.locator.first().click();
  }

  await page.locator("[role='dialog']").last().waitFor({ state: "hidden", timeout: 10_000 }).catch(
    () => undefined
  );
  await waitForNetworkIdleBestEffort(page);
}

async function extractEditableSections(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  profile: LinkedInProfile
): Promise<LinkedInProfileEditableSection[]> {
  const sectionLabels = Object.fromEntries(
    LINKEDIN_PROFILE_SECTION_TYPES.map((section) => [
      section,
      getSectionLabels(section, selectorLocale)
    ])
  ) as Record<LinkedInProfileSectionType, string[]>;

  const extracted = await page.evaluate((config) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const includesAnyLabel = (value: string, labels: string[]): boolean => {
      const normalizedValue = normalize(value).toLowerCase();
      return labels.some((label) => normalizedValue.includes(normalize(label).toLowerCase()));
    };

    const findSectionRoot = (labels: string[]) => {
      const sections = Array.from(
        globalThis.document.querySelectorAll("section, div.pv-profile-card, div.artdeco-card")
      );
      for (const section of sections) {
        const heading = normalize(
          section.querySelector("h2, h3, .pvs-header__title")?.textContent
        );
        if (heading && includesAnyLabel(heading, labels)) {
          return section;
        }
      }

      return null;
    };

    const itemSelectors = [
      ".pvs-list__paged-list-item",
      ".pvs-list__item--line-separated",
      "li.artdeco-list__item",
      "li[class*='pvs-list__item']"
    ];

    const collectItems = (sectionRoot: globalThis.Element) => {
      for (const selector of itemSelectors) {
        const items = Array.from(sectionRoot.querySelectorAll(selector));
        if (items.length > 0) {
          return items;
        }
      }
      return [];
    };

    const readItem = (itemRoot: globalThis.Element) => {
      const lineSelectors = [
        ".t-bold span[aria-hidden='true']",
        ".t-normal span[aria-hidden='true']",
        ".pvs-entity__caption-wrapper span[aria-hidden='true']",
        ".pvs-entity__description-wrapper span[aria-hidden='true']",
        ".inline-show-more-text span[aria-hidden='true']",
        ".inline-show-more-text"
      ];

      let lines = lineSelectors.flatMap((selector) =>
        Array.from(itemRoot.querySelectorAll(selector)).map((node) => normalize(node.textContent))
      );
      lines = lines.filter((line) => line.length > 0);

      const rawText = normalize(itemRoot.textContent);
      if (lines.length === 0 && rawText) {
        lines = rawText
          .split(/\n+/)
          .map((line) => normalize(line))
          .filter((line) => line.length > 0);
      }

      const sourceCandidates = [
        itemRoot.getAttribute("data-entity-urn"),
        itemRoot.getAttribute("data-urn"),
        itemRoot.id,
        ...Array.from(itemRoot.querySelectorAll("[data-entity-urn], [data-urn], a[href]"))
          .map((candidate) =>
            candidate.getAttribute("data-entity-urn") ??
            candidate.getAttribute("data-urn") ??
            candidate.getAttribute("href")
          )
          .filter((candidate): candidate is string => typeof candidate === "string")
      ]
        .map((candidate) => normalize(candidate))
        .filter((candidate) => candidate.length > 0);

      return {
        source_id: sourceCandidates[0] ?? null,
        primary_text: lines[0] ?? "",
        secondary_text: lines[1] ?? "",
        tertiary_text: lines[2] ?? "",
        description: lines.slice(3).join(" ") || rawText,
        raw_text: rawText
      };
    };

    return Object.fromEntries(
      Object.entries(config.sectionLabels)
        .filter(([section]) => section !== "about")
        .map(([section, labels]) => {
          const root = findSectionRoot(labels);
          if (!root) {
            return [section, []];
          }

          const items = collectItems(root)
            .map((itemRoot) => readItem(itemRoot))
            .filter(
              (item) =>
                item.primary_text ||
                item.secondary_text ||
                item.tertiary_text ||
                item.description ||
                item.raw_text
            );

          return [section, items];
        })
    );
  }, { sectionLabels });

  return LINKEDIN_PROFILE_SECTION_TYPES.map((section) => {
    const sectionItems =
      section === "about"
        ? profile.about
          ? [
              {
                source_id: "about",
                primary_text: profile.about.slice(0, 120),
                secondary_text: "",
                tertiary_text: "",
                description: profile.about,
                raw_text: profile.about
              }
            ]
          : []
        : ((extracted[section] ?? []) as ExtractedEditableSectionItem[]);

    return {
      section,
      label: getSectionDisplayLabel(section, selectorLocale),
      supported_fields: getEditableFieldDefinitions(section).map((definition) => definition.key),
      can_add: true,
      items: sectionItems.map((item) => {
        const itemId = createProfileSectionItemId({
          section,
          ...(item.source_id ? { sourceId: item.source_id } : {}),
          primaryText: item.primary_text,
          secondaryText: item.secondary_text,
          tertiaryText: item.tertiary_text,
          rawText: item.raw_text
        });

        return {
          item_id: itemId,
          section,
          primary_text: normalizeText(item.primary_text),
          secondary_text: normalizeText(item.secondary_text),
          tertiary_text: normalizeText(item.tertiary_text),
          description: normalizeText(item.description),
          raw_text: normalizeText(item.raw_text),
          source_id: item.source_id ? normalizeText(item.source_id) : null
        };
      })
    } satisfies LinkedInProfileEditableSection;
  });
}

async function openSectionEditDialog(
  page: Page,
  section: LinkedInProfileSectionType,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const sectionRoot = await findProfileSectionRoot(page, section, selectorLocale);
  if (!sectionRoot) {
    return openSectionCreateDialog(page, section, selectorLocale);
  }

  const editCandidates = createActionCandidates(
    sectionRoot,
    getUiActionLabels("edit", selectorLocale),
    `${section}-edit`
  );
  const resolvedEdit = await findFirstVisibleLocator(editCandidates);
  if (!resolvedEdit) {
    return openSectionCreateDialog(page, section, selectorLocale);
  }

  return clickLocatorAndWaitForDialog(page, resolvedEdit.locator);
}

function getPayloadRecord(
  payload: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> {
  const value = payload[key];
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} payload is missing a valid ${key} object.`
    );
  }

  return value;
}

async function executeUpdateProfileIntro(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const updates = normalizeEditableValues(
    getPayloadRecord(payload, "updates", "profile intro update"),
    PROFILE_INTRO_FIELD_DEFINITIONS,
    "profile intro"
  );

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: UPDATE_PROFILE_INTRO_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          updated_fields: Object.keys(updates)
        },
        errorDetails: {
          profile_name: profileName,
          updated_fields: Object.keys(updates)
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn profile intro update."
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          const dialog = await openIntroEditDialog(page, runtime.selectorLocale);

          for (const definition of PROFILE_INTRO_FIELD_DEFINITIONS) {
            if (!(definition.key in updates)) {
              continue;
            }
            await fillDialogField(page, dialog, definition, updates[definition.key]!);
          }

          await clickSaveInDialog(page, dialog, runtime.selectorLocale);

          return {
            ok: true,
            result: {
              status: "profile_intro_updated",
              updated_fields: Object.keys(updates)
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeUpsertProfileSectionItem(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const section = normalizeProfileSectionType(String(target.section ?? ""));
  const values = normalizeEditableValues(
    getPayloadRecord(payload, "values", "profile section upsert"),
    getEditableFieldDefinitions(section),
    `${section} section`
  );
  const mode = String(payload.mode ?? "create") === "update" ? "update" : "create";
  const match = normalizeProfileSectionItemMatch(
    isRecord(payload.match) ? payload.match : undefined,
    typeof target.item_id === "string" ? target.item_id : undefined,
    section
  );

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          section,
          mode,
          updated_fields: Object.keys(values)
        },
        errorDetails: {
          profile_name: profileName,
          section,
          mode,
          updated_fields: Object.keys(values)
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            `Failed to execute LinkedIn ${section} section upsert.`
          ),
        execute: async () => {
          await navigateToOwnProfile(page);

          let dialog: Locator;
          if (section === "about") {
            dialog = await openSectionEditDialog(page, section, runtime.selectorLocale);
          } else if (mode === "update" && match) {
            dialog = await openExistingSectionItemDialog(
              page,
              section,
              match,
              runtime.selectorLocale
            );
          } else {
            dialog = await openSectionCreateDialog(page, section, runtime.selectorLocale);
          }

          for (const definition of getEditableFieldDefinitions(section)) {
            if (!(definition.key in values)) {
              continue;
            }
            await fillDialogField(page, dialog, definition, values[definition.key]!);
          }

          await clickSaveInDialog(page, dialog, runtime.selectorLocale);

          return {
            ok: true,
            result: {
              status:
                mode === "update"
                  ? "profile_section_item_updated"
                  : "profile_section_item_created",
              section,
              updated_fields: Object.keys(values),
              item_fingerprint: createProfileSectionItemFingerprint({
                section,
                ...(match?.sourceId ? { sourceId: match.sourceId } : {}),
                ...(match?.primaryText ? { primaryText: match.primaryText } : {}),
                ...(match?.secondaryText ? { secondaryText: match.secondaryText } : {}),
                ...(match?.tertiaryText ? { tertiaryText: match.tertiaryText } : {}),
                ...(match?.rawText ? { rawText: match.rawText } : {})
              })
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeRemoveProfileSectionItem(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const section = normalizeProfileSectionType(String(target.section ?? ""));
  const match = normalizeProfileSectionItemMatch(
    isRecord(payload.match) ? payload.match : undefined,
    typeof target.item_id === "string" ? target.item_id : undefined,
    section
  );

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          section
        },
        errorDetails: {
          profile_name: profileName,
          section
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            `Failed to execute LinkedIn ${section} section removal.`
          ),
        execute: async () => {
          await navigateToOwnProfile(page);

          if (section === "about") {
            const dialog = await openSectionEditDialog(page, section, runtime.selectorLocale);
            await fillDialogField(page, dialog, getEditableFieldDefinitions(section)[0]!, "");
            await clickSaveInDialog(page, dialog, runtime.selectorLocale);
          } else {
            if (!match) {
              throw new LinkedInAssistantError(
                "ACTION_PRECONDITION_FAILED",
                `Removing a ${section} item requires itemId or match details.`
              );
            }
            const dialog = await openExistingSectionItemDialog(
              page,
              section,
              match,
              runtime.selectorLocale
            );
            await clickDeleteInDialog(page, dialog, runtime.selectorLocale);
          }

          return {
            ok: true,
            result: {
              status: "profile_section_item_removed",
              section,
              ...(match
                ? {
                    item_fingerprint: createProfileSectionItemFingerprint({
                      section,
                      ...(match.sourceId ? { sourceId: match.sourceId } : {}),
                      ...(match.primaryText ? { primaryText: match.primaryText } : {}),
                      ...(match.secondaryText ? { secondaryText: match.secondaryText } : {}),
                      ...(match.tertiaryText ? { tertiaryText: match.tertiaryText } : {}),
                      ...(match.rawText ? { rawText: match.rawText } : {})
                    })
                  }
                : {})
            },
            artifacts: []
          };
        }
      });
    }
  );
}

export class UpdateProfileIntroActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUpdateProfileIntro(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class UpsertProfileSectionItemActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUpsertProfileSectionItem(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class RemoveProfileSectionItemActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeRemoveProfileSectionItem(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export function createProfileActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInProfileExecutorRuntime>
> {
  return {
    [UPDATE_PROFILE_INTRO_ACTION_TYPE]: new UpdateProfileIntroActionExecutor(),
    [UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE]:
      new UpsertProfileSectionItemActionExecutor(),
    [REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE]:
      new RemoveProfileSectionItemActionExecutor()
  };
}

export class LinkedInProfileService {
  constructor(private readonly runtime: LinkedInProfileRuntime) {}

  async viewProfile(input: ViewProfileInput): Promise<LinkedInProfile> {
    const profileName = input.profileName ?? "default";
    const profileUrl = resolveProfileUrl(input.target);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForProfilePageReady(page);
          return extractProfileData(page, this.runtime.selectorLocale);
        }
      );
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn profile."
      );
    }
  }

  async viewEditableProfile(
    input: ViewEditableProfileInput = {}
  ): Promise<LinkedInEditableProfile> {
    const profileName = input.profileName ?? "default";

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await navigateToOwnProfile(page);

          const profile = await extractProfileData(page, this.runtime.selectorLocale);
          const sections = await extractEditableSections(
            page,
            this.runtime.selectorLocale,
            profile
          );

          return {
            profile_url: profile.profile_url,
            intro: {
              full_name: profile.full_name,
              headline: profile.headline,
              location: profile.location,
              supported_fields: ["firstName", "lastName", "headline", "location"]
            },
            sections
          };
        }
      );
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to inspect the editable LinkedIn profile view."
      );
    }
  }

  prepareUpdateIntro(
    input: PrepareUpdateIntroInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const updates = normalizeEditableValues(
      {
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.headline !== undefined ? { headline: input.headline } : {}),
        ...(input.location !== undefined ? { location: input.location } : {})
      },
      PROFILE_INTRO_FIELD_DEFINITIONS,
      "profile intro"
    );

    const target = {
      profile_name: profileName
    };
    const preview = {
      summary: `Update LinkedIn profile intro (${Object.keys(updates).join(", ")})`,
      target,
      intro_updates: updates
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPDATE_PROFILE_INTRO_ACTION_TYPE,
      target,
      payload: {
        updates
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareUpsertSectionItem(
    input: PrepareUpsertSectionItemInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const section = normalizeProfileSectionType(String(input.section));
    const values = normalizeEditableValues(
      input.values,
      getEditableFieldDefinitions(section),
      `${section} section`
    );
    const match = normalizeProfileSectionItemMatch(input.match, input.itemId, section);
    const mode = input.itemId || match ? "update" : "create";

    const target = {
      profile_name: profileName,
      section,
      ...(input.itemId ? { item_id: input.itemId } : {})
    };
    const preview = {
      summary:
        mode === "update"
          ? `Update ${section} profile section item`
          : `Create ${section} profile section item`,
      target,
      mode,
      section,
      values,
      ...(match ? { match } : {})
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE,
      target,
      payload: {
        section,
        mode,
        values,
        ...(match ? { match } : {})
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareRemoveSectionItem(
    input: PrepareRemoveSectionItemInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const section = normalizeProfileSectionType(String(input.section));
    const match = normalizeProfileSectionItemMatch(input.match, input.itemId, section);

    if (section !== "about" && !input.itemId && !match) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Removing a ${section} section item requires itemId or match details.`
      );
    }

    const target = {
      profile_name: profileName,
      section,
      ...(input.itemId ? { item_id: input.itemId } : {})
    };
    const preview = {
      summary:
        section === "about"
          ? "Clear LinkedIn about summary"
          : `Remove ${section} profile section item`,
      target,
      section,
      ...(match ? { match } : {})
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE,
      target,
      payload: {
        section,
        ...(match ? { match } : {})
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
