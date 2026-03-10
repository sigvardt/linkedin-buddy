import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
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
export const UPDATE_PROFILE_SETTINGS_ACTION_TYPE = "profile.update_settings";
export const UPDATE_PUBLIC_PROFILE_ACTION_TYPE =
  "profile.update_public_profile";
export const UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE =
  "profile.upsert_section_item";
export const REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE =
  "profile.remove_section_item";
export const UPLOAD_PROFILE_PHOTO_ACTION_TYPE = "profile.upload_photo";
export const UPLOAD_PROFILE_BANNER_ACTION_TYPE = "profile.upload_banner";
export const ADD_PROFILE_FEATURED_ACTION_TYPE = "profile.featured_add";
export const REMOVE_PROFILE_FEATURED_ACTION_TYPE = "profile.featured_remove";
export const REORDER_PROFILE_FEATURED_ACTION_TYPE = "profile.featured_reorder";

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

export const LINKEDIN_PROFILE_FEATURED_ITEM_KINDS = [
  "link",
  "media",
  "post"
] as const;

export type LinkedInProfileSectionType =
  (typeof LINKEDIN_PROFILE_SECTION_TYPES)[number];

export type LinkedInProfileFeaturedItemKind =
  (typeof LINKEDIN_PROFILE_FEATURED_ITEM_KINDS)[number];

type EditableControlType = "text" | "textarea" | "checkbox" | "select";

type IntroFieldKey = "firstName" | "lastName" | "headline" | "location";
type SettingsFieldKey = "industry";
type PublicProfileFieldKey = "vanityName" | "publicProfileUrl";

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

export interface LinkedInProfileEditableSettings {
  industry: string;
  supported_fields: SettingsFieldKey[];
}

export interface LinkedInProfileEditablePublicProfile {
  vanity_name: string;
  public_profile_url: string;
  supported_fields: PublicProfileFieldKey[];
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

export interface LinkedInProfileEditableFeaturedItem {
  item_id: string;
  position: number;
  kind: LinkedInProfileFeaturedItemKind;
  title: string;
  subtitle: string;
  description: string;
  url: string | null;
  raw_text: string;
  source_id: string | null;
}

export interface LinkedInProfileEditableFeaturedSection {
  label: string;
  can_add: boolean;
  can_remove: boolean;
  can_reorder: boolean;
  supported_kinds: LinkedInProfileFeaturedItemKind[];
  items: LinkedInProfileEditableFeaturedItem[];
}

export interface LinkedInEditableProfile {
  profile_url: string;
  intro: LinkedInProfileEditableIntro;
  settings: LinkedInProfileEditableSettings;
  public_profile: LinkedInProfileEditablePublicProfile;
  sections: LinkedInProfileEditableSection[];
  featured: LinkedInProfileEditableFeaturedSection;
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

export interface LinkedInProfileFeaturedItemMatch {
  sourceId?: string;
  url?: string;
  title?: string;
  subtitle?: string;
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

export interface PrepareUpdateSettingsInput {
  profileName?: string;
  industry?: string;
  operatorNote?: string;
}

export interface PrepareUpdatePublicProfileInput {
  profileName?: string;
  vanityName?: string;
  publicProfileUrl?: string;
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

export interface PrepareUploadProfileMediaInput {
  profileName?: string;
  filePath: string;
  operatorNote?: string;
}

export interface PrepareFeaturedAddInput {
  profileName?: string;
  kind: LinkedInProfileFeaturedItemKind | string;
  url?: string;
  filePath?: string;
  title?: string;
  description?: string;
  operatorNote?: string;
}

export interface PrepareFeaturedRemoveInput {
  profileName?: string;
  itemId?: string;
  match?: LinkedInProfileFeaturedItemMatch | Record<string, unknown>;
  operatorNote?: string;
}

export interface PrepareFeaturedReorderInput {
  profileName?: string;
  itemIds: string[];
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

interface ExtractedEditableFeaturedItem {
  source_id: string | null;
  title: string;
  subtitle: string;
  description: string;
  url: string | null;
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

interface DecodedProfileFeaturedItemId {
  kind: LinkedInProfileFeaturedItemKind;
  sourceId?: string;
  url?: string;
  title?: string;
  subtitle?: string;
  rawText?: string;
}

interface PreparedUploadArtifact {
  absolute_path: string;
  relative_path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  mime_type: string;
}

type NormalizedEditableValue = string | boolean;

const PROFILE_SECTION_ITEM_ID_PREFIX = "psi_";
const PROFILE_FEATURED_ITEM_ID_PREFIX = "pfi_";
const MAX_PROFILE_UPLOAD_BYTES = 100 * 1024 * 1024;
const PROFILE_IMAGE_UPLOAD_EXTENSIONS = [".jpg", ".jpeg", ".png"] as const;
const FEATURED_MEDIA_UPLOAD_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx"
] as const;

const PROFILE_UPLOAD_MIME_TYPES: Record<string, string> = {
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

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
  editIntro: {
    en: ["Edit intro"],
    da: ["Rediger intro"]
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
    en: ["Save", "Done", "Apply", "Save photo"],
    da: ["Gem", "Færdig", "Udført", "Anvend"]
  },
  close: {
    en: ["Close", "Dismiss"],
    da: ["Luk"]
  }
} as const;

const PROFILE_FEATURED_LABELS = {
  section: {
    en: ["Featured"],
    da: ["Fremhævet", "Udvalgte"]
  },
  addLink: {
    en: ["Add a link", "Add link", "Link"],
    da: ["Tilføj et link", "Tilføj link", "Link"]
  },
  addMedia: {
    en: ["Add media", "Media", "Upload media"],
    da: ["Tilføj medier", "Tilføj medie", "Medier"]
  },
  addPost: {
    en: ["Add a post", "Add post", "Post"],
    da: ["Tilføj et opslag", "Tilføj opslag", "Opslag"]
  },
  remove: {
    en: [
      "Remove from featured",
      "Remove from Featured",
      "Remove from profile",
      "Remove from top of profile",
      "Unfeature"
    ],
    da: [
      "Fjern fra fremhævede",
      "Fjern fra udvalgte",
      "Fjern fra profilen"
    ]
  }
} as const;

const PROFILE_MEDIA_LABELS = {
  photo: {
    en: [
      "Profile photo",
      "Photo",
      "Add photo",
      "Change photo",
      "Edit photo",
      "Upload photo"
    ],
    da: [
      "Profilbillede",
      "Billede",
      "Tilføj billede",
      "Skift billede",
      "Rediger billede",
      "Upload billede"
    ]
  },
  banner: {
    en: [
      "Background photo",
      "Cover image",
      "Banner",
      "Add a cover image",
      "Change cover image",
      "Edit cover image"
    ],
    da: [
      "Baggrundsbillede",
      "Forsidebillede",
      "Banner",
      "Tilføj forsidebillede",
      "Skift forsidebillede",
      "Rediger forsidebillede"
    ]
  },
  upload: {
    en: [
      "Upload photo",
      "Upload image",
      "Upload media",
      "Add photo",
      "Change photo",
      "Select photo",
      "Select image"
    ],
    da: [
      "Upload billede",
      "Upload medie",
      "Tilføj billede",
      "Skift billede",
      "Vælg billede"
    ]
  }
} as const;

const PUBLIC_PROFILE_LABELS = {
  customUrl: {
    en: [
      "Edit your custom URL",
      "Custom URL",
      "Public profile URL",
      "Your public profile URL"
    ],
    da: [
      "Rediger din tilpassede URL",
      "Tilpasset URL",
      "Offentlig profil-URL",
      "Din offentlige profil-URL"
    ]
  },
  publicProfilePage: {
    en: ["Public profile & URL", "Public profile settings"],
    da: ["Offentlig profil og URL", "Indstillinger for offentlig profil"]
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

const PROFILE_SETTINGS_FIELD_DEFINITIONS = [
  {
    key: "industry",
    aliases: ["industry", "Industry", "Primary industry", "Industri"],
    control: "select"
  }
] as const satisfies readonly EditableFieldDefinition[];

const PUBLIC_PROFILE_SETTINGS_URL = "https://www.linkedin.com/public-profile/settings";
const PUBLIC_PROFILE_VANITY_NAME_PATTERN = /^[A-Za-z0-9-]{3,100}$/;

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

const FEATURED_LINK_FIELD_DEFINITIONS = [
  {
    key: "url",
    aliases: ["url", "link", "Link", "Link URL", "Website", "Website URL"],
    control: "text"
  },
  {
    key: "title",
    aliases: ["title", "Title", "Name", "Navn"],
    control: "text"
  },
  {
    key: "description",
    aliases: ["description", "Description", "Beskrivelse"],
    control: "textarea"
  }
] as const satisfies readonly EditableFieldDefinition[];

const FEATURED_MEDIA_FIELD_DEFINITIONS = [
  {
    key: "title",
    aliases: ["title", "Title", "Name", "Navn"],
    control: "text"
  },
  {
    key: "description",
    aliases: ["description", "Description", "Beskrivelse"],
    control: "textarea"
  }
] as const satisfies readonly EditableFieldDefinition[];

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

function buildLinkedInPublicProfileUrl(vanityName: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(vanityName)}/`;
}

function normalizePublicProfileVanityName(
  value: string | undefined,
  label: string
): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} is required.`
    );
  }

  if (normalizedValue.toLowerCase() === "me") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a vanity name or LinkedIn /in/ URL, not "me".`
    );
  }

  let vanityName = normalizedValue;
  if (isAbsoluteUrl(normalizedValue) || normalizedValue.startsWith("/in/")) {
    const resolvedUrl = resolveProfileUrl(normalizedValue);

    try {
      const parsedUrl = new URL(resolvedUrl);
      const match = /^\/in\/([^/]+)/.exec(parsedUrl.pathname);
      const vanityNameRaw = match?.[1];
      if (!vanityNameRaw) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          `${label} must point to linkedin.com/in/<vanity-name>.`,
          {
            value: normalizedValue
          }
        );
      }

      vanityName = decodeURIComponent(vanityNameRaw);
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }

      throw asLinkedInAssistantError(
        error,
        "ACTION_PRECONDITION_FAILED",
        `${label} must be a valid LinkedIn public profile URL.`
      );
    }
  }

  if (!PUBLIC_PROFILE_VANITY_NAME_PATTERN.test(vanityName)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must contain 3-100 letters, numbers, or hyphens.`,
      {
        value: normalizedValue
      }
    );
  }

  return vanityName;
}

function normalizePreparedPublicProfileInput(
  input: Pick<PrepareUpdatePublicProfileInput, "vanityName" | "publicProfileUrl">
): {
  vanityName: string;
  publicProfileUrl: string;
} {
  const vanityNameInput = normalizeText(input.vanityName);
  const publicProfileUrlInput = normalizeText(input.publicProfileUrl);

  if (!vanityNameInput && !publicProfileUrlInput) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Public profile update requires vanityName or publicProfileUrl."
    );
  }

  const vanityNameFromVanityInput = vanityNameInput
    ? normalizePublicProfileVanityName(vanityNameInput, "vanityName")
    : null;
  const vanityNameFromUrlInput = publicProfileUrlInput
    ? normalizePublicProfileVanityName(publicProfileUrlInput, "publicProfileUrl")
    : null;

  if (
    vanityNameFromVanityInput &&
    vanityNameFromUrlInput &&
    vanityNameFromVanityInput.toLowerCase() !== vanityNameFromUrlInput.toLowerCase()
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "vanityName and publicProfileUrl must refer to the same LinkedIn public profile URL.",
      {
        vanity_name: vanityNameFromVanityInput,
        public_profile_url: publicProfileUrlInput
      }
    );
  }

  const vanityName = vanityNameFromVanityInput ?? vanityNameFromUrlInput;
  if (!vanityName) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Public profile update requires vanityName or publicProfileUrl."
    );
  }

  return {
    vanityName,
    publicProfileUrl: buildLinkedInPublicProfileUrl(vanityName)
  };
}

function isPathWithinParent(parentPath: string, targetPath: string): boolean {
  const relativePath = path.relative(parentPath, targetPath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function getArtifactsRootDir(artifacts: ArtifactHelpers): string {
  return path.dirname(artifacts.getRunDir());
}

function slugifyPathComponent(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "upload";
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return hash.digest("hex");
}

function getUploadMimeType(extension: string): string {
  return PROFILE_UPLOAD_MIME_TYPES[extension] ?? "application/octet-stream";
}

function requireFilePath(value: string | undefined, label: string): string {
  const normalizedValue = normalizeText(value);
  if (normalizedValue.length > 0) {
    return normalizedValue;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${label} is required.`
  );
}

function normalizeAbsoluteUrl(value: string | undefined, label: string): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} is required.`
    );
  }

  if (!isAbsoluteUrl(normalizedValue)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be an absolute URL.`,
      {
        value: normalizedValue
      }
    );
  }

  try {
    const parsedUrl = new URL(normalizedValue);
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch (error) {
    throw asLinkedInAssistantError(
      error,
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a valid URL.`
    );
  }
}

function normalizeLinkedInFeaturedPostUrl(value: string | undefined): string {
  const normalizedUrl = normalizeAbsoluteUrl(value, "Featured post URL");

  try {
    const parsedUrl = new URL(normalizedUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    const isLinkedInDomain =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    const pathname = parsedUrl.pathname.toLowerCase();
    const isSupportedPostPath =
      pathname.includes("/feed/update/") ||
      pathname.includes("/posts/") ||
      pathname.includes("/pulse/") ||
      pathname.includes("/newsletters/");

    if (!isLinkedInDomain || !isSupportedPostPath) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Featured post URL must point to a LinkedIn post, article, or newsletter.",
        {
          value: normalizedUrl
        }
      );
    }

    return parsedUrl.toString();
  } catch (error) {
    if (error instanceof LinkedInAssistantError) {
      throw error;
    }

    throw asLinkedInAssistantError(
      error,
      "ACTION_PRECONDITION_FAILED",
      "Featured post URL must be a valid LinkedIn URL."
    );
  }
}

async function stagePreparedUploadArtifact(
  runtime: Pick<LinkedInProfileRuntime, "artifacts">,
  filePath: string | undefined,
  label: string,
  allowedExtensions: readonly string[],
  purpose: string
): Promise<PreparedUploadArtifact> {
  const requestedPath = requireFilePath(filePath, `${label} filePath`);

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(requestedPath);
  } catch (error) {
    throw asLinkedInAssistantError(
      error,
      "ACTION_PRECONDITION_FAILED",
      `${label} file does not exist.`
    );
  }

  const stats = statSync(canonicalPath);
  if (!stats.isFile()) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} filePath must point to a file.`,
      {
        file_path: canonicalPath
      }
    );
  }

  if (stats.size <= 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} file must not be empty.`,
      {
        file_path: canonicalPath
      }
    );
  }

  if (stats.size > MAX_PROFILE_UPLOAD_BYTES) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} file exceeds the supported size limit.`,
      {
        file_path: canonicalPath,
        size_bytes: stats.size,
        max_size_bytes: MAX_PROFILE_UPLOAD_BYTES
      }
    );
  }

  const extension = path.extname(canonicalPath).toLowerCase();
  if (!allowedExtensions.some((candidate) => candidate === extension)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} file type is not supported.`,
      {
        file_path: canonicalPath,
        extension,
        allowed_extensions: [...allowedExtensions]
      }
    );
  }

  const sha256 = await computeFileSha256(canonicalPath);
  const relativePath = `linkedin/input-${purpose}-${Date.now()}-${slugifyPathComponent(
    path.basename(canonicalPath, extension)
  )}${extension}`;
  const absolutePath = runtime.artifacts.resolve(relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  copyFileSync(canonicalPath, absolutePath);

  const mimeType = getUploadMimeType(extension);
  runtime.artifacts.registerArtifact(relativePath, mimeType, {
    purpose,
    file_name: path.basename(canonicalPath),
    size_bytes: stats.size,
    sha256
  });

  return {
    absolute_path: absolutePath,
    relative_path: relativePath,
    file_name: path.basename(canonicalPath),
    extension,
    size_bytes: stats.size,
    sha256,
    mime_type: mimeType
  };
}

async function resolvePreparedUploadArtifact(
  runtime: Pick<LinkedInProfileExecutorRuntime, "artifacts">,
  payload: Record<string, unknown>,
  key: string,
  label: string,
  allowedExtensions: readonly string[]
): Promise<PreparedUploadArtifact> {
  const uploadRecord = getPayloadRecord(payload, key, label);
  const absolutePath = normalizeText(
    typeof uploadRecord.absolute_path === "string" ? uploadRecord.absolute_path : ""
  );
  const expectedRelativePath = normalizeText(
    typeof uploadRecord.relative_path === "string" ? uploadRecord.relative_path : ""
  );
  const expectedFileName = normalizeText(
    typeof uploadRecord.file_name === "string" ? uploadRecord.file_name : ""
  );
  const expectedExtension = normalizeText(
    typeof uploadRecord.extension === "string" ? uploadRecord.extension : ""
  ).toLowerCase();
  const expectedSha256 = normalizeText(
    typeof uploadRecord.sha256 === "string" ? uploadRecord.sha256 : ""
  );
  const expectedMimeType = normalizeText(
    typeof uploadRecord.mime_type === "string" ? uploadRecord.mime_type : ""
  );
  const expectedSizeBytes =
    typeof uploadRecord.size_bytes === "number" && Number.isFinite(uploadRecord.size_bytes)
      ? uploadRecord.size_bytes
      : NaN;

  if (
    absolutePath.length === 0 ||
    expectedRelativePath.length === 0 ||
    expectedFileName.length === 0 ||
    expectedExtension.length === 0 ||
    expectedSha256.length === 0 ||
    expectedMimeType.length === 0 ||
    !Number.isFinite(expectedSizeBytes)
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} payload is missing staged upload details.`
    );
  }

  const normalizedAbsolutePath = path.resolve(absolutePath);
  if (!isPathWithinParent(getArtifactsRootDir(runtime.artifacts), normalizedAbsolutePath)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} upload artifact escapes the assistant artifacts directory.`,
      {
        artifact_path: normalizedAbsolutePath
      }
    );
  }

  const stats = statSync(normalizedAbsolutePath);
  if (!stats.isFile()) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} upload artifact is missing.`,
      {
        artifact_path: normalizedAbsolutePath
      }
    );
  }

  const actualExtension = path.extname(normalizedAbsolutePath).toLowerCase();
  if (!allowedExtensions.some((candidate) => candidate === actualExtension)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} upload artifact type is no longer supported.`,
      {
        artifact_path: normalizedAbsolutePath,
        extension: actualExtension,
        allowed_extensions: [...allowedExtensions]
      }
    );
  }

  if (stats.size !== expectedSizeBytes) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} upload artifact size no longer matches the prepared file.`,
      {
        artifact_path: normalizedAbsolutePath,
        expected_size_bytes: expectedSizeBytes,
        actual_size_bytes: stats.size
      }
    );
  }

  const actualSha256 = await computeFileSha256(normalizedAbsolutePath);
  if (actualSha256 !== expectedSha256) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} upload artifact contents changed after preparation.`,
      {
        artifact_path: normalizedAbsolutePath,
        expected_sha256: expectedSha256,
        actual_sha256: actualSha256
      }
    );
  }

  return {
    absolute_path: normalizedAbsolutePath,
    relative_path: expectedRelativePath,
    file_name: expectedFileName,
    extension: actualExtension,
    size_bytes: stats.size,
    sha256: actualSha256,
    mime_type: expectedMimeType
  };
}

function buildPreparedUploadPreview(upload: PreparedUploadArtifact): Record<string, unknown> {
  return {
    file_name: upload.file_name,
    mime_type: upload.mime_type,
    size_bytes: upload.size_bytes,
    artifact_path: upload.relative_path,
    sha256_prefix: upload.sha256.slice(0, 12)
  };
}

function normalizeProfileFeaturedItemKind(
  value: string
): LinkedInProfileFeaturedItemKind {
  const normalizedValue = normalizeFieldKey(value);

  switch (normalizedValue) {
    case "link":
    case "url":
      return "link";
    case "media":
    case "file":
    case "document":
    case "image":
      return "media";
    case "post":
    case "article":
    case "newsletter":
      return "post";
    default:
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `kind must be one of: ${LINKEDIN_PROFILE_FEATURED_ITEM_KINDS.join(", ")}.`,
        {
          provided_kind: value
        }
      );
  }
}

function inferFeaturedItemKind(
  url: string | null,
  rawText: string
): LinkedInProfileFeaturedItemKind {
  const normalizedUrl = normalizeText(url);
  if (normalizedUrl) {
    try {
      const parsedUrl = new URL(normalizedUrl);
      const hostname = parsedUrl.hostname.toLowerCase();
      const pathname = parsedUrl.pathname.toLowerCase();
      const isLinkedInDomain =
        hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
      const isLinkedInMediaHost = hostname.endsWith(".licdn.com");

      if (
        isLinkedInDomain &&
        (pathname.includes("/feed/update/") ||
          pathname.includes("/posts/") ||
          pathname.includes("/pulse/") ||
          pathname.includes("/newsletters/"))
      ) {
        return "post";
      }

      if (isLinkedInMediaHost || pathname.includes("/dms/") || pathname.includes("/media/")) {
        return "media";
      }

      return "link";
    } catch {
      return "link";
    }
  }

  return /newsletter|article|post/i.test(rawText) ? "post" : "media";
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

function getFeaturedActionLabels(
  action: keyof typeof PROFILE_FEATURED_LABELS,
  locale: LinkedInSelectorLocale
): string[] {
  return getLocalizedLabels(PROFILE_FEATURED_LABELS[action], locale);
}

function getProfileMediaActionLabels(
  action: keyof typeof PROFILE_MEDIA_LABELS,
  locale: LinkedInSelectorLocale
): string[] {
  return getLocalizedLabels(PROFILE_MEDIA_LABELS[action], locale);
}

function getPublicProfileActionLabels(
  action: keyof typeof PUBLIC_PROFILE_LABELS,
  locale: LinkedInSelectorLocale
): string[] {
  return getLocalizedLabels(PUBLIC_PROFILE_LABELS[action], locale);
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

function createProfileFeaturedItemFingerprint(
  input: Pick<
    DecodedProfileFeaturedItemId,
    "kind" | "sourceId" | "url" | "title" | "subtitle" | "rawText"
  >
): string {
  const hash = createHash("sha256");
  hash.update(input.kind);
  hash.update("\u001f");
  hash.update(normalizeText(input.sourceId));
  hash.update("\u001f");
  hash.update(normalizeText(input.url));
  hash.update("\u001f");
  hash.update(normalizeText(input.title));
  hash.update("\u001f");
  hash.update(normalizeText(input.subtitle));
  hash.update("\u001f");
  hash.update(normalizeText(input.rawText));
  return hash.digest("base64url").slice(0, 18);
}

function createProfileFeaturedItemId(
  identity: DecodedProfileFeaturedItemId
): string {
  const payload = {
    v: 1,
    kind: identity.kind,
    sourceId: normalizeText(identity.sourceId),
    url: normalizeText(identity.url),
    title: normalizeText(identity.title),
    subtitle: normalizeText(identity.subtitle),
    rawText: normalizeText(identity.rawText)
  };

  return `${PROFILE_FEATURED_ITEM_ID_PREFIX}${Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url")}`;
}

function decodeProfileFeaturedItemId(
  itemId: string | undefined
): DecodedProfileFeaturedItemId | null {
  if (!itemId || !itemId.startsWith(PROFILE_FEATURED_ITEM_ID_PREFIX)) {
    return null;
  }

  try {
    const decoded = Buffer.from(
      itemId.slice(PROFILE_FEATURED_ITEM_ID_PREFIX.length),
      "base64url"
    ).toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!isRecord(parsed) || typeof parsed.kind !== "string") {
      return null;
    }

    return {
      kind: normalizeProfileFeaturedItemKind(parsed.kind),
      ...(typeof parsed.sourceId === "string"
        ? { sourceId: normalizeText(parsed.sourceId) }
        : {}),
      ...(typeof parsed.url === "string" ? { url: normalizeText(parsed.url) } : {}),
      ...(typeof parsed.title === "string"
        ? { title: normalizeText(parsed.title) }
        : {}),
      ...(typeof parsed.subtitle === "string"
        ? { subtitle: normalizeText(parsed.subtitle) }
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

function normalizeProfileFeaturedItemMatch(
  match: LinkedInProfileFeaturedItemMatch | Record<string, unknown> | undefined,
  itemId: string | undefined
): LinkedInProfileFeaturedItemMatch | undefined {
  const decodedItem = decodeProfileFeaturedItemId(itemId);
  const candidate = isRecord(match) ? match : {};

  const normalized = {
    ...(decodedItem?.sourceId ? { sourceId: decodedItem.sourceId } : {}),
    ...(decodedItem?.url ? { url: decodedItem.url } : {}),
    ...(decodedItem?.title ? { title: decodedItem.title } : {}),
    ...(decodedItem?.subtitle ? { subtitle: decodedItem.subtitle } : {}),
    ...(decodedItem?.rawText ? { rawText: decodedItem.rawText } : {}),
    ...(typeof candidate.sourceId === "string"
      ? { sourceId: normalizeText(candidate.sourceId) }
      : {}),
    ...(typeof candidate.source_id === "string"
      ? { sourceId: normalizeText(candidate.source_id) }
      : {}),
    ...(typeof candidate.url === "string" ? { url: normalizeText(candidate.url) } : {}),
    ...(typeof candidate.title === "string"
      ? { title: normalizeText(candidate.title) }
      : {}),
    ...(typeof candidate.subtitle === "string"
      ? { subtitle: normalizeText(candidate.subtitle) }
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
    !normalized.url &&
    !normalized.title &&
    !normalized.subtitle &&
    !normalized.rawText
  ) {
    return undefined;
  }

  return normalized;
}

interface LocatorCandidate {
  key: string;
  locator: Locator;
}

interface FindDialogFieldOptions {
  allowHidden?: boolean;
}

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function isLocatorAttached(locator: Locator): Promise<boolean> {
  try {
    return (await locator.count()) > 0;
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

async function waitForVisibleOverlay(page: Page): Promise<Locator> {
  const overlay = page.locator("[role='dialog'], [role='menu']").last();
  await overlay.waitFor({ state: "visible", timeout: 10_000 });
  return overlay;
}

async function clickLocatorAndWaitForDialog(
  page: Page,
  locator: Locator
): Promise<Locator> {
  await locator.first().click();
  return waitForVisibleDialog(page);
}

async function clickLocatorAndWaitForOverlay(
  page: Page,
  locator: Locator
): Promise<Locator> {
  await locator.first().click();
  return waitForVisibleOverlay(page);
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

async function findFeaturedSectionRoot(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator | null> {
  const headingRegex = buildTextRegex(getFeaturedActionLabels("section", selectorLocale), true);
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

async function readExtractedFeaturedItem(
  locator: Locator
): Promise<ExtractedEditableFeaturedItem> {
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

    const urlCandidates = Array.from(root.querySelectorAll("a[href]"))
      .map((candidate) => candidate.getAttribute("href"))
      .filter((candidate): candidate is string => typeof candidate === "string")
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

    const rawText = normalize(root.textContent);
    if (lines.length === 0 && rawText) {
      lines = rawText
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter((line) => line.length > 0);
    }

    const title = lines[0] ?? "";
    const subtitle = lines[1] ?? "";
    const description =
      lines
        .slice(2)
        .filter((line) => line !== title && line !== subtitle)
        .join(" ") || rawText;

    return {
      source_id: sourceCandidates[0] ?? null,
      title,
      subtitle,
      description,
      url: urlCandidates[0] ?? null,
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

function doesFeaturedItemMatch(
  candidate: ExtractedEditableFeaturedItem,
  match: LinkedInProfileFeaturedItemMatch
): boolean {
  const candidateSourceId = normalizeText(candidate.source_id);
  const candidateUrl = normalizeText(candidate.url);
  const candidateTitle = normalizeText(candidate.title);
  const candidateSubtitle = normalizeText(candidate.subtitle);
  const candidateRawText = normalizeText(candidate.raw_text);

  if (match.sourceId && candidateSourceId) {
    if (candidateSourceId === normalizeText(match.sourceId)) {
      return true;
    }
  }

  let matchedFieldCount = 0;
  const comparisons: Array<[string | undefined, string]> = [
    [match.url, candidateUrl],
    [match.title, candidateTitle],
    [match.subtitle, candidateSubtitle],
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

async function findMatchingFeaturedItemLocator(
  sectionRoot: Locator,
  match: LinkedInProfileFeaturedItemMatch
): Promise<Locator | null> {
  const items = sectionRoot.locator(
    ".pvs-list__paged-list-item, .pvs-list__item--line-separated, li.artdeco-list__item, li[class*='pvs-list__item']"
  );
  const itemCount = await items.count();

  for (let index = 0; index < itemCount; index += 1) {
    const candidate = items.nth(index);
    const extracted = await readExtractedFeaturedItem(candidate);
    if (doesFeaturedItemMatch(extracted, match)) {
      return candidate;
    }
  }

  return null;
}

async function openIntroEditDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const topCardRoot = page.locator("main").first();
  const introEditLabels = getUiActionLabels("editIntro", selectorLocale);
  const globalIntroEditButton = page
    .locator(buildAriaLabelContainsSelector("button", introEditLabels))
    .first();

  if (await isLocatorAttached(globalIntroEditButton)) {
    return clickLocatorAndWaitForDialog(page, globalIntroEditButton);
  }

  const editCandidates: LocatorCandidate[] = [
    ...createActionCandidates(
      topCardRoot,
      introEditLabels,
      "intro-edit-specific"
    ),
    {
      key: "intro-edit-aria-label",
      locator: topCardRoot.locator(
        buildAriaLabelContainsSelector(
          "button",
          introEditLabels
        )
      )
    },
    ...createActionCandidates(
      topCardRoot,
      getUiActionLabels("edit", selectorLocale),
      "intro-edit"
    )
  ];
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
  definition: EditableFieldDefinition,
  options: FindDialogFieldOptions = {}
): Promise<Locator | null> {
  const labelRegex = buildTextRegex(definition.aliases);
  const byLabel = dialog.getByLabel(labelRegex).first();
  if (await isLocatorVisible(byLabel)) {
    return byLabel;
  }

  let hiddenMatch =
    options.allowHidden && (await isLocatorAttached(byLabel)) ? byLabel : null;

  for (const alias of definition.aliases) {
    const labelLocator = dialog
      .locator("label")
      .filter({ hasText: buildTextRegex([alias]) })
      .first();
    if (
      (await isLocatorVisible(labelLocator)) ||
      (options.allowHidden && (await isLocatorAttached(labelLocator)))
    ) {
      const labelFor = await labelLocator.getAttribute("for").catch(() => null);
      if (labelFor) {
        const byId = dialog
          .locator(`[id="${escapeCssAttributeValue(labelFor)}"]`)
          .first();
        if (await isLocatorVisible(byId)) {
          return byId;
        }
        if (!hiddenMatch && options.allowHidden && (await isLocatorAttached(byId))) {
          hiddenMatch = byId;
        }
      }

      const siblingField = labelLocator
        .locator(
          "xpath=following::*[(self::input or self::textarea or self::select or @role='combobox')][1]"
        )
        .first();
      if (await isLocatorVisible(siblingField)) {
        return siblingField;
      }
      if (
        !hiddenMatch &&
        options.allowHidden &&
        (await isLocatorAttached(siblingField))
      ) {
        hiddenMatch = siblingField;
      }
    }

    const normalizedAlias = normalizeText(alias).toLowerCase();
    const xpath = dialog
      .locator(
        `xpath=.//label[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ', 'abcdefghijklmnopqrstuvwxyzæøå'), "${normalizedAlias}")]/following::*[(self::input or self::textarea or self::select or @role='combobox')][1]`
      )
      .first();
    if (await isLocatorVisible(xpath)) {
      return xpath;
    }

    if (!hiddenMatch && options.allowHidden && (await isLocatorAttached(xpath))) {
      hiddenMatch = xpath;
    }
  }

  return hiddenMatch;
}

async function waitForDialogFieldLocator(
  dialog: Locator,
  definition: EditableFieldDefinition,
  options: FindDialogFieldOptions = {},
  timeoutMs = 5_000
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const locator = await findDialogFieldLocator(dialog, definition, options);
    if (locator) {
      return locator;
    }

    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 250);
    });
  }

  return null;
}

async function fillDialogField(
  page: Page,
  dialog: Locator,
  definition: EditableFieldDefinition,
  value: NormalizedEditableValue
): Promise<void> {
  const locator = await waitForDialogFieldLocator(dialog, definition, {
    allowHidden: true
  });
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
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
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

async function extractEditableFeaturedSection(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<LinkedInProfileEditableFeaturedSection> {
  const featuredRoot = await findFeaturedSectionRoot(page, selectorLocale);
  if (!featuredRoot) {
    return {
      label: getFeaturedActionLabels("section", selectorLocale)[0] ?? "Featured",
      can_add: true,
      can_remove: true,
      can_reorder: false,
      supported_kinds: [...LINKEDIN_PROFILE_FEATURED_ITEM_KINDS],
      items: []
    };
  }

  const itemLocators = featuredRoot.locator(
    ".pvs-list__paged-list-item, .pvs-list__item--line-separated, li.artdeco-list__item, li[class*='pvs-list__item']"
  );
  const itemCount = await itemLocators.count();
  const items: LinkedInProfileEditableFeaturedItem[] = [];

  for (let index = 0; index < itemCount; index += 1) {
    const extracted = await readExtractedFeaturedItem(itemLocators.nth(index));
    if (
      !extracted.title &&
      !extracted.subtitle &&
      !extracted.description &&
      !extracted.raw_text &&
      !extracted.url
    ) {
      continue;
    }

    const kind = inferFeaturedItemKind(extracted.url, extracted.raw_text);
    items.push({
      item_id: createProfileFeaturedItemId({
        kind,
        ...(extracted.source_id ? { sourceId: extracted.source_id } : {}),
        ...(extracted.url ? { url: extracted.url } : {}),
        title: extracted.title,
        subtitle: extracted.subtitle,
        rawText: extracted.raw_text
      }),
      position: items.length + 1,
      kind,
      title: normalizeText(extracted.title),
      subtitle: normalizeText(extracted.subtitle),
      description: normalizeText(extracted.description),
      url: extracted.url ? normalizeText(extracted.url) : null,
      raw_text: normalizeText(extracted.raw_text),
      source_id: extracted.source_id ? normalizeText(extracted.source_id) : null
    });
  }

  return {
    label: getFeaturedActionLabels("section", selectorLocale)[0] ?? "Featured",
    can_add: true,
    can_remove: true,
    can_reorder: items.length > 1,
    supported_kinds: [...LINKEDIN_PROFILE_FEATURED_ITEM_KINDS],
    items
  };
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

async function getVisibleDialogOrNull(page: Page): Promise<Locator | null> {
  const dialog = page.locator("[role='dialog']").last();
  return (await isLocatorVisible(dialog)) ? dialog : null;
}

async function findVisibleFileInput(root: Page | Locator): Promise<Locator | null> {
  const inputs = root.locator("input[type='file']");
  const count = Math.min(await inputs.count().catch(() => 0), 4);
  let fallback: Locator | null = null;

  for (let index = 0; index < count; index += 1) {
    const candidate = inputs.nth(index);
    if (!fallback) {
      fallback = candidate;
    }
    try {
      if (await candidate.isVisible()) {
        return candidate;
      }
    } catch {
      // Ignore detached/hidden file inputs.
    }
  }

  return fallback;
}

async function findVisibleTextInput(root: Page | Locator): Promise<Locator | null> {
  const selectors = [
    "input[type='text']",
    "input[role='combobox']",
    "input:not([type])"
  ];

  for (const selector of selectors) {
    const inputs = root.locator(selector);
    const count = Math.min(await inputs.count().catch(() => 0), 8);

    for (let index = 0; index < count; index += 1) {
      const candidate = inputs.nth(index);
      if (await isLocatorVisible(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function clickLocatorForUpload(
  page: Page,
  locator: Locator,
  filePath: string
): Promise<{ surface: Locator | null; uploaded: boolean }> {
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 1_200 }).catch(
    () => null
  );
  await locator.first().click();
  const fileChooser = await fileChooserPromise;

  if (fileChooser) {
    await fileChooser.setFiles(filePath);
    return {
      surface: await getVisibleDialogOrNull(page),
      uploaded: true
    };
  }

  const overlay = page.locator("[role='dialog'], [role='menu']").last();
  if (await isLocatorVisible(overlay)) {
    const input = await findVisibleFileInput(overlay);
    if (input) {
      await input.setInputFiles(filePath);
      return {
        surface: overlay,
        uploaded: true
      };
    }

    return {
      surface: overlay,
      uploaded: false
    };
  }

  const pageInput = await findVisibleFileInput(page);
  if (pageInput) {
    await pageInput.setInputFiles(filePath);
    return {
      surface: await getVisibleDialogOrNull(page),
      uploaded: true
    };
  }

  return {
    surface: null,
    uploaded: false
  };
}

async function uploadFileFromSurface(
  page: Page,
  surface: Page | Locator,
  filePath: string,
  uploadLabels: readonly string[],
  keyPrefix: string
): Promise<{ surface: Locator | null; uploaded: boolean }> {
  const surfaceInput = await findVisibleFileInput(surface);
  if (surfaceInput) {
    await surfaceInput.setInputFiles(filePath);
    const surfaceLocator = surface === page ? null : (surface as Locator);
    return {
      surface: surfaceLocator ?? (await getVisibleDialogOrNull(page)),
      uploaded: true
    };
  }

  const pageInput = await findVisibleFileInput(page);
  if (pageInput) {
    await pageInput.setInputFiles(filePath);
    return {
      surface: await getVisibleDialogOrNull(page),
      uploaded: true
    };
  }

  const candidates: LocatorCandidate[] = [
    ...createActionCandidates(surface, uploadLabels, `${keyPrefix}-button`),
    ...createActionCandidates(surface, uploadLabels, `${keyPrefix}-link`, "link"),
    {
      key: `${keyPrefix}-generic`,
      locator: surface
        .locator("button, a, [role='button']")
        .filter({ hasText: buildTextRegex(uploadLabels) })
    }
  ];

  for (const candidate of candidates) {
    if (!(await isLocatorVisible(candidate.locator))) {
      continue;
    }

    const result = await clickLocatorForUpload(page, candidate.locator, filePath);
    if (result.uploaded || result.surface) {
      return result;
    }
  }

  return {
    surface: null,
    uploaded: false
  };
}

async function openFeaturedAddSurface(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const featuredRoot = await findFeaturedSectionRoot(page, selectorLocale);

  if (featuredRoot) {
    const addCandidates = createActionCandidates(
      featuredRoot,
      getUiActionLabels("add", selectorLocale),
      "featured-add"
    );
    const resolvedAdd = await findFirstVisibleLocator(addCandidates);
    if (resolvedAdd) {
      return clickLocatorAndWaitForOverlay(page, resolvedAdd.locator);
    }
  }

  const addSectionDialog = await openGlobalAddSectionDialog(page, selectorLocale);
  const featuredCandidates: LocatorCandidate[] = [
    ...createActionCandidates(
      addSectionDialog,
      getFeaturedActionLabels("section", selectorLocale),
      "featured-global"
    ),
    ...createActionCandidates(
      addSectionDialog,
      getFeaturedActionLabels("section", selectorLocale),
      "featured-global-link",
      "link"
    ),
    {
      key: "featured-global-generic",
      locator: addSectionDialog
        .locator("button, a, div[role='button'], li")
        .filter({ hasText: buildTextRegex(getFeaturedActionLabels("section", selectorLocale)) })
    }
  ];

  const resolvedFeatured = await findFirstVisibleLocator(featuredCandidates);
  if (!resolvedFeatured) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the Featured section add flow on the profile page."
    );
  }

  await resolvedFeatured.locator.first().click();
  await page.waitForTimeout(400);
  return waitForVisibleOverlay(page);
}

async function selectFeaturedAddOption(
  page: Page,
  overlay: Locator,
  kind: LinkedInProfileFeaturedItemKind,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const labels =
    kind === "link"
      ? getFeaturedActionLabels("addLink", selectorLocale)
      : kind === "media"
        ? getFeaturedActionLabels("addMedia", selectorLocale)
        : getFeaturedActionLabels("addPost", selectorLocale);

  const candidates: LocatorCandidate[] = [
    ...createActionCandidates(overlay, labels, `featured-add-${kind}`),
    ...createActionCandidates(overlay, labels, `featured-add-${kind}-link`, "link"),
    {
      key: `featured-add-${kind}-generic`,
      locator: overlay
        .locator("button, a, div[role='button'], li")
        .filter({ hasText: buildTextRegex(labels) })
    }
  ];

  const resolved = await findFirstVisibleLocator(candidates);
  if (!resolved) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      `Could not find the Featured ${kind} add option.`
    );
  }

  await resolved.locator.first().click();
  await page.waitForTimeout(400);
  return (await getVisibleDialogOrNull(page)) ?? overlay;
}

async function openFeaturedEditDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const featuredRoot = await findFeaturedSectionRoot(page, selectorLocale);
  if (!featuredRoot) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the Featured section on the profile page."
    );
  }

  const editCandidates = createActionCandidates(
    featuredRoot,
    getUiActionLabels("edit", selectorLocale),
    "featured-edit"
  );
  const resolvedEdit = await findFirstVisibleLocator(editCandidates);
  if (!resolvedEdit) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the Featured edit control on the profile page."
    );
  }

  return clickLocatorAndWaitForDialog(page, resolvedEdit.locator);
}

async function fillDialogFieldIfPresent(
  page: Page,
  dialog: Locator,
  definition: EditableFieldDefinition,
  value: NormalizedEditableValue | undefined
): Promise<void> {
  if (value === undefined) {
    return;
  }

  const locator = await waitForDialogFieldLocator(dialog, definition, {
    allowHidden: true
  });
  if (!locator) {
    return;
  }

  await fillDialogField(page, dialog, definition, value);
}

async function readEditableFieldValue(locator: Locator): Promise<string> {
  const inputValue = await locator.inputValue().catch(() => "");
  if (normalizeText(inputValue)) {
    return normalizeText(inputValue);
  }

  const fallbackValue = await locator
    .evaluate((element) => {
      const valueAttribute = element.getAttribute("value");
      if (typeof valueAttribute === "string" && valueAttribute.trim().length > 0) {
        return valueAttribute;
      }

      return element.textContent ?? "";
    })
    .catch(() => "");

  return normalizeText(fallbackValue);
}

async function closeVisibleDialog(
  page: Page,
  dialog: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<void> {
  const closeCandidates: LocatorCandidate[] = [
    ...createActionCandidates(dialog, getUiActionLabels("close", selectorLocale), "dialog-close"),
    {
      key: "dialog-close-icon-button",
      locator: dialog.locator("button[aria-label*='close' i], button[aria-label*='dismiss' i]")
    }
  ];
  const resolved = await findFirstVisibleLocator(closeCandidates);

  if (resolved) {
    await resolved.locator.first().click().catch(() => undefined);
  } else {
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
}

function normalizeComparableUrl(value: string): string {
  try {
    const parsedUrl = new URL(value);
    parsedUrl.hash = "";
    parsedUrl.search = "";
    return parsedUrl.toString().replace(/\/+$/, "");
  } catch {
    return normalizeText(value).replace(/\/+$/, "");
  }
}

async function selectFeaturedPostInDialog(dialog: Locator, postUrl: string): Promise<void> {
  const normalizedPostUrl = normalizeComparableUrl(postUrl);
  const rows = dialog.locator(
    "li, [role='listitem'], .artdeco-list__item, .pvs-list__paged-list-item"
  );
  const rowCount = await rows.count();

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    const hrefs = await row
      .locator("a[href]")
      .evaluateAll((anchors) =>
        anchors
          .map((anchor) => anchor.getAttribute("href") ?? "")
          .filter((href) => href.length > 0)
      )
      .catch(() => [] as string[]);

    if (
      hrefs.some((href) => normalizeComparableUrl(href) === normalizedPostUrl) ||
      hrefs.some((href) => normalizeComparableUrl(href).includes(normalizedPostUrl))
    ) {
      const selectionControl = row.locator("input[type='checkbox'], button, [role='button']").first();
      if (await isLocatorVisible(selectionControl)) {
        await selectionControl.click().catch(async () => {
          await row.click();
        });
      } else {
        await row.click();
      }
      return;
    }
  }

  throw new LinkedInAssistantError(
    "TARGET_NOT_FOUND",
    "Could not find the requested post in the Featured post picker.",
    {
      post_url: postUrl
    }
  );
}

async function addFeaturedLink(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  url: string,
  title: string | undefined,
  description: string | undefined
): Promise<void> {
  const overlay = await openFeaturedAddSurface(page, selectorLocale);
  const dialog = await selectFeaturedAddOption(page, overlay, "link", selectorLocale);

  await fillDialogField(page, dialog, FEATURED_LINK_FIELD_DEFINITIONS[0], url);
  await page.waitForTimeout(300);
  await fillDialogFieldIfPresent(page, dialog, FEATURED_LINK_FIELD_DEFINITIONS[1], title);
  await fillDialogFieldIfPresent(page, dialog, FEATURED_LINK_FIELD_DEFINITIONS[2], description);
  await clickSaveInDialog(page, dialog, selectorLocale);
}

async function addFeaturedMedia(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  upload: PreparedUploadArtifact,
  title: string | undefined,
  description: string | undefined
): Promise<void> {
  const overlay = await openFeaturedAddSurface(page, selectorLocale);
  const dialogOrMenu = await selectFeaturedAddOption(page, overlay, "media", selectorLocale);
  const uploadResult = await uploadFileFromSurface(
    page,
    dialogOrMenu,
    upload.absolute_path,
    getProfileMediaActionLabels("upload", selectorLocale),
    "featured-media-upload"
  );

  if (!uploadResult.uploaded) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find a file upload control for the Featured media flow."
    );
  }

  const dialog =
    (await getVisibleDialogOrNull(page)) ?? uploadResult.surface ?? dialogOrMenu;
  await fillDialogFieldIfPresent(page, dialog, FEATURED_MEDIA_FIELD_DEFINITIONS[0], title);
  await fillDialogFieldIfPresent(
    page,
    dialog,
    FEATURED_MEDIA_FIELD_DEFINITIONS[1],
    description
  );
  await clickSaveInDialog(page, dialog, selectorLocale);
}

async function addFeaturedPost(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  postUrl: string
): Promise<void> {
  const overlay = await openFeaturedAddSurface(page, selectorLocale);
  const dialog = await selectFeaturedAddOption(page, overlay, "post", selectorLocale);
  await selectFeaturedPostInDialog(dialog, postUrl);
  await clickSaveInDialog(page, dialog, selectorLocale);
}

async function openFeaturedItemMenu(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  match: LinkedInProfileFeaturedItemMatch
): Promise<Locator> {
  const featuredRoot = await findFeaturedSectionRoot(page, selectorLocale);
  if (!featuredRoot) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the Featured section on the profile page."
    );
  }

  const itemLocator = await findMatchingFeaturedItemLocator(featuredRoot, match);
  if (!itemLocator) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find a matching item in the Featured section.",
      {
        match
      }
    );
  }

  const moreCandidates = createActionCandidates(
    itemLocator,
    getUiActionLabels("more", selectorLocale),
    "featured-item-more"
  );
  const resolvedMore = await findFirstVisibleLocator(moreCandidates);
  if (!resolvedMore) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the Featured item actions menu."
    );
  }

  return clickLocatorAndWaitForOverlay(page, resolvedMore.locator);
}

async function removeFeaturedItem(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  match: LinkedInProfileFeaturedItemMatch
): Promise<void> {
  const overlay = await openFeaturedItemMenu(page, selectorLocale, match);
  const removeCandidates: LocatorCandidate[] = [
    ...createActionCandidates(overlay, getFeaturedActionLabels("remove", selectorLocale), "featured-remove"),
    {
      key: "featured-remove-generic",
      locator: overlay
        .locator("[role='menuitem'], button, div[role='button']")
        .filter({ hasText: buildTextRegex(getFeaturedActionLabels("remove", selectorLocale)) })
    }
  ];
  const resolvedRemove = await findFirstVisibleLocator(removeCandidates);
  if (!resolvedRemove) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the remove-from-featured action for the selected item."
    );
  }

  await resolvedRemove.locator.first().click();
  await page.waitForTimeout(400);

  const confirmationDialog = await getVisibleDialogOrNull(page);
  if (confirmationDialog) {
    const confirmationCandidates: LocatorCandidate[] = [
      ...createActionCandidates(
        confirmationDialog,
        getFeaturedActionLabels("remove", selectorLocale),
        "featured-remove-confirm"
      ),
      ...createActionCandidates(
        confirmationDialog,
        getUiActionLabels("delete", selectorLocale),
        "featured-remove-confirm-delete"
      )
    ];
    const resolvedConfirmation = await findFirstVisibleLocator(confirmationCandidates);
    if (resolvedConfirmation) {
      await resolvedConfirmation.locator.first().click();
    }
  }

  await waitForNetworkIdleBestEffort(page);
}

async function findMatchingFeaturedDialogRow(
  dialog: Locator,
  match: LinkedInProfileFeaturedItemMatch
): Promise<{ row: Locator; index: number } | null> {
  const rows = dialog.locator(
    "li, [role='listitem'], .artdeco-list__item, .pvs-list__paged-list-item"
  );
  const rowCount = await rows.count();

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    const extracted = await readExtractedFeaturedItem(row);
    if (doesFeaturedItemMatch(extracted, match)) {
      return { row, index };
    }
  }

  return null;
}

async function findVisibleDragHandle(row: Locator): Promise<Locator | null> {
  const selectors = [
    "[aria-label*='Move' i]",
    "[aria-roledescription*='drag' i]",
    "button[draggable='true']",
    "[draggable='true']"
  ];

  for (const selector of selectors) {
    const handle = row.locator(selector).first();
    if (await isLocatorVisible(handle)) {
      return handle;
    }
  }

  return null;
}

async function dragLocatorToTarget(
  page: Page,
  source: Locator,
  target: Locator
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not resolve drag handles while reordering Featured items."
    );
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + Math.max(targetBox.width / 2, 8),
    targetBox.y + Math.min(targetBox.height / 4, 12),
    { steps: 20 }
  );
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function reorderFeaturedItems(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  itemIds: string[]
): Promise<void> {
  const dialog = await openFeaturedEditDialog(page, selectorLocale);
  const decodedItems = itemIds.map((itemId) => {
    const decoded = decodeProfileFeaturedItemId(itemId);
    if (!decoded) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Featured reorder requires itemIds returned by view_editable.featured.items.",
        {
          item_id: itemId
        }
      );
    }

    return decoded;
  });

  for (let index = decodedItems.length - 1; index >= 0; index -= 1) {
    const decoded = decodedItems[index]!;
    const match: LinkedInProfileFeaturedItemMatch = {
      ...(decoded.sourceId ? { sourceId: decoded.sourceId } : {}),
      ...(decoded.url ? { url: decoded.url } : {}),
      ...(decoded.title ? { title: decoded.title } : {}),
      ...(decoded.subtitle ? { subtitle: decoded.subtitle } : {}),
      ...(decoded.rawText ? { rawText: decoded.rawText } : {})
    };
    const locatedRow = await findMatchingFeaturedDialogRow(dialog, match);
    if (!locatedRow) {
      throw new LinkedInAssistantError(
        "TARGET_NOT_FOUND",
        "Could not find one of the requested Featured items in the reorder dialog.",
        {
          match
        }
      );
    }

    if (locatedRow.index === 0) {
      continue;
    }

    const firstRow = dialog
      .locator("li, [role='listitem'], .artdeco-list__item, .pvs-list__paged-list-item")
      .first();
    const sourceHandle = (await findVisibleDragHandle(locatedRow.row)) ?? locatedRow.row;
    const targetHandle = (await findVisibleDragHandle(firstRow)) ?? firstRow;
    await dragLocatorToTarget(page, sourceHandle, targetHandle);
  }

  await clickSaveInDialog(page, dialog, selectorLocale);
}

async function openProfileMediaAndUpload(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  kind: "photo" | "banner",
  upload: PreparedUploadArtifact
): Promise<Locator | null> {
  const topCardRoot = getTopCardRoot(page);
  const openCandidates: LocatorCandidate[] = [
    ...createActionCandidates(
      topCardRoot,
      getProfileMediaActionLabels(kind, selectorLocale),
      `profile-${kind}`
    ),
    ...createActionCandidates(
      topCardRoot,
      getProfileMediaActionLabels(kind, selectorLocale),
      `profile-${kind}-link`,
      "link"
    ),
    {
      key: `profile-${kind}-generic`,
      locator: topCardRoot
        .locator("button, a, [role='button']")
        .filter({ hasText: buildTextRegex(getProfileMediaActionLabels(kind, selectorLocale)) })
    }
  ];

  for (const candidate of openCandidates) {
    if (!(await isLocatorVisible(candidate.locator))) {
      continue;
    }

    const result = await clickLocatorForUpload(page, candidate.locator, upload.absolute_path);
    if (result.uploaded) {
      return (await getVisibleDialogOrNull(page)) ?? result.surface;
    }

    const followUpSurface = result.surface ?? topCardRoot;
    const followUpUpload = await uploadFileFromSurface(
      page,
      followUpSurface,
      upload.absolute_path,
      getProfileMediaActionLabels("upload", selectorLocale),
      `profile-${kind}-upload`
    );
    if (followUpUpload.uploaded) {
      return (await getVisibleDialogOrNull(page)) ?? followUpUpload.surface;
    }
  }

  throw new LinkedInAssistantError(
    "TARGET_NOT_FOUND",
    `Could not find the LinkedIn profile ${kind} upload controls.`
  );
}

async function extractEditableSettings(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<LinkedInProfileEditableSettings> {
  const settings: LinkedInProfileEditableSettings = {
    industry: "",
    supported_fields: ["industry"]
  };
  let dialog: Locator | null = null;

  try {
    const introEditButton = page
      .locator(
        buildAriaLabelContainsSelector(
          "button",
          getUiActionLabels("editIntro", selectorLocale)
        )
      )
      .first();
    if (!(await isLocatorAttached(introEditButton))) {
      return settings;
    }

    dialog = await clickLocatorAndWaitForDialog(page, introEditButton);
    const industryLabel = dialog
      .locator("label")
      .filter({
        hasText: buildTextRegex(PROFILE_SETTINGS_FIELD_DEFINITIONS[0].aliases)
      })
      .first();
    const labelFor = await industryLabel.getAttribute("for").catch(() => null);
    const industryField = labelFor
      ? dialog.locator(`[id="${escapeCssAttributeValue(labelFor)}"]`).first()
      : await findDialogFieldLocator(dialog, PROFILE_SETTINGS_FIELD_DEFINITIONS[0], {
          allowHidden: true
        });

    if (industryField && (await isLocatorAttached(industryField))) {
      settings.industry = await readEditableFieldValue(industryField);
    }
  } catch {
    return settings;
  } finally {
    if (dialog) {
      await closeVisibleDialog(page, dialog, selectorLocale).catch(() => undefined);
    }
  }

  return settings;
}

function buildFallbackEditablePublicProfile(
  profile: LinkedInProfile
): LinkedInProfileEditablePublicProfile {
  const vanityName = normalizeText(profile.vanity_name);
  return {
    vanity_name: vanityName,
    public_profile_url: vanityName
      ? buildLinkedInPublicProfileUrl(vanityName)
      : normalizeLinkedInProfileUrl(profile.profile_url),
    supported_fields: ["vanityName", "publicProfileUrl"]
  };
}

async function extractEditablePublicProfile(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  profile: LinkedInProfile
): Promise<LinkedInProfileEditablePublicProfile> {
  const fallbackProfile = buildFallbackEditablePublicProfile(profile);

  try {
    await navigateToPublicProfileSettings(page);
    let vanityInput = page.locator("input[name='vanityName'], input#vanityUrlForm").first();

    if (!(await isLocatorVisible(vanityInput))) {
      vanityInput = (await openPublicProfileCustomUrlEditor(page, selectorLocale)).input;
    }

    const vanityName = await readEditableFieldValue(vanityInput);
    if (!vanityName) {
      return fallbackProfile;
    }

    return {
      vanity_name: vanityName,
      public_profile_url: buildLinkedInPublicProfileUrl(vanityName),
      supported_fields: ["vanityName", "publicProfileUrl"]
    };
  } catch {
    return fallbackProfile;
  }
}

async function navigateToPublicProfileSettings(page: Page): Promise<void> {
  await page.goto(PUBLIC_PROFILE_SETTINGS_URL, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  await page.locator("body").first().waitFor({ state: "visible", timeout: 10_000 });
}

async function findPublicProfileSettingsRoot(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator | null> {
  const labelRegex = buildTextRegex([
    ...getPublicProfileActionLabels("customUrl", selectorLocale),
    ...getPublicProfileActionLabels("publicProfilePage", selectorLocale)
  ]);
  const root = page
    .locator("section, aside, div, main")
    .filter({ hasText: labelRegex })
    .first();

  return (await isLocatorVisible(root)) ? root : null;
}

async function findPublicProfileVanityInput(
  root: Page | Locator,
  allowGenericFallback = false
): Promise<Locator | null> {
  const selectors = [
    "input[name='vanityName']",
    "input#vanityUrlForm",
    "input[aria-label*='custom url' i]",
    "input[aria-label*='public profile url' i]",
    "input[name*='custom' i]",
    "input[id*='custom' i]",
    "input[name*='public' i]",
    "input[id*='public' i]"
  ];

  for (const selector of selectors) {
    const candidate = root.locator(selector).first();
    if (await isLocatorVisible(candidate)) {
      return candidate;
    }
  }

  return allowGenericFallback ? findVisibleTextInput(root) : null;
}

async function openPublicProfileCustomUrlEditor(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<{ root: Locator | null; input: Locator }> {
  let root = await findPublicProfileSettingsRoot(page, selectorLocale);
  let input = await findPublicProfileVanityInput(root ?? page, Boolean(root));
  if (input) {
    return { root, input };
  }

  const editCandidates: LocatorCandidate[] = [
    ...(root
      ? createActionCandidates(
          root,
          getPublicProfileActionLabels("customUrl", selectorLocale),
          "public-profile-custom-url"
        )
      : []),
    ...(root
      ? createActionCandidates(root, getUiActionLabels("edit", selectorLocale), "public-profile-edit")
      : []),
    {
      key: "public-profile-custom-url-page-button",
      locator: page
        .locator("button, a, [role='button']")
        .filter({ hasText: buildTextRegex(getPublicProfileActionLabels("customUrl", selectorLocale)) })
    }
  ];
  const resolvedEdit = await findFirstVisibleLocator(editCandidates);
  if (!resolvedEdit) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the custom public profile URL editor."
    );
  }

  await resolvedEdit.locator.first().click();
  await page.waitForTimeout(400);

  root = await findPublicProfileSettingsRoot(page, selectorLocale);
  input = await findPublicProfileVanityInput(root ?? page, Boolean(root));
  if (!input) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not find the custom public profile URL input."
    );
  }

  return { root, input };
}

async function clickSaveOnSurface(
  page: Page,
  surface: Page | Locator,
  selectorLocale: LinkedInSelectorLocale,
  errorMessage: string,
  fallbackSurface?: Page | Locator
): Promise<void> {
  const buildSaveCandidates = (root: Page | Locator): LocatorCandidate[] => [
    ...createActionCandidates(root, getUiActionLabels("save", selectorLocale), "surface-save"),
    {
      key: "surface-save-submit",
      locator: root.locator("button[type='submit']")
    }
  ];
  let resolved = await findFirstVisibleLocator(buildSaveCandidates(surface));

  if (!resolved && fallbackSurface) {
    resolved = await findFirstVisibleLocator(buildSaveCandidates(fallbackSurface));
  }

  if (!resolved) {
    throw new LinkedInAssistantError("TARGET_NOT_FOUND", errorMessage);
  }

  await resolved.locator.first().click();
  await waitForNetworkIdleBestEffort(page);
}

async function updatePublicProfileVanityName(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  vanityName: string
): Promise<void> {
  await navigateToPublicProfileSettings(page);
  const { root, input } = await openPublicProfileCustomUrlEditor(page, selectorLocale);
  const currentVanityName = await readEditableFieldValue(input);
  if (normalizeText(currentVanityName) === normalizeText(vanityName)) {
    return;
  }

  await input.click();
  await input.fill(vanityName).catch(async () => {
    await input.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`).catch(
      () => undefined
    );
    await input.press("Backspace").catch(() => undefined);
    await input.type(vanityName);
  });

  await clickSaveOnSurface(
    page,
    root ?? page,
    selectorLocale,
    "Could not find the save button for the public profile URL editor.",
    page
  );
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

async function executeUploadProfileMedia(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>,
  kind: "photo" | "banner"
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const upload = await resolvePreparedUploadArtifact(
    runtime,
    payload,
    "upload",
    `profile ${kind} upload`,
    PROFILE_IMAGE_UPLOAD_EXTENSIONS
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
        actionType:
          kind === "photo"
            ? UPLOAD_PROFILE_PHOTO_ACTION_TYPE
            : UPLOAD_PROFILE_BANNER_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          media_kind: kind,
          file_name: upload.file_name,
          size_bytes: upload.size_bytes,
          artifact_path: upload.relative_path
        },
        errorDetails: {
          profile_name: profileName,
          media_kind: kind,
          file_name: upload.file_name
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            `Failed to execute LinkedIn profile ${kind} upload.`
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          const dialog = await openProfileMediaAndUpload(
            page,
            runtime.selectorLocale,
            kind,
            upload
          );

          if (dialog) {
            await clickSaveInDialog(page, dialog, runtime.selectorLocale);
          }

          await waitForNetworkIdleBestEffort(page);

          return {
            ok: true,
            result: {
              status:
                kind === "photo"
                  ? "profile_photo_uploaded"
                  : "profile_banner_uploaded",
              media_kind: kind,
              file_name: upload.file_name,
              artifact_path: upload.relative_path
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeAddFeaturedItem(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const kind = normalizeProfileFeaturedItemKind(String(payload.kind ?? target.kind ?? ""));
  const url = typeof payload.url === "string" ? normalizeText(payload.url) : undefined;
  const title = typeof payload.title === "string" ? normalizeText(payload.title) : undefined;
  const description =
    typeof payload.description === "string" ? normalizeText(payload.description) : undefined;
  const upload =
    kind === "media"
      ? await resolvePreparedUploadArtifact(
          runtime,
          payload,
          "upload",
          "featured media upload",
          FEATURED_MEDIA_UPLOAD_EXTENSIONS
        )
      : undefined;

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
        actionType: ADD_PROFILE_FEATURED_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          featured_kind: kind,
          ...(url ? { url } : {}),
          ...(upload ? { file_name: upload.file_name } : {})
        },
        errorDetails: {
          profile_name: profileName,
          featured_kind: kind,
          ...(url ? { url } : {}),
          ...(upload ? { file_name: upload.file_name } : {})
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            `Failed to add a ${kind} item to the LinkedIn Featured section.`
          ),
        execute: async () => {
          await navigateToOwnProfile(page);

          if (kind === "link") {
            await addFeaturedLink(page, runtime.selectorLocale, url ?? "", title, description);
          } else if (kind === "media") {
            if (!upload) {
              throw new LinkedInAssistantError(
                "ACTION_PRECONDITION_FAILED",
                "Featured media add is missing the staged upload payload."
              );
            }
            await addFeaturedMedia(page, runtime.selectorLocale, upload, title, description);
          } else {
            await addFeaturedPost(page, runtime.selectorLocale, url ?? "");
          }

          return {
            ok: true,
            result: {
              status: "profile_featured_item_added",
              kind,
              ...(url ? { url } : {}),
              item_fingerprint: createProfileFeaturedItemFingerprint({
                kind,
                ...(url ? { url } : {}),
                ...(title ? { title } : {}),
                rawText: upload?.sha256 ?? description ?? url ?? title ?? kind
              })
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeRemoveFeaturedItem(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const match = normalizeProfileFeaturedItemMatch(
    isRecord(payload.match) ? payload.match : undefined,
    typeof target.item_id === "string" ? target.item_id : undefined
  );
  const decodedItem = decodeProfileFeaturedItemId(
    typeof target.item_id === "string" ? target.item_id : undefined
  );

  if (!match) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Removing a Featured item requires itemId or match details."
    );
  }

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
        actionType: REMOVE_PROFILE_FEATURED_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          ...(match.url ? { url: match.url } : {}),
          ...(match.title ? { title: match.title } : {})
        },
        errorDetails: {
          profile_name: profileName,
          ...(match.url ? { url: match.url } : {}),
          ...(match.title ? { title: match.title } : {})
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to remove a LinkedIn Featured item."
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          await removeFeaturedItem(page, runtime.selectorLocale, match);

          const kind = decodedItem?.kind ?? inferFeaturedItemKind(match.url ?? null, match.rawText ?? match.title ?? "");

          return {
            ok: true,
            result: {
              status: "profile_featured_item_removed",
              item_fingerprint: createProfileFeaturedItemFingerprint({
                kind,
                ...(match.sourceId ? { sourceId: match.sourceId } : {}),
                ...(match.url ? { url: match.url } : {}),
                ...(match.title ? { title: match.title } : {}),
                ...(match.subtitle ? { subtitle: match.subtitle } : {}),
                rawText: match.rawText ?? match.title ?? match.url ?? kind
              })
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeReorderFeaturedItems(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const itemIds = Array.isArray(payload.item_ids)
    ? payload.item_ids.filter((itemId): itemId is string => typeof itemId === "string")
    : [];

  if (itemIds.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Featured reorder payload is missing item_ids."
    );
  }

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
        actionType: REORDER_PROFILE_FEATURED_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          item_count: itemIds.length
        },
        errorDetails: {
          profile_name: profileName,
          item_count: itemIds.length
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to reorder LinkedIn Featured items."
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          await reorderFeaturedItems(page, runtime.selectorLocale, itemIds);

          return {
            ok: true,
            result: {
              status: "profile_featured_reordered",
              item_count: itemIds.length,
              item_ids: itemIds
            },
            artifacts: []
          };
        }
      });
    }
  );
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

async function executeUpdateProfileSettings(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const updates = normalizeEditableValues(
    getPayloadRecord(payload, "updates", "profile settings update"),
    PROFILE_SETTINGS_FIELD_DEFINITIONS,
    "profile settings"
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
        actionType: UPDATE_PROFILE_SETTINGS_ACTION_TYPE,
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
            "Failed to execute LinkedIn profile settings update."
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          const dialog = await openIntroEditDialog(page, runtime.selectorLocale);

          for (const definition of PROFILE_SETTINGS_FIELD_DEFINITIONS) {
            if (!(definition.key in updates)) {
              continue;
            }
            await fillDialogField(page, dialog, definition, updates[definition.key]!);
          }

          await clickSaveInDialog(page, dialog, runtime.selectorLocale);

          return {
            ok: true,
            result: {
              status: "profile_settings_updated",
              updated_fields: Object.keys(updates)
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeUpdatePublicProfile(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const publicProfile = normalizePreparedPublicProfileInput({
    ...(typeof payload.vanity_name === "string"
      ? { vanityName: payload.vanity_name }
      : {}),
    ...(typeof payload.public_profile_url === "string"
      ? { publicProfileUrl: payload.public_profile_url }
      : {})
  });

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
        actionType: UPDATE_PUBLIC_PROFILE_ACTION_TYPE,
        profileName,
        targetUrl: PUBLIC_PROFILE_SETTINGS_URL,
        metadata: {
          profile_name: profileName,
          vanity_name: publicProfile.vanityName,
          public_profile_url: publicProfile.publicProfileUrl
        },
        errorDetails: {
          profile_name: profileName,
          vanity_name: publicProfile.vanityName,
          public_profile_url: publicProfile.publicProfileUrl
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn public profile URL update."
          ),
        execute: async () => {
          await updatePublicProfileVanityName(
            page,
            runtime.selectorLocale,
            publicProfile.vanityName
          );

          return {
            ok: true,
            result: {
              status: "profile_public_profile_updated",
              vanity_name: publicProfile.vanityName,
              public_profile_url: publicProfile.publicProfileUrl
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

export class UpdateProfileSettingsActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUpdateProfileSettings(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class UpdatePublicProfileActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUpdatePublicProfile(
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

export class UploadProfilePhotoActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUploadProfileMedia(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload,
      "photo"
    );
    return { ok: true, result, artifacts };
  }
}

export class UploadProfileBannerActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUploadProfileMedia(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload,
      "banner"
    );
    return { ok: true, result, artifacts };
  }
}

export class AddProfileFeaturedItemActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeAddFeaturedItem(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class RemoveProfileFeaturedItemActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeRemoveFeaturedItem(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class ReorderProfileFeaturedItemsActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeReorderFeaturedItems(
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
    [UPDATE_PROFILE_SETTINGS_ACTION_TYPE]:
      new UpdateProfileSettingsActionExecutor(),
    [UPDATE_PUBLIC_PROFILE_ACTION_TYPE]: new UpdatePublicProfileActionExecutor(),
    [UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE]:
      new UpsertProfileSectionItemActionExecutor(),
    [REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE]:
      new RemoveProfileSectionItemActionExecutor(),
    [UPLOAD_PROFILE_PHOTO_ACTION_TYPE]: new UploadProfilePhotoActionExecutor(),
    [UPLOAD_PROFILE_BANNER_ACTION_TYPE]: new UploadProfileBannerActionExecutor(),
    [ADD_PROFILE_FEATURED_ACTION_TYPE]: new AddProfileFeaturedItemActionExecutor(),
    [REMOVE_PROFILE_FEATURED_ACTION_TYPE]:
      new RemoveProfileFeaturedItemActionExecutor(),
    [REORDER_PROFILE_FEATURED_ACTION_TYPE]:
      new ReorderProfileFeaturedItemsActionExecutor()
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
          const settings = await extractEditableSettings(
            page,
            this.runtime.selectorLocale
          );
          const sections = await extractEditableSections(
            page,
            this.runtime.selectorLocale,
            profile
          );
          const featured = await extractEditableFeaturedSection(
            page,
            this.runtime.selectorLocale
          );
          const publicProfile = await extractEditablePublicProfile(
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
            settings,
            public_profile: publicProfile,
            sections,
            featured
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

  prepareUpdateSettings(
    input: PrepareUpdateSettingsInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const updates = normalizeEditableValues(
      {
        ...(input.industry !== undefined ? { industry: input.industry } : {})
      },
      PROFILE_SETTINGS_FIELD_DEFINITIONS,
      "profile settings"
    );

    const target = {
      profile_name: profileName
    };
    const preview = {
      summary: `Update LinkedIn profile settings (${Object.keys(updates).join(", ")})`,
      target,
      settings_updates: updates
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPDATE_PROFILE_SETTINGS_ACTION_TYPE,
      target,
      payload: {
        updates
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareUpdatePublicProfile(
    input: PrepareUpdatePublicProfileInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const publicProfile = normalizePreparedPublicProfileInput(input);

    const target = {
      profile_name: profileName
    };
    const preview = {
      summary: `Update LinkedIn public profile URL (${publicProfile.vanityName})`,
      target,
      public_profile: {
        vanity_name: publicProfile.vanityName,
        public_profile_url: publicProfile.publicProfileUrl
      }
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPDATE_PUBLIC_PROFILE_ACTION_TYPE,
      target,
      payload: {
        vanity_name: publicProfile.vanityName,
        public_profile_url: publicProfile.publicProfileUrl
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

  async prepareUploadPhoto(
    input: PrepareUploadProfileMediaInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const upload = await stagePreparedUploadArtifact(
      this.runtime,
      input.filePath,
      "Profile photo",
      PROFILE_IMAGE_UPLOAD_EXTENSIONS,
      "profile-photo"
    );

    const target = {
      profile_name: profileName,
      media_kind: "photo"
    };
    const preview = {
      summary: `Upload LinkedIn profile photo (${upload.file_name})`,
      target,
      upload: buildPreparedUploadPreview(upload)
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPLOAD_PROFILE_PHOTO_ACTION_TYPE,
      target,
      payload: {
        upload
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async prepareUploadBanner(
    input: PrepareUploadProfileMediaInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const upload = await stagePreparedUploadArtifact(
      this.runtime,
      input.filePath,
      "Profile banner",
      PROFILE_IMAGE_UPLOAD_EXTENSIONS,
      "profile-banner"
    );

    const target = {
      profile_name: profileName,
      media_kind: "banner"
    };
    const preview = {
      summary: `Upload LinkedIn profile banner (${upload.file_name})`,
      target,
      upload: buildPreparedUploadPreview(upload)
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPLOAD_PROFILE_BANNER_ACTION_TYPE,
      target,
      payload: {
        upload
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async prepareFeaturedAdd(
    input: PrepareFeaturedAddInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const kind = normalizeProfileFeaturedItemKind(String(input.kind));
    const title = normalizeText(input.title);
    const description = normalizeText(input.description);
    const url =
      kind === "link"
        ? normalizeAbsoluteUrl(input.url, "Featured link URL")
        : kind === "post"
          ? normalizeLinkedInFeaturedPostUrl(input.url)
          : undefined;
    const upload =
      kind === "media"
        ? await stagePreparedUploadArtifact(
            this.runtime,
            input.filePath,
            "Featured media",
            FEATURED_MEDIA_UPLOAD_EXTENSIONS,
            "featured-media"
          )
        : undefined;

    const target = {
      profile_name: profileName,
      kind
    };
    const preview = {
      summary: `Add ${kind} item to LinkedIn Featured section`,
      target,
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(upload ? { upload: buildPreparedUploadPreview(upload) } : {})
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: ADD_PROFILE_FEATURED_ACTION_TYPE,
      target,
      payload: {
        kind,
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(upload ? { upload } : {})
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareFeaturedRemove(
    input: PrepareFeaturedRemoveInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const match = normalizeProfileFeaturedItemMatch(input.match, input.itemId);

    if (!input.itemId && !match) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Removing a Featured item requires itemId or match details."
      );
    }

    const target = {
      profile_name: profileName,
      ...(input.itemId ? { item_id: input.itemId } : {})
    };
    const preview = {
      summary: "Remove item from LinkedIn Featured section",
      target,
      ...(match ? { match } : {})
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: REMOVE_PROFILE_FEATURED_ACTION_TYPE,
      target,
      payload: {
        ...(match ? { match } : {})
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareFeaturedReorder(
    input: PrepareFeaturedReorderInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const itemIds = input.itemIds
      .filter((itemId) => typeof itemId === "string")
      .map((itemId) => normalizeText(itemId))
      .filter((itemId) => itemId.length > 0);

    if (itemIds.length === 0) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Featured reorder requires at least one itemId."
      );
    }

    if (new Set(itemIds).size !== itemIds.length) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Featured reorder itemIds must be unique."
      );
    }

    for (const itemId of itemIds) {
      if (!decodeProfileFeaturedItemId(itemId)) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          "Featured reorder requires itemIds returned by view_editable.featured.items.",
          {
            item_id: itemId
          }
        );
      }
    }

    const target = {
      profile_name: profileName
    };
    const preview = {
      summary: `Reorder LinkedIn Featured items (${itemIds.length})`,
      target,
      item_ids: itemIds
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: REORDER_PROFILE_FEATURED_ACTION_TYPE,
      target,
      payload: {
        item_ids: itemIds
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
