import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
import {
  errors as playwrightErrors,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  peekRateLimitPreview,
  type ConsumeRateLimitInput,
  type RateLimiter
} from "./rateLimiter.js";
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
  rateLimiter: RateLimiter;
  logger: JsonEventLogger;
}

export const UPDATE_PROFILE_INTRO_ACTION_TYPE = "profile.update_intro";
export const UPDATE_PROFILE_SETTINGS_ACTION_TYPE = "profile.update_settings";
export const UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE =
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
export const ADD_PROFILE_SKILL_ACTION_TYPE = "profile.skill_add";
export const REORDER_PROFILE_SKILLS_ACTION_TYPE = "profile.skills_reorder";
export const ENDORSE_PROFILE_SKILL_ACTION_TYPE = "profile.skill_endorse";
export const REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE =
  "profile.recommendation_request";
export const WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE =
  "profile.recommendation_write";

const PROFILE_RATE_LIMIT_CONFIGS = {
  [UPDATE_PROFILE_INTRO_ACTION_TYPE]: {
    counterKey: "linkedin.profile.update_intro",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [UPDATE_PROFILE_SETTINGS_ACTION_TYPE]: {
    counterKey: "linkedin.profile.update_settings",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE]: {
    counterKey: "linkedin.profile.update_public_profile",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE]: {
    counterKey: "linkedin.profile.upsert_section_item",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE]: {
    counterKey: "linkedin.profile.remove_section_item",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [UPLOAD_PROFILE_PHOTO_ACTION_TYPE]: {
    counterKey: "linkedin.profile.upload_photo",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 5
  },
  [UPLOAD_PROFILE_BANNER_ACTION_TYPE]: {
    counterKey: "linkedin.profile.upload_banner",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 5
  },
  [ADD_PROFILE_FEATURED_ACTION_TYPE]: {
    counterKey: "linkedin.profile.featured_add",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [REMOVE_PROFILE_FEATURED_ACTION_TYPE]: {
    counterKey: "linkedin.profile.featured_remove",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [REORDER_PROFILE_FEATURED_ACTION_TYPE]: {
    counterKey: "linkedin.profile.featured_reorder",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [ADD_PROFILE_SKILL_ACTION_TYPE]: {
    counterKey: "linkedin.profile.skill_add",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [REORDER_PROFILE_SKILLS_ACTION_TYPE]: {
    counterKey: "linkedin.profile.skills_reorder",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [ENDORSE_PROFILE_SKILL_ACTION_TYPE]: {
    counterKey: "linkedin.profile.skill_endorse",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 30
  },
  [REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE]: {
    counterKey: "linkedin.profile.recommendation_request",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 5
  },
  [WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE]: {
    counterKey: "linkedin.profile.recommendation_write",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 5
  }
} as const satisfies Record<string, ConsumeRateLimitInput>;

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

export interface LinkedInProfileEditableSettings {
  industry: string;
  supported_fields: ["industry"];
}

export interface LinkedInProfileEditablePublicProfile {
  vanity_name: string | null;
  public_profile_url: string | null;
  supported_fields: ("vanityName" | "publicProfileUrl")[];
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

export interface PrepareUpdateProfileSettingsInput {
  profileName?: string;
  industry?: string;
  operatorNote?: string;
}

export interface PrepareUpdateProfilePublicProfileInput {
  profileName?: string;
  vanityName?: string;
  customProfileUrl?: string;
  publicProfileUrl?: string;
  operatorNote?: string;
}

export type PrepareUpdateSettingsInput = PrepareUpdateProfileSettingsInput;
export type PrepareUpdatePublicProfileInput = PrepareUpdateProfilePublicProfileInput;

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

export interface PrepareAddSkillInput {
  profileName?: string;
  skillName: string;
  operatorNote?: string;
}

export interface PrepareReorderSkillsInput {
  profileName?: string;
  skillNames: string[];
  operatorNote?: string;
}

export interface PrepareEndorseSkillInput {
  profileName?: string;
  target: string;
  skillName: string;
  operatorNote?: string;
}

export interface PrepareRequestRecommendationInput {
  profileName?: string;
  target: string;
  relationship?: string;
  position?: string;
  company?: string;
  message?: string;
  operatorNote?: string;
}

export interface PrepareWriteRecommendationInput {
  profileName?: string;
  target: string;
  text: string;
  relationship?: string;
  position?: string;
  company?: string;
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
const LINKEDIN_SELF_PROFILE_URL = "https://www.linkedin.com/in/me/";
const AUTH_PROFILE_MENU_LINK_SELECTOR =
  "a[data-control-name='nav.settings_view_profile']";
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

export const PROFILE_GLOBAL_ADD_SECTION_CONTROL = {
  labels: {
    en: ["Add profile section", "Add section"],
    da: ["Tilføj profilsektion", "Tilføj sektion"]
  },
  roles: ["button", "link"]
} as const;

export const PROFILE_TOP_CARD_HEADING_SELECTORS = [
  "h1.text-heading-xlarge",
  "h1[class*='text-heading']",
  "h2",
  "h1"
] as const;

export const PROFILE_TOP_CARD_STRUCTURAL_SELECTORS = [
  "section[componentkey*='topcard' i]",
  "div[componentkey*='topcard' i]"
] as const;

const PROFILE_ACTION_LABELS = {
  add: {
    en: ["Add"],
    da: ["Tilføj"]
  },
  addProfileSection: PROFILE_GLOBAL_ADD_SECTION_CONTROL.labels,
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
    en: ["Save", "Done", "Apply", "Save photo"],
    da: ["Gem", "Færdig", "Udført", "Anvend"]
  },
  close: {
    en: ["Close", "Dismiss"],
    da: ["Luk"]
  }
} as const;

const PROFILE_INTRO_ACTION_LABELS = {
  edit: {
    en: ["Edit intro", "Edit profile intro", "Edit introduction"],
    da: ["Rediger intro", "Rediger profilintro", "Rediger introduktion"]
  }
} as const;

const PROFILE_INTRO_EDIT_HREF_PATTERNS = ["/edit/intro/", "/edit/forms/intro/"] as const;

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
      "Update photo",
      "Update image",
      "Add photo",
      "Change photo",
      "Edit photo",
      "Select photo",
      "Select image"
    ],
    da: [
      "Upload billede",
      "Upload medie",
      "Opdater billede",
      "Tilføj billede",
      "Skift billede",
      "Rediger billede",
      "Vælg billede"
    ]
  }
} as const;

export const PROFILE_MEDIA_STRUCTURAL_SELECTORS = {
  photo: [
    "button.profile-photo-edit__edit-btn",
    ".profile-photo-edit button",
    ".pv-top-card__photo-wrapper .profile-photo-edit button",
    ".pv-top-card__edit-photo button"
  ],
  banner: [
    ".profile-topcard-background-image-edit__icon button",
    ".profile-topcard-background-image-edit__button button",
    "[id^='cover-photo-dropdown-button-trigger-']"
  ]
} as const;

const PROFILE_SKILL_LABELS = {
  section: {
    en: ["Skills"],
    da: ["Kompetencer", "Færdigheder"]
  },
  add: {
    en: ["Add skill", "Add a skill", "Add skills", "Skill"],
    da: [
      "Tilføj færdighed",
      "Tilføj en færdighed",
      "Tilføj kompetence",
      "Tilføj kompetencer"
    ]
  },
  showAll: {
    en: ["Show all skills", "Show all"],
    da: ["Vis alle færdigheder", "Vis alle kompetencer", "Vis alle"]
  },
  endorse: {
    en: ["Endorse"],
    da: ["Anerkend", "Støt", "Anbefal"]
  }
} as const;

const PROFILE_RECOMMENDATION_LABELS = {
  request: {
    en: [
      "Request a recommendation",
      "Request recommendation",
      "Ask for a recommendation"
    ],
    da: ["Bed om en anbefaling", "Anmod om en anbefaling"]
  },
  write: {
    en: ["Recommend", "Write a recommendation", "Give recommendation"],
    da: ["Anbefal", "Skriv en anbefaling", "Giv en anbefaling"]
  },
  next: {
    en: ["Next", "Continue"],
    da: ["Næste", "Fortsæt"]
  },
  send: {
    en: ["Send", "Submit"],
    da: ["Send", "Indsend"]
  },
  relationshipField: {
    en: ["Relationship", "Relationship to"],
    da: ["Relation", "Forhold"]
  },
  positionField: {
    en: ["Position at the time", "Position"],
    da: ["Stilling på det tidspunkt", "Stilling"]
  },
  companyField: {
    en: ["Company at the time", "Company"],
    da: ["Virksomhed på det tidspunkt", "Virksomhed"]
  },
  messageField: {
    en: ["Message", "Add a message", "Personal message"],
    da: ["Besked", "Tilføj en besked", "Personlig besked"]
  },
  textField: {
    en: ["Recommendation", "Write a recommendation"],
    da: ["Anbefaling", "Skriv en anbefaling"]
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
    aliases: ["location", "Location", "City", "Lokation", "By"],
    control: "text"
  }
] as const;

const PROFILE_SETTINGS_FIELD_DEFINITIONS = [
  {
    key: "industry",
    aliases: ["industry", "Industry", "Professional category", "Branche"],
    control: "select"
  }
] as const satisfies readonly EditableFieldDefinition[];

const PROFILE_INTRO_EDITOR_FIELD_DEFINITIONS = [
  ...PROFILE_INTRO_FIELD_DEFINITIONS,
  ...PROFILE_SETTINGS_FIELD_DEFINITIONS
] as const satisfies readonly EditableFieldDefinition[];

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

const SKILL_FIELD_DEFINITIONS = [
  {
    key: "skillName",
    aliases: ["skillName", "skill", "Skill", "Skills"],
    control: "text"
  }
] as const satisfies readonly EditableFieldDefinition[];

const RECOMMENDATION_COMMON_FIELD_DEFINITIONS = [
  {
    key: "relationship",
    aliases: [
      "relationship",
      "Relationship",
      "Relationship to",
      "Your relationship"
    ],
    control: "select"
  },
  {
    key: "position",
    aliases: [
      "position",
      "Position",
      "Position at the time",
      "Your position"
    ],
    control: "select"
  },
  {
    key: "company",
    aliases: ["company", "Company", "Company at the time"],
    control: "select"
  }
] as const satisfies readonly EditableFieldDefinition[];

const RECOMMENDATION_REQUEST_FIELD_DEFINITIONS = [
  ...RECOMMENDATION_COMMON_FIELD_DEFINITIONS,
  {
    key: "message",
    aliases: ["message", "Message", "Add a message", "Personal message"],
    control: "textarea"
  }
] as const satisfies readonly EditableFieldDefinition[];

const RECOMMENDATION_WRITE_FIELD_DEFINITIONS = [
  ...RECOMMENDATION_COMMON_FIELD_DEFINITIONS,
  {
    key: "text",
    aliases: ["text", "recommendation", "Recommendation", "Write a recommendation"],
    control: "textarea"
  }
] as const satisfies readonly EditableFieldDefinition[];

const LINKEDIN_PUBLIC_PROFILE_SETTINGS_URL =
  "https://www.linkedin.com/public-profile/settings/?trk=d_flagship3_profile_self_view_public_profile";

function buildFallbackEditablePublicProfile(
  profile: LinkedInProfile
): LinkedInProfileEditablePublicProfile {
  const vanityName = normalizeText(profile.vanity_name);
  return {
    vanity_name: vanityName || null,
    public_profile_url:
      vanityName.length > 0
        ? buildLinkedInPublicProfileUrl(vanityName)
        : profile.profile_url
          ? normalizeLinkedInProfileUrl(profile.profile_url)
          : null,
    supported_fields: ["vanityName", "publicProfileUrl"]
  };
}

async function extractEditableSettings(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<LinkedInProfileEditableSettings> {
  let surface: ProfileEditorSurface | null = null;

  try {
    surface = await openIntroEditSurface(page, selectorLocale);
    const industryField = await waitForDialogFieldLocator(
      surface.root,
      PROFILE_SETTINGS_FIELD_DEFINITIONS[0],
      10_000
    );

    return {
      industry: industryField
        ? normalizeText(
            await industryField.evaluate((element) => {
              if (
                element instanceof globalThis.HTMLInputElement ||
                element instanceof globalThis.HTMLTextAreaElement ||
                element instanceof globalThis.HTMLSelectElement
              ) {
                return element.value;
              }

              return element.getAttribute("value") ?? element.textContent ?? "";
            })
          )
        : "",
      supported_fields: ["industry"]
    };
  } catch {
    return {
      industry: "",
      supported_fields: ["industry"]
    };
  } finally {
    if (surface) {
      await closeProfileEditorSurface(page, surface, selectorLocale);
    }
  }
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function getProfileRateLimitConfig(actionType: string): ConsumeRateLimitInput {
  const config = (
    PROFILE_RATE_LIMIT_CONFIGS as Record<string, ConsumeRateLimitInput>
  )[actionType];

  if (!config) {
    throw new LinkedInBuddyError("UNKNOWN", "Missing rate limit policy.", {
      action_type: actionType
    });
  }

  return config;
}

function createProfileRateLimitGuard(
  runtime: LinkedInProfileExecutorRuntime,
  actionType: string,
  actionId: string,
  profileName: string,
  details: Record<string, unknown>
): () => void {
  return () =>
    consumeRateLimitOrThrow(runtime.rateLimiter, {
      config: getProfileRateLimitConfig(actionType),
      message: createConfirmRateLimitMessage(actionType),
      details: {
        action_id: actionId,
        profile_name: profileName,
        ...details
      }
    });
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
      throw asLinkedInBuddyError(
        error,
        "ACTION_PRECONDITION_FAILED",
        "Profile URL must be a valid URL."
      );
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const isLinkedInDomain =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    if (!isLinkedInDomain || !parsedUrl.pathname.startsWith("/in/")) {
      throw new LinkedInBuddyError(
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

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${label} is required.`
  );
}

function requireNonEmptyText(value: string | undefined, label: string): string {
  const normalizedValue = normalizeText(value);
  if (normalizedValue.length > 0) {
    return normalizedValue;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${label} is required.`
  );
}

function resolveExternalProfileTarget(
  target: string | undefined,
  label: string
): string {
  const normalizedTarget = requireNonEmptyText(target, label);
  if (normalizedTarget.toLowerCase() === "me") {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must refer to another LinkedIn member.`
    );
  }

  return resolveProfileUrl(normalizedTarget);
}

function normalizeSkillName(value: string | undefined): string {
  return requireNonEmptyText(value, "skillName");
}

function normalizeSkillNames(skillNames: readonly string[]): string[] {
  const normalizedSkillNames = skillNames
    .filter((skillName): skillName is string => typeof skillName === "string")
    .map((skillName) => normalizeText(skillName))
    .filter((skillName) => skillName.length > 0);

  if (normalizedSkillNames.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "skillNames must include at least one non-empty skill name."
    );
  }

  if (new Set(normalizedSkillNames).size !== normalizedSkillNames.length) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "skillNames must be unique."
    );
  }

  return normalizedSkillNames;
}

function normalizeAbsoluteUrl(value: string | undefined, label: string): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} is required.`
    );
  }

  if (!isAbsoluteUrl(normalizedValue)) {
    throw new LinkedInBuddyError(
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
    throw asLinkedInBuddyError(
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
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Featured post URL must point to a LinkedIn post, article, or newsletter.",
        {
          value: normalizedUrl
        }
      );
    }

    return parsedUrl.toString();
  } catch (error) {
    if (error instanceof LinkedInBuddyError) {
      throw error;
    }

    throw asLinkedInBuddyError(
      error,
      "ACTION_PRECONDITION_FAILED",
      "Featured post URL must be a valid LinkedIn URL."
    );
  }
}

function normalizeLinkedInVanityName(value: string | undefined): string {
  const normalizedValue = requireNonEmptyText(
    value,
    "vanityName or publicProfileUrl"
  );

  if (!normalizedValue.includes("://")) {
    const trimmed = normalizedValue
      .replace(/^\/+/, "")
      .replace(/^in\//i, "")
      .replace(/\/+$/, "");

    if (trimmed.length === 0 || /[/?#]/.test(trimmed)) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "vanityName must be a LinkedIn vanity slug or linkedin.com/in/ URL.",
        {
          value: normalizedValue
        }
      );
    }

    return trimmed;
  }

  try {
    const parsedUrl = new URL(normalizedValue);
    const hostname = parsedUrl.hostname.toLowerCase();
    const isLinkedInDomain =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    const vanityMatch = parsedUrl.pathname.match(/^\/in\/([^/?#]+)\/?$/iu);

    if (!isLinkedInDomain || !vanityMatch?.[1]) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "publicProfileUrl must point to linkedin.com/in/<vanity-name>/.",
        {
          value: normalizedValue
        }
      );
    }

    return decodeURIComponent(vanityMatch[1]);
  } catch (error) {
    if (error instanceof LinkedInBuddyError) {
      throw error;
    }

    throw asLinkedInBuddyError(
      error,
      "ACTION_PRECONDITION_FAILED",
      "publicProfileUrl must be a valid LinkedIn profile URL."
    );
  }
}

function buildLinkedInPublicProfileUrl(vanityName: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(vanityName)}/`;
}

function normalizePreparedPublicProfileInput(
  input: Pick<
    PrepareUpdateProfilePublicProfileInput,
    "vanityName" | "customProfileUrl" | "publicProfileUrl"
  >
): {
  vanityName: string;
  publicProfileUrl: string;
} {
  const rawValues = [input.vanityName, input.customProfileUrl, input.publicProfileUrl]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizeLinkedInVanityName(value));

  const [vanityName] = rawValues;
  if (!vanityName) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Public profile update requires vanityName, customProfileUrl, or publicProfileUrl."
    );
  }

  if (rawValues.some((value) => value.toLowerCase() !== vanityName.toLowerCase())) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "vanityName, customProfileUrl, and publicProfileUrl must all point to the same LinkedIn public profile URL."
    );
  }

  return {
    vanityName,
    publicProfileUrl: buildLinkedInPublicProfileUrl(vanityName)
  };
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
    throw asLinkedInBuddyError(
      error,
      "ACTION_PRECONDITION_FAILED",
      `${label} file does not exist.`
    );
  }

  const stats = statSync(canonicalPath);
  if (!stats.isFile()) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} filePath must point to a file.`,
      {
        file_path: canonicalPath
      }
    );
  }

  if (stats.size <= 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} file must not be empty.`,
      {
        file_path: canonicalPath
      }
    );
  }

  if (stats.size > MAX_PROFILE_UPLOAD_BYTES) {
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} payload is missing staged upload details.`
    );
  }

  const normalizedAbsolutePath = path.resolve(absolutePath);
  if (!isPathWithinParent(getArtifactsRootDir(runtime.artifacts), normalizedAbsolutePath)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} upload artifact escapes the assistant artifacts directory.`,
      {
        artifact_path: normalizedAbsolutePath
      }
    );
  }

  const stats = statSync(normalizedAbsolutePath);
  if (!stats.isFile()) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} upload artifact is missing.`,
      {
        artifact_path: normalizedAbsolutePath
      }
    );
  }

  const actualExtension = path.extname(normalizedAbsolutePath).toLowerCase();
  if (!allowedExtensions.some((candidate) => candidate === actualExtension)) {
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
      throw new LinkedInBuddyError(
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

export function isProfileIntroEditHref(href: string | null | undefined): boolean {
  if (typeof href !== "string") {
    return false;
  }

  const normalizedHref = normalizeText(href);
  if (!normalizedHref) {
    return false;
  }

  try {
    const resolvedUrl = new URL(normalizedHref, "https://www.linkedin.com");
    return PROFILE_INTRO_EDIT_HREF_PATTERNS.some((pattern) =>
      resolvedUrl.pathname.includes(pattern)
    );
  } catch {
    return PROFILE_INTRO_EDIT_HREF_PATTERNS.some((pattern) =>
      normalizedHref.includes(pattern)
    );
  }
}

function buildProfileIntroEditHrefSelector(): string {
  return PROFILE_INTRO_EDIT_HREF_PATTERNS.map(
    (pattern) => `a[href*="${escapeCssAttributeValue(pattern)}"]`
  ).join(", ");
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

function getIntroActionLabels(
  action: keyof typeof PROFILE_INTRO_ACTION_LABELS,
  locale: LinkedInSelectorLocale
): string[] {
  return getLocalizedLabels(PROFILE_INTRO_ACTION_LABELS[action], locale);
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

function getSkillActionLabels(
  action: keyof typeof PROFILE_SKILL_LABELS,
  locale: LinkedInSelectorLocale
): string[] {
  return getLocalizedLabels(PROFILE_SKILL_LABELS[action], locale);
}

function getRecommendationActionLabels(
  action: keyof typeof PROFILE_RECOMMENDATION_LABELS,
  locale: LinkedInSelectorLocale
): string[] {
  return getLocalizedLabels(PROFILE_RECOMMENDATION_LABELS[action], locale);
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

  throw new LinkedInBuddyError(
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

  throw new LinkedInBuddyError(
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
      throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} values must include at least one non-empty field.`
    );
  }

  return normalized;
}

function normalizeOptionalEditableValues(
  values: Record<string, unknown>,
  definitions: readonly EditableFieldDefinition[]
): Record<string, NormalizedEditableValue> {
  const fieldMap = buildEditableFieldAliasMap(definitions);
  const normalized: Record<string, NormalizedEditableValue> = {};

  for (const [rawKey, rawValue] of Object.entries(values)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    const definition = fieldMap.get(normalizeFieldKey(rawKey));
    if (!definition) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `Unsupported editable field "${rawKey}".`,
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
    throw new LinkedInBuddyError(
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

interface ProfileEditorSurface {
  kind: "dialog" | "page";
  root: Locator;
}

const EDITABLE_FIELD_CONTROL_XPATH = [
  "self::input",
  "self::textarea",
  "self::select",
  "@role='combobox'",
  "@role='textbox'",
  "@contenteditable='true'"
].join(" or ");

export async function resolveFirstVisibleLocator(
  locator: Locator
): Promise<Locator | null> {
  const count = await locator.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  return (await resolveFirstVisibleLocator(locator)) !== null;
}

async function findFirstVisibleLocator(
  candidates: readonly LocatorCandidate[]
): Promise<LocatorCandidate | null> {
  for (const candidate of candidates) {
    const visibleLocator = await resolveFirstVisibleLocator(candidate.locator);
    if (visibleLocator) {
      return {
        ...candidate,
        locator: visibleLocator
      };
    }
  }

  return null;
}

async function waitForFirstVisibleLocator(
  candidates: readonly LocatorCandidate[],
  timeoutMs: number
): Promise<LocatorCandidate | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const resolved = await findFirstVisibleLocator(candidates);
    if (resolved) {
      return resolved;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  return findFirstVisibleLocator(candidates);
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

function createCssLocatorCandidates(
  root: Page | Locator,
  selectors: readonly string[],
  keyPrefix: string
): LocatorCandidate[] {
  return [...new Set(selectors.map((selector) => selector.trim()).filter(Boolean))].map(
    (selector, index) => ({
      key: `${keyPrefix}-css-${index + 1}`,
      locator: root.locator(selector)
    })
  );
}

function buildEditableFieldTextRegex(labels: readonly string[]): RegExp {
  const normalizedLabels = dedupeStrings(labels);
  const pattern = normalizedLabels.map((label) => escapeRegExp(label)).join("|");
  return new RegExp(`^(?:${pattern})\\s*[*:]?$`, "i");
}

function buildEditableFieldAttributeSelectors(labels: readonly string[]): string[] {
  const selectors: string[] = [];

  for (const label of dedupeStrings(labels)) {
    const escapedLabel = escapeCssAttributeValue(label);
    selectors.push(
      `input[aria-label*="${escapedLabel}" i]`,
      `textarea[aria-label*="${escapedLabel}" i]`,
      `select[aria-label*="${escapedLabel}" i]`,
      `[role='combobox'][aria-label*="${escapedLabel}" i]`,
      `[role='textbox'][aria-label*="${escapedLabel}" i]`,
      `[contenteditable='true'][aria-label*="${escapedLabel}" i]`,
      `input[placeholder*="${escapedLabel}" i]`,
      `textarea[placeholder*="${escapedLabel}" i]`,
      `[contenteditable='true'][data-placeholder*="${escapedLabel}" i]`
    );
  }

  return selectors;
}

async function waitForProfilePageReady(page: Page): Promise<void> {
  const readyCandidates: LocatorCandidate[] = [
    {
      key: "profile-heading",
      locator: page.locator(
        PROFILE_TOP_CARD_HEADING_SELECTORS.map((selector) => `main ${selector}`).join(", ")
      )
    },
    {
      key: "profile-intro-edit",
      locator: page.locator(buildProfileIntroEditHrefSelector())
    },
    {
      key: "profile-top-card-current-self",
      locator: page.locator(
        PROFILE_TOP_CARD_STRUCTURAL_SELECTORS.map(
          (selector) => `main ${selector}`
        ).join(", ")
      )
    },
    ...createCssLocatorCandidates(
      page,
      [...PROFILE_MEDIA_STRUCTURAL_SELECTORS.photo, ...PROFILE_MEDIA_STRUCTURAL_SELECTORS.banner],
      "profile-ready-media"
    )
  ];

  await waitForFirstVisibleLocator(readyCandidates, 10_000);
}

function tryNormalizeLinkedInProfileUrl(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return normalizeLinkedInProfileUrl(value);
  } catch {
    return null;
  }
}

async function readPageAttributeWithTimeout(
  page: Page,
  selector: string,
  attribute: string,
  timeoutMs: number
): Promise<string | null> {
  try {
    return await page
      .locator(selector)
      .first()
      .getAttribute(attribute, { timeout: timeoutMs });
  } catch {
    return null;
  }
}

async function hasOwnProfileEditControl(
  page: Page,
  options: { requireVisible: boolean }
): Promise<boolean> {
  const selectors = [
    buildProfileIntroEditHrefSelector(),
    ...PROFILE_MEDIA_STRUCTURAL_SELECTORS.photo,
    ...PROFILE_MEDIA_STRUCTURAL_SELECTORS.banner
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    if (await isLocatorVisible(locator)) {
      return true;
    }

    if (!options.requireVisible) {
      try {
        if ((await locator.count()) > 0) {
          return true;
        }
      } catch {
        // Best effort — some page states do not expose countable edit controls yet.
      }
    }
  }

  return false;
}

async function canRecoverOwnProfileNavigationTimeout(page: Page): Promise<boolean> {
  const SHORT_TIMEOUT_MS = 1_000;
  const currentProfileUrl = tryNormalizeLinkedInProfileUrl(page.url());
  if (!currentProfileUrl) {
    return false;
  }

  const canonicalProfileUrl = tryNormalizeLinkedInProfileUrl(
    await readPageAttributeWithTimeout(
      page,
      "link[rel='canonical']",
      "href",
      SHORT_TIMEOUT_MS
    )
  );
  const ogProfileUrl = tryNormalizeLinkedInProfileUrl(
    await readPageAttributeWithTimeout(
      page,
      "meta[property='og:url']",
      "content",
      SHORT_TIMEOUT_MS
    )
  );
  const menuProfileUrl = tryNormalizeLinkedInProfileUrl(
    await readPageAttributeWithTimeout(
      page,
      AUTH_PROFILE_MENU_LINK_SELECTOR,
      "href",
      SHORT_TIMEOUT_MS
    )
  );
  if (menuProfileUrl) {
    if (menuProfileUrl === currentProfileUrl) {
      return true;
    }

    if (canonicalProfileUrl === menuProfileUrl) {
      return true;
    }

    if (ogProfileUrl === menuProfileUrl) {
      return true;
    }
  }

  if (currentProfileUrl === LINKEDIN_SELF_PROFILE_URL) {
    return hasOwnProfileEditControl(page, { requireVisible: false });
  }

  return hasOwnProfileEditControl(page, { requireVisible: true });
}

async function waitForVisibleDialog(page: Page): Promise<Locator> {
  const dialog = page.locator("[role='dialog']").last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  return dialog;
}

async function resolveLatestVisibleDialog(page: Page): Promise<Locator | null> {
  const dialogs = page.locator("[role='dialog']");
  const dialogCount = await dialogs.count().catch(() => 0);

  for (let index = dialogCount - 1; index >= 0; index -= 1) {
    const candidate = dialogs.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function resolveVisibleProfileIntroEditPage(page: Page): Promise<Locator | null> {
  if (!isProfileIntroEditHref(page.url())) {
    return null;
  }

  const form = await resolveFirstVisibleLocator(page.locator("main form"));
  if (form) {
    return form;
  }

  return resolveFirstVisibleLocator(page.locator("main"));
}

async function hasVisibleEditableField(
  root: Locator,
  definitions: readonly EditableFieldDefinition[]
): Promise<boolean> {
  for (const definition of definitions) {
    if (await findDialogFieldLocator(root, definition)) {
      return true;
    }
  }

  return false;
}

async function waitForVisibleProfileIntroEditorSurface(
  page: Page,
  timeoutMs: number
): Promise<ProfileEditorSurface | null> {
  const deadline = Date.now() + timeoutMs;
  let fallbackSurface: ProfileEditorSurface | null = null;

  while (Date.now() < deadline) {
    const pageRoot = await resolveVisibleProfileIntroEditPage(page);
    if (pageRoot) {
      const pageSurface = {
        kind: "page" as const,
        root: pageRoot
      };
      fallbackSurface = pageSurface;

      if (
        await hasVisibleEditableField(pageSurface.root, PROFILE_INTRO_EDITOR_FIELD_DEFINITIONS)
      ) {
        return pageSurface;
      }
    }

    const dialogRoot = await resolveLatestVisibleDialog(page);
    if (dialogRoot) {
      const dialogSurface = {
        kind: "dialog" as const,
        root: dialogRoot
      };
      fallbackSurface ??= dialogSurface;

      if (
        await hasVisibleEditableField(dialogSurface.root, PROFILE_INTRO_EDITOR_FIELD_DEFINITIONS)
      ) {
        return dialogSurface;
      }
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  return fallbackSurface;
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

export async function navigateToOwnProfile(page: Page): Promise<void> {
  try {
    await page.goto(resolveProfileUrl("me"), { waitUntil: "domcontentloaded" });
  } catch (error) {
    if (
      !(error instanceof playwrightErrors.TimeoutError) ||
      !(await canRecoverOwnProfileNavigationTimeout(page))
    ) {
      throw error;
    }
  }

  await waitForNetworkIdleBestEffort(page);
  await waitForProfilePageReady(page);
}

async function getTopCardRoot(page: Page): Promise<Locator> {
  const headingLocator = page.locator(
    PROFILE_TOP_CARD_HEADING_SELECTORS.join(", ")
  );
  const candidateRoots: LocatorCandidate[] = [
    {
      key: "top-card-artdeco-card-with-heading",
      locator: page
        .locator("main section.artdeco-card, main div.artdeco-card")
        .filter({
          has: headingLocator
        })
    },
    {
      key: "top-card-legacy-with-heading",
      locator: page
        .locator("main .pv-top-card, main .top-card-layout")
        .filter({
          has: headingLocator
        })
    },
    {
      key: "top-card-current-self-with-heading",
      locator: page
        .locator(
          PROFILE_TOP_CARD_STRUCTURAL_SELECTORS.map(
            (selector) => `main ${selector}`
          ).join(", ")
        )
        .filter({
          has: headingLocator
        })
    },
    {
      key: "top-card-section-with-heading",
      locator: page.locator("main section").filter({
        has: headingLocator
      })
    },
    {
      key: "top-card-pv",
      locator: page.locator("main .pv-top-card")
    },
    {
      key: "top-card-layout",
      locator: page.locator("main .top-card-layout")
    }
  ];
  const resolved = await findFirstVisibleLocator(candidateRoots);
  if (!resolved) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the profile top card on the profile page."
    );
  }

  return resolved.locator;
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

async function findSkillsSectionRoot(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator | null> {
  const headingRegex = buildTextRegex(getSkillActionLabels("section", selectorLocale), true);
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

async function openIntroEditSurface(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<ProfileEditorSurface> {
  const topCardRoot = await getTopCardRoot(page);
  const introEditLabels = getIntroActionLabels("edit", selectorLocale);
  const editCandidates: LocatorCandidate[] = [
    {
      key: "intro-edit-link-href",
      locator: topCardRoot.locator(buildProfileIntroEditHrefSelector())
    },
    {
      key: "intro-edit-button-aria",
      locator: topCardRoot.locator(
        buildAriaLabelContainsSelector("button", introEditLabels)
      )
    },
    {
      key: "intro-edit-link-aria",
      locator: topCardRoot.locator(
        buildAriaLabelContainsSelector("a", introEditLabels)
      )
    },
    {
      key: "intro-edit-button-role",
      locator: topCardRoot.getByRole("button", {
        name: buildTextRegex(introEditLabels)
      })
    },
    {
      key: "intro-edit-link-role",
      locator: topCardRoot.getByRole("link", {
        name: buildTextRegex(introEditLabels)
      })
    }
  ];
  const resolved = await findFirstVisibleLocator(editCandidates);
  if (!resolved) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the intro edit control on the profile page."
    );
  }

  await resolved.locator.first().click();

  const surface = await waitForVisibleProfileIntroEditorSurface(page, 10_000);
  if (surface) {
    return surface;
  }

  throw new LinkedInBuddyError(
    "TARGET_NOT_FOUND",
    "Could not open the intro editor after clicking the edit control."
  );
}

async function openGlobalAddSectionDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const topCardRoot = await getTopCardRoot(page);
  const addSectionLabels = getUiActionLabels("addProfileSection", selectorLocale);
  const addCandidates: LocatorCandidate[] = [
    ...PROFILE_GLOBAL_ADD_SECTION_CONTROL.roles.flatMap((role) =>
      createActionCandidates(
        topCardRoot,
        addSectionLabels,
        `profile-section-add-${role}`,
        role
      )
    ),
    {
      key: "profile-section-add-generic",
      locator: topCardRoot
        .locator("button, a, [role='button'], [role='link']")
        .filter({ hasText: buildTextRegex(addSectionLabels) })
    }
  ];
  const resolved = await findFirstVisibleLocator(addCandidates);

  if (!resolved) {
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      `Could not find the ${getSectionDisplayLabel(section, selectorLocale)} section on the profile page.`
    );
  }

  const itemLocator = await findMatchingSectionItemLocator(sectionRoot, match);
  if (!itemLocator) {
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
  const fieldTextRegex = buildEditableFieldTextRegex(definition.aliases);
  const roleCandidates: Locator[] = [
    dialog.getByLabel(labelRegex),
    dialog.getByRole("textbox", { name: labelRegex }),
    dialog.getByRole("combobox", { name: labelRegex }),
    dialog.getByRole("checkbox", { name: labelRegex })
  ];

  for (const candidate of roleCandidates) {
    const resolved = await resolveFirstVisibleLocator(candidate);
    if (resolved) {
      return resolved;
    }
  }

  const attributeCandidates = createCssLocatorCandidates(
    dialog,
    buildEditableFieldAttributeSelectors(definition.aliases),
    `editable-field-${definition.key}`
  );
  const resolvedAttribute = await findFirstVisibleLocator(attributeCandidates);
  if (resolvedAttribute) {
    return resolvedAttribute.locator;
  }

  const textCandidates = dialog.getByText(fieldTextRegex);
  const textCandidateCount = await textCandidates.count().catch(() => 0);
  for (let index = 0; index < textCandidateCount; index += 1) {
    const textCandidate = textCandidates.nth(index);
    if (!(await textCandidate.isVisible().catch(() => false))) {
      continue;
    }

    const followingControl = await resolveFirstVisibleLocator(
      textCandidate.locator(`xpath=following::*[(${EDITABLE_FIELD_CONTROL_XPATH})][1]`)
    );
    if (followingControl) {
      return followingControl;
    }
  }

  for (const alias of definition.aliases) {
    const normalizedAlias = normalizeText(alias).toLowerCase();
    const xpath = dialog
      .locator(
        `xpath=.//*[self::label or self::p or self::div or self::span][contains(translate(normalize-space(string(.)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ', 'abcdefghijklmnopqrstuvwxyzæøå'), "${normalizedAlias}")]/following::*[(${EDITABLE_FIELD_CONTROL_XPATH})][1]`
      )
      .first();
    const resolvedXpath = await resolveFirstVisibleLocator(xpath);
    if (resolvedXpath) {
      return resolvedXpath;
    }
  }

  return null;
}

async function waitForDialogFieldLocator(
  dialog: Locator,
  definition: EditableFieldDefinition,
  timeoutMs: number
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const locator = await findDialogFieldLocator(dialog, definition);
    if (locator) {
      return locator;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  return findDialogFieldLocator(dialog, definition);
}

async function fillDialogField(
  page: Page,
  dialog: Locator,
  definition: EditableFieldDefinition,
  value: NormalizedEditableValue
): Promise<void> {
  const locator = await waitForDialogFieldLocator(dialog, definition, 10_000);
  if (!locator) {
    throw new LinkedInBuddyError(
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
  const ariaAutocomplete = await locator.getAttribute("aria-autocomplete").catch(() => null);
  const dataTestId = await locator.getAttribute("data-testid").catch(() => null);
  const isTypeaheadField = ariaAutocomplete === "list" || dataTestId === "typeahead-input";

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

  if (definition.control === "select" || isTypeaheadField) {
    await page.waitForTimeout(250);
    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
  }
}

async function clickSaveInProfileEditorSurface(
  page: Page,
  surface: ProfileEditorSurface,
  selectorLocale: LinkedInSelectorLocale
): Promise<void> {
  const saveCandidates: LocatorCandidate[] = [
    ...createActionCandidates(
      surface.root,
      getUiActionLabels("save", selectorLocale),
      "profile-editor-save"
    ),
    {
      key: "profile-editor-save-submit",
      locator: surface.root.locator("button[type='submit']")
    }
  ];
  const resolved = await waitForFirstVisibleLocator(saveCandidates, 10_000);
  if (!resolved) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the save button in the profile editor."
    );
  }

  await resolved.locator.first().click();

  if (surface.kind === "dialog") {
    await surface.root.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    await waitForNetworkIdleBestEffort(page);
    return;
  }

  const exitEditPage = page
    .waitForURL((url) => !isProfileIntroEditHref(url.toString()), {
      timeout: 10_000
    })
    .catch(() => undefined);

  await waitForNetworkIdleBestEffort(page, 10_000);
  await exitEditPage;
}

async function closeProfileEditorSurface(
  page: Page,
  surface: ProfileEditorSurface,
  selectorLocale: LinkedInSelectorLocale
): Promise<void> {
  if (surface.kind === "page") {
    if (isProfileIntroEditHref(page.url())) {
      await navigateToOwnProfile(page);
    }
    return;
  }

  const closeCandidates: LocatorCandidate[] = [
    ...createActionCandidates(
      surface.root,
      getUiActionLabels("close", selectorLocale),
      "dialog-close"
    ),
    {
      key: "dialog-close-button",
      locator: surface.root.locator(
        "button[aria-label*='close' i], button[aria-label*='dismiss' i]"
      )
    }
  ];
  const resolvedClose = await findFirstVisibleLocator(closeCandidates);

  if (resolvedClose) {
    await resolvedClose.locator.first().click().catch(() => undefined);
  } else {
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  await surface.root.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
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
  const resolved = await waitForFirstVisibleLocator(saveCandidates, 10_000);
  if (!resolved) {
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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

async function clickDialogAction(
  page: Page,
  dialog: Locator,
  labels: readonly string[],
  keyPrefix: string
): Promise<void> {
  const candidates: LocatorCandidate[] = [
    ...createActionCandidates(dialog, labels, keyPrefix),
    {
      key: `${keyPrefix}-submit`,
      locator: dialog.locator("button[type='submit']")
    }
  ];
  const resolved = await findFirstVisibleLocator(candidates);
  if (!resolved) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      `Could not find the ${keyPrefix.replace(/-/g, " ")} button in the dialog.`
    );
  }

  await resolved.locator.first().click();
  await page.waitForTimeout(400);
  await waitForNetworkIdleBestEffort(page);
}

async function navigateToPublicProfileSettings(page: Page): Promise<void> {
  await page.goto(LINKEDIN_PUBLIC_PROFILE_SETTINGS_URL, {
    waitUntil: "domcontentloaded"
  });
  await waitForNetworkIdleBestEffort(page);
  await page.locator("#vanityUrlForm").first().waitFor({
    state: "visible",
    timeout: 10_000
  });
}

async function getPublicProfileVanityInput(page: Page): Promise<Locator> {
  const input = page.locator("#vanityUrlForm").first();
  if (!(await isLocatorVisible(input))) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the custom public profile URL field."
    );
  }

  return input;
}

async function isPublicProfileVanityInputReadonly(
  input: Locator
): Promise<boolean> {
  return input.evaluate((element) => element.hasAttribute("readonly"));
}

async function openPublicProfileVanityEditor(page: Page): Promise<Locator> {
  const input = await getPublicProfileVanityInput(page);
  if (!(await isPublicProfileVanityInputReadonly(input))) {
    return input;
  }

  const editCandidates: LocatorCandidate[] = [
    {
      key: "public-profile-edit-class",
      locator: page.locator("button.vanity-name__edit-vanity-btn")
    },
    {
      key: "public-profile-edit-aria",
      locator: page.locator("button[aria-label*='custom URL' i]")
    }
  ];
  const resolved = await findFirstVisibleLocator(editCandidates);
  if (!resolved) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the edit control for the custom public profile URL."
    );
  }

  await resolved.locator.first().click();
  await page.waitForFunction(() => {
    const input = globalThis.document.querySelector("#vanityUrlForm");
    if (!(input instanceof globalThis.HTMLInputElement)) {
      return false;
    }
    return !input.hasAttribute("readonly");
  });

  return input;
}

async function readPublicProfileVanityError(page: Page): Promise<string | null> {
  const errorCandidates = [
    page.locator("#vanityNameError").first(),
    page.locator(".vanity-name__feedback").first(),
    page.locator("[role='alert']").first()
  ];

  for (const candidate of errorCandidates) {
    const text = normalizeText(await candidate.textContent().catch(() => ""));
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

async function savePublicProfileVanityName(
  page: Page,
  vanityName: string
): Promise<void> {
  const saveCandidates: LocatorCandidate[] = [
    {
      key: "public-profile-save-class",
      locator: page.locator("button.vanity-name__button--submit")
    },
    ...createActionCandidates(page, ["Save"], "public-profile-save")
  ];
  const resolved = await findFirstVisibleLocator(saveCandidates);
  if (!resolved) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the save button for the custom public profile URL."
    );
  }

  await resolved.locator.first().click();
  await waitForNetworkIdleBestEffort(page);

  const input = await getPublicProfileVanityInput(page);
  try {
    await page.waitForFunction(
      (expectedVanityName) => {
        const field = globalThis.document.querySelector("#vanityUrlForm");
        if (!(field instanceof globalThis.HTMLInputElement)) {
          return false;
        }
        return (
          field.value.trim() === expectedVanityName &&
          field.hasAttribute("readonly")
        );
      },
      vanityName,
      { timeout: 10_000 }
    );
  } catch {
    const errorText = await readPublicProfileVanityError(page);
    const currentValue = normalizeText(await input.inputValue().catch(() => ""));

    if (errorText) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `LinkedIn rejected the requested custom public profile URL: ${errorText}`,
        {
          vanity_name: vanityName
        }
      );
    }

    throw new LinkedInBuddyError(
      "UNKNOWN",
      "LinkedIn custom public profile URL did not update as expected.",
      {
        requested_vanity_name: vanityName,
        current_vanity_name: currentValue
      }
    );
  }
}

async function extractEditablePublicProfile(
  page: Page,
  profile: LinkedInProfile
): Promise<LinkedInProfileEditablePublicProfile> {
  const fallbackProfile = buildFallbackEditablePublicProfile(profile);

  try {
    await navigateToPublicProfileSettings(page);
    const input = await getPublicProfileVanityInput(page);
    const inputValue = normalizeText(await input.inputValue().catch(() => ""));
    const editableInputValue = inputValue
      ? inputValue
      : normalizeText(
          await openPublicProfileVanityEditor(page)
            .then(async (editableInput) => editableInput.inputValue())
            .catch(() => "")
        );
    if (!editableInputValue) {
      return fallbackProfile;
    }

    const vanityName = normalizeLinkedInVanityName(editableInputValue);
    return {
      vanity_name: vanityName,
      public_profile_url: buildLinkedInPublicProfileUrl(vanityName),
      supported_fields: ["vanityName", "publicProfileUrl"]
    };
  } catch {
    return fallbackProfile;
  }
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

async function clickLocatorForUpload(
  page: Page,
  locator: Locator,
  filePath: string
): Promise<{ surface: Locator | null; uploaded: boolean }> {
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 1_200 }).catch(
    () => null
  );
  try {
    await locator.first().click({ timeout: 5_000 });
  } catch {
    // Some LinkedIn edit affordances open a modal quickly enough that the new
    // overlay starts intercepting pointer events before Playwright declares the
    // click complete. Continue by inspecting the resulting UI state.
  }
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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

  const locator = await findDialogFieldLocator(dialog, definition);
  if (!locator) {
    return;
  }

  await fillDialogField(page, dialog, definition, value);
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

  throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the Featured section on the profile page."
    );
  }

  const itemLocator = await findMatchingFeaturedItemLocator(featuredRoot, match);
  if (!itemLocator) {
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
      throw new LinkedInBuddyError(
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
      throw new LinkedInBuddyError(
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

function getCollectionItemLocator(root: Locator): Locator {
  return root.locator(
    ".pvs-list__paged-list-item, .pvs-list__item--line-separated, li.artdeco-list__item, li[class*='pvs-list__item'], li[class*='artdeco-models-table-row']"
  );
}

async function readSkillRowName(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const lines = [
      ...Array.from(
        element.querySelectorAll(
          ".t-bold span[aria-hidden='true'], .t-bold, .t-normal span[aria-hidden='true'], [data-field='skill'], [data-field='name']"
        )
      ).map((node) => normalize(node.textContent)),
      ...normalize(element.textContent)
        .split(/\n+/)
        .map((line) => normalize(line))
    ].filter((line) => line.length > 0);

    return lines[0] ?? "";
  });
}

function doesSkillNameMatch(actual: string, expected: string): boolean {
  const normalizedActual = normalizeText(actual).toLowerCase();
  const normalizedExpected = normalizeText(expected).toLowerCase();

  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.includes(normalizedExpected)
  );
}

async function findMatchingSkillRow(
  root: Locator,
  skillName: string
): Promise<{ row: Locator; index: number } | null> {
  const rows = getCollectionItemLocator(root);
  const rowCount = await rows.count();

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    const candidateSkillName = await readSkillRowName(row);
    if (doesSkillNameMatch(candidateSkillName, skillName)) {
      return { row, index };
    }
  }

  return null;
}

async function maybeOpenSkillsListSurface(
  page: Page,
  sectionRoot: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator | null> {
  const labels = getSkillActionLabels("showAll", selectorLocale);
  const candidates: LocatorCandidate[] = [
    ...createActionCandidates(sectionRoot, labels, "skills-show-all"),
    ...createActionCandidates(sectionRoot, labels, "skills-show-all-link", "link"),
    {
      key: "skills-show-all-generic",
      locator: sectionRoot
        .locator("button, a, [role='button']")
        .filter({ hasText: buildTextRegex(labels) })
    }
  ];
  const resolved = await findFirstVisibleLocator(candidates);
  if (!resolved) {
    return null;
  }

  await resolved.locator.first().click();
  await page.waitForTimeout(500);
  await waitForNetworkIdleBestEffort(page);

  return (await getVisibleDialogOrNull(page)) ?? page.locator("main");
}

async function openSkillsAddDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const skillsRoot = await findSkillsSectionRoot(page, selectorLocale);
  const directLabels = dedupeStrings([
    ...getSkillActionLabels("add", selectorLocale),
    ...getUiActionLabels("add", selectorLocale)
  ]);

  if (skillsRoot) {
    const sectionCandidates: LocatorCandidate[] = [
      ...createActionCandidates(skillsRoot, directLabels, "skills-add"),
      ...createActionCandidates(skillsRoot, directLabels, "skills-add-link", "link"),
      {
        key: "skills-add-generic",
        locator: skillsRoot
          .locator("button, a, [role='button']")
          .filter({ hasText: buildTextRegex(directLabels) })
      }
    ];
    const resolvedSectionAdd = await findFirstVisibleLocator(sectionCandidates);
    if (resolvedSectionAdd) {
      return clickLocatorAndWaitForDialog(page, resolvedSectionAdd.locator);
    }
  }

  const addSectionDialog = await openGlobalAddSectionDialog(page, selectorLocale);
  const globalLabels = dedupeStrings([
    ...getSkillActionLabels("add", selectorLocale),
    ...getSkillActionLabels("section", selectorLocale)
  ]);
  const globalCandidates: LocatorCandidate[] = [
    ...createActionCandidates(addSectionDialog, globalLabels, "skills-global"),
    ...createActionCandidates(addSectionDialog, globalLabels, "skills-global-link", "link"),
    {
      key: "skills-global-generic",
      locator: addSectionDialog
        .locator("button, a, div[role='button'], li")
        .filter({ hasText: buildTextRegex(globalLabels) })
    }
  ];
  const resolvedGlobalAdd = await findFirstVisibleLocator(globalCandidates);
  if (!resolvedGlobalAdd) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the LinkedIn Skills add flow on the profile page."
    );
  }

  await resolvedGlobalAdd.locator.first().click();
  await page.waitForTimeout(500);
  return waitForVisibleDialog(page);
}

async function findSkillInputLocator(dialog: Locator): Promise<Locator | null> {
  const labelRegex = buildTextRegex(SKILL_FIELD_DEFINITIONS[0].aliases);
  const candidates = [
    dialog.getByLabel(labelRegex).first(),
    dialog.locator("input[role='combobox']").first(),
    dialog.locator("input[aria-autocomplete='list']").first(),
    dialog.locator('input[name*="skill" i]').first(),
    dialog.locator('input[id*="skill" i]').first(),
    dialog.locator('input[placeholder*="skill" i]').first()
  ];

  for (const candidate of candidates) {
    if (await isLocatorVisible(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function selectAutocompleteOption(
  page: Page,
  value: string
): Promise<void> {
  const exactRegex = buildTextRegex([value], true);
  const fuzzyRegex = buildTextRegex([value]);
  const candidates: LocatorCandidate[] = [
    {
      key: "autocomplete-exact-option",
      locator: page.getByRole("option", { name: exactRegex })
    },
    {
      key: "autocomplete-fuzzy-option",
      locator: page.getByRole("option", { name: fuzzyRegex })
    },
    {
      key: "autocomplete-fuzzy-list-item",
      locator: page
        .locator("[role='option'], li, [role='listitem']")
        .filter({ hasText: fuzzyRegex })
    }
  ];
  const resolved = await findFirstVisibleLocator(candidates);
  if (resolved) {
    await resolved.locator.first().click();
    return;
  }

  await page.keyboard.press("ArrowDown").catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
}

async function addSkill(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  skillName: string
): Promise<void> {
  const dialog = await openSkillsAddDialog(page, selectorLocale);
  const skillInput = await findSkillInputLocator(dialog);
  if (!skillInput) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the skill input in the LinkedIn skills dialog."
    );
  }

  await skillInput.click();
  await skillInput.fill(skillName).catch(async () => {
    await skillInput.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`).catch(
      () => undefined
    );
    await skillInput.press("Backspace").catch(() => undefined);
    await skillInput.type(skillName);
  });
  await page.waitForTimeout(500);
  await selectAutocompleteOption(page, skillName);
  await clickSaveInDialog(page, dialog, selectorLocale);
}

async function openSkillsEditDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const skillsRoot = await findSkillsSectionRoot(page, selectorLocale);
  if (!skillsRoot) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the Skills section on the profile page."
    );
  }

  const editCandidates = createActionCandidates(
    skillsRoot,
    getUiActionLabels("edit", selectorLocale),
    "skills-edit"
  );
  const resolvedEdit = await findFirstVisibleLocator(editCandidates);
  if (!resolvedEdit) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the Skills edit control on the profile page."
    );
  }

  return clickLocatorAndWaitForDialog(page, resolvedEdit.locator);
}

async function reorderSkills(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  skillNames: string[]
): Promise<void> {
  const dialog = await openSkillsEditDialog(page, selectorLocale);

  for (let index = skillNames.length - 1; index >= 0; index -= 1) {
    const skillName = skillNames[index]!;
    const locatedRow = await findMatchingSkillRow(dialog, skillName);
    if (!locatedRow) {
      throw new LinkedInBuddyError(
        "TARGET_NOT_FOUND",
        "Could not find one of the requested skills in the reorder dialog.",
        {
          skill_name: skillName
        }
      );
    }

    if (locatedRow.index === 0) {
      continue;
    }

    const firstRow = getCollectionItemLocator(dialog).first();
    const sourceHandle = (await findVisibleDragHandle(locatedRow.row)) ?? locatedRow.row;
    const targetHandle = (await findVisibleDragHandle(firstRow)) ?? firstRow;
    await dragLocatorToTarget(page, sourceHandle, targetHandle);
  }

  await clickSaveInDialog(page, dialog, selectorLocale);
}

async function locateSkillRowOnProfile(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  skillName: string
): Promise<Locator> {
  const skillsRoot = await findSkillsSectionRoot(page, selectorLocale);
  if (!skillsRoot) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the Skills section on the target profile."
    );
  }

  const directMatch = await findMatchingSkillRow(skillsRoot, skillName);
  if (directMatch) {
    return directMatch.row;
  }

  const expandedSurface = await maybeOpenSkillsListSurface(page, skillsRoot, selectorLocale);
  if (expandedSurface) {
    const expandedMatch = await findMatchingSkillRow(expandedSurface, skillName);
    if (expandedMatch) {
      return expandedMatch.row;
    }
  }

  throw new LinkedInBuddyError(
    "TARGET_NOT_FOUND",
    "Could not find the requested skill on the target profile.",
    {
      skill_name: skillName
    }
  );
}

async function endorseSkill(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  targetProfileUrl: string,
  skillName: string
): Promise<"endorsed" | "already_endorsed"> {
  await page.goto(targetProfileUrl, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  await waitForProfilePageReady(page);

  const row = await locateSkillRowOnProfile(page, selectorLocale, skillName);
  const endorseCandidates: LocatorCandidate[] = [
    ...createActionCandidates(row, getSkillActionLabels("endorse", selectorLocale), "skill-endorse"),
    {
      key: "skill-endorse-generic",
      locator: row
        .locator("button, [role='button']")
        .filter({ hasText: buildTextRegex(getSkillActionLabels("endorse", selectorLocale)) })
    }
  ];
  const resolvedEndorse = await findFirstVisibleLocator(endorseCandidates);
  if (resolvedEndorse) {
    await resolvedEndorse.locator.first().click();
    await page.waitForTimeout(400);
    await waitForNetworkIdleBestEffort(page);
    return "endorsed";
  }

  const rowText = normalizeText(await row.textContent().catch(() => ""));
  if (/you(?:'|’)??ve endorsed|already endorsed/i.test(rowText)) {
    return "already_endorsed";
  }

  throw new LinkedInBuddyError(
    "TARGET_NOT_FOUND",
    "Could not find an endorse control for the requested skill.",
    {
      skill_name: skillName
    }
  );
}

async function openTopCardMoreMenu(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const topCardRoot = await getTopCardRoot(page);
  const moreCandidates = createActionCandidates(
    topCardRoot,
    getUiActionLabels("more", selectorLocale),
    "profile-top-more"
  );
  const resolvedMore = await findFirstVisibleLocator(moreCandidates);
  if (!resolvedMore) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not find the profile More actions menu."
    );
  }

  return clickLocatorAndWaitForOverlay(page, resolvedMore.locator);
}

async function clickOverlayActionByLabels(
  page: Page,
  overlay: Locator,
  labels: readonly string[],
  keyPrefix: string
): Promise<Locator> {
  const candidates: LocatorCandidate[] = [
    ...createActionCandidates(overlay, labels, keyPrefix),
    ...createActionCandidates(overlay, labels, `${keyPrefix}-link`, "link"),
    {
      key: `${keyPrefix}-generic`,
      locator: overlay
        .locator("[role='menuitem'], button, a, div[role='button']")
        .filter({ hasText: buildTextRegex(labels) })
    }
  ];
  const resolved = await findFirstVisibleLocator(candidates);
  if (!resolved) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      `Could not find the ${keyPrefix.replace(/-/g, " ")} action.`
    );
  }

  await resolved.locator.first().click();
  await page.waitForTimeout(500);
  return (await getVisibleDialogOrNull(page)) ?? overlay;
}

async function openRecommendationDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  action: "request" | "write"
): Promise<Locator> {
  const overlay = await openTopCardMoreMenu(page, selectorLocale);
  return clickOverlayActionByLabels(
    page,
    overlay,
    getRecommendationActionLabels(action, selectorLocale),
    `recommendation-${action}`
  );
}

async function fillRecommendationFields(
  page: Page,
  dialog: Locator,
  definitions: readonly EditableFieldDefinition[],
  values: Record<string, NormalizedEditableValue>
): Promise<void> {
  for (const definition of definitions) {
    await fillDialogFieldIfPresent(page, dialog, definition, values[definition.key]);
  }
}

async function maybeAdvanceRecommendationDialog(
  page: Page,
  dialog: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const candidates: LocatorCandidate[] = [
    ...createActionCandidates(
      dialog,
      getRecommendationActionLabels("next", selectorLocale),
      "recommendation-next"
    ),
    {
      key: "recommendation-next-submit",
      locator: dialog.locator("button[type='submit']").filter({
        hasText: buildTextRegex(getRecommendationActionLabels("next", selectorLocale))
      })
    }
  ];
  const resolved = await findFirstVisibleLocator(candidates);
  if (!resolved) {
    return dialog;
  }

  await resolved.locator.first().click();
  await page.waitForTimeout(500);
  return (await getVisibleDialogOrNull(page)) ?? dialog;
}

async function requestRecommendation(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  targetProfileUrl: string,
  fields: Record<string, NormalizedEditableValue>
): Promise<void> {
  await page.goto(targetProfileUrl, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  await waitForProfilePageReady(page);

  let dialog = await openRecommendationDialog(page, selectorLocale, "request");
  await fillRecommendationFields(
    page,
    dialog,
    RECOMMENDATION_COMMON_FIELD_DEFINITIONS,
    fields
  );
  dialog = await maybeAdvanceRecommendationDialog(page, dialog, selectorLocale);
  await fillDialogFieldIfPresent(
    page,
    dialog,
    RECOMMENDATION_REQUEST_FIELD_DEFINITIONS[3]!,
    fields.message
  );
  await clickDialogAction(
    page,
    dialog,
    dedupeStrings([
      ...getRecommendationActionLabels("send", selectorLocale),
      ...getUiActionLabels("save", selectorLocale)
    ]),
    "recommendation-send"
  );
}

async function writeRecommendation(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  targetProfileUrl: string,
  fields: Record<string, NormalizedEditableValue>
): Promise<void> {
  await page.goto(targetProfileUrl, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  await waitForProfilePageReady(page);

  let dialog = await openRecommendationDialog(page, selectorLocale, "write");
  await fillRecommendationFields(
    page,
    dialog,
    RECOMMENDATION_COMMON_FIELD_DEFINITIONS,
    fields
  );
  dialog = await maybeAdvanceRecommendationDialog(page, dialog, selectorLocale);

  const recommendationText = fields.text;
  if (typeof recommendationText !== "string" || recommendationText.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Write recommendation payload is missing text."
    );
  }

  await fillDialogField(
    page,
    dialog,
    RECOMMENDATION_WRITE_FIELD_DEFINITIONS[3]!,
    recommendationText
  );
  await clickDialogAction(
    page,
    dialog,
    dedupeStrings([
      ...getRecommendationActionLabels("send", selectorLocale),
      ...getUiActionLabels("save", selectorLocale)
    ]),
    "recommendation-send"
  );
}

async function openProfileMediaAndUpload(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  kind: "photo" | "banner",
  upload: PreparedUploadArtifact
): Promise<Locator | null> {
  const topCardRoot = await getTopCardRoot(page);
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
    // LinkedIn currently renders the profile-photo entry point as an unlabeled
    // edit button around the avatar preview, so keep structural fallbacks.
    ...createCssLocatorCandidates(
      topCardRoot,
      PROFILE_MEDIA_STRUCTURAL_SELECTORS[kind],
      `profile-${kind}-structural`
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

  throw new LinkedInBuddyError(
    "TARGET_NOT_FOUND",
    `Could not find the LinkedIn profile ${kind} upload controls.`
  );
}

function getPayloadRecord(
  payload: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> {
  const value = payload[key];
  if (!isRecord(value)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} payload is missing a valid ${key} object.`
    );
  }

  return value;
}

async function executeAddProfileSkill(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const skillName = normalizeSkillName(
    typeof payload.skill_name === "string" ? payload.skill_name : undefined
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
        actionType: ADD_PROFILE_SKILL_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          skill_name: skillName
        },
        errorDetails: {
          profile_name: profileName,
          skill_name: skillName
        },
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          ADD_PROFILE_SKILL_ACTION_TYPE,
          actionId,
          profileName,
          {
            skill_name: skillName
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            `Failed to add the LinkedIn skill "${skillName}".`
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          await addSkill(page, runtime.selectorLocale, skillName);

          return {
            ok: true,
            result: {
              status: "profile_skill_added",
              skill_name: skillName
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeReorderProfileSkills(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const skillNames = normalizeSkillNames(
    Array.isArray(payload.skill_names)
      ? payload.skill_names.filter(
          (skillName): skillName is string => typeof skillName === "string"
        )
      : []
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
        actionType: REORDER_PROFILE_SKILLS_ACTION_TYPE,
        profileName,
        targetUrl: resolveProfileUrl("me"),
        metadata: {
          profile_name: profileName,
          skill_count: skillNames.length
        },
        errorDetails: {
          profile_name: profileName,
          skill_count: skillNames.length
        },
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          REORDER_PROFILE_SKILLS_ACTION_TYPE,
          actionId,
          profileName,
          {
            skill_count: skillNames.length
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to reorder LinkedIn skills."
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          await reorderSkills(page, runtime.selectorLocale, skillNames);

          return {
            ok: true,
            result: {
              status: "profile_skills_reordered",
              skill_count: skillNames.length,
              skill_names: skillNames
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeEndorseProfileSkill(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const targetProfileUrl = resolveExternalProfileTarget(
    typeof target.target_profile_url === "string"
      ? target.target_profile_url
      : typeof target.target_profile === "string"
        ? target.target_profile
        : undefined,
    "target"
  );
  const skillName = normalizeSkillName(
    typeof payload.skill_name === "string" ? payload.skill_name : undefined
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
        actionType: ENDORSE_PROFILE_SKILL_ACTION_TYPE,
        profileName,
        targetUrl: targetProfileUrl,
        metadata: {
          profile_name: profileName,
          target_profile_url: targetProfileUrl,
          skill_name: skillName
        },
        errorDetails: {
          profile_name: profileName,
          target_profile_url: targetProfileUrl,
          skill_name: skillName
        },
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          ENDORSE_PROFILE_SKILL_ACTION_TYPE,
          actionId,
          profileName,
          {
            target_profile_url: targetProfileUrl,
            skill_name: skillName
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            `Failed to endorse "${skillName}" on the target LinkedIn profile.`
          ),
        execute: async () => {
          const endorseResult = await endorseSkill(
            page,
            runtime.selectorLocale,
            targetProfileUrl,
            skillName
          );

          return {
            ok: true,
            result: {
              status:
                endorseResult === "already_endorsed"
                  ? "profile_skill_already_endorsed"
                  : "profile_skill_endorsed",
              target_profile_url: targetProfileUrl,
              skill_name: skillName
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeRequestProfileRecommendation(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const targetProfileUrl = resolveExternalProfileTarget(
    typeof target.target_profile_url === "string"
      ? target.target_profile_url
      : typeof target.target_profile === "string"
        ? target.target_profile
        : undefined,
    "target"
  );
  const fields = normalizeOptionalEditableValues(
    getPayloadRecord(payload, "fields", "recommendation request"),
    RECOMMENDATION_REQUEST_FIELD_DEFINITIONS
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
        actionType: REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE,
        profileName,
        targetUrl: targetProfileUrl,
        metadata: {
          profile_name: profileName,
          target_profile_url: targetProfileUrl,
          provided_fields: Object.keys(fields)
        },
        errorDetails: {
          profile_name: profileName,
          target_profile_url: targetProfileUrl,
          provided_fields: Object.keys(fields)
        },
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE,
          actionId,
          profileName,
          {
            target_profile_url: targetProfileUrl,
            provided_fields: Object.keys(fields)
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to request a LinkedIn recommendation."
          ),
        execute: async () => {
          await requestRecommendation(
            page,
            runtime.selectorLocale,
            targetProfileUrl,
            fields
          );

          return {
            ok: true,
            result: {
              status: "profile_recommendation_requested",
              target_profile_url: targetProfileUrl,
              provided_fields: Object.keys(fields)
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeWriteProfileRecommendation(
  runtime: LinkedInProfileExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const targetProfileUrl = resolveExternalProfileTarget(
    typeof target.target_profile_url === "string"
      ? target.target_profile_url
      : typeof target.target_profile === "string"
        ? target.target_profile
        : undefined,
    "target"
  );
  const fields = normalizeOptionalEditableValues(
    getPayloadRecord(payload, "fields", "write recommendation"),
    RECOMMENDATION_WRITE_FIELD_DEFINITIONS
  );
  const recommendationText = fields.text;
  if (typeof recommendationText !== "string" || recommendationText.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Write recommendation payload is missing text."
    );
  }

  const textHash = createHash("sha256")
    .update(recommendationText)
    .digest("base64url")
    .slice(0, 12);

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
        actionType: WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE,
        profileName,
        targetUrl: targetProfileUrl,
        metadata: {
          profile_name: profileName,
          target_profile_url: targetProfileUrl,
          provided_fields: Object.keys(fields)
        },
        errorDetails: {
          profile_name: profileName,
          target_profile_url: targetProfileUrl,
          provided_fields: Object.keys(fields)
        },
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE,
          actionId,
          profileName,
          {
            target_profile_url: targetProfileUrl,
            provided_fields: Object.keys(fields)
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to write a LinkedIn recommendation."
          ),
        execute: async () => {
          await writeRecommendation(
            page,
            runtime.selectorLocale,
            targetProfileUrl,
            fields
          );

          return {
            ok: true,
            result: {
              status: "profile_recommendation_written",
              target_profile_url: targetProfileUrl,
              text_sha256_prefix: textHash,
              provided_fields: Object.keys(fields)
            },
            artifacts: []
          };
        }
      });
    }
  );
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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          kind === "photo"
            ? UPLOAD_PROFILE_PHOTO_ACTION_TYPE
            : UPLOAD_PROFILE_BANNER_ACTION_TYPE,
          actionId,
          profileName,
          {
            media_kind: kind,
            file_name: upload.file_name
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          ADD_PROFILE_FEATURED_ACTION_TYPE,
          actionId,
          profileName,
          {
            featured_kind: kind,
            ...(url ? { url } : {}),
            ...(upload ? { file_name: upload.file_name } : {})
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
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
              throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          REMOVE_PROFILE_FEATURED_ACTION_TYPE,
          actionId,
          profileName,
          {
            ...(match.url ? { url: match.url } : {}),
            ...(match.title ? { title: match.title } : {})
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          REORDER_PROFILE_FEATURED_ACTION_TYPE,
          actionId,
          profileName,
          {
            item_count: itemIds.length
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          UPDATE_PROFILE_INTRO_ACTION_TYPE,
          actionId,
          profileName,
          {
            updated_fields: Object.keys(updates)
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn profile intro update."
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          const surface = await openIntroEditSurface(page, runtime.selectorLocale);

          for (const definition of PROFILE_INTRO_FIELD_DEFINITIONS) {
            if (!(definition.key in updates)) {
              continue;
            }
            await fillDialogField(page, surface.root, definition, updates[definition.key]!);
          }

          await clickSaveInProfileEditorSurface(page, surface, runtime.selectorLocale);

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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          UPDATE_PROFILE_SETTINGS_ACTION_TYPE,
          actionId,
          profileName,
          {
            updated_fields: Object.keys(updates)
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn profile settings update."
          ),
        execute: async () => {
          await navigateToOwnProfile(page);
          const surface = await openIntroEditSurface(page, runtime.selectorLocale);

          for (const definition of PROFILE_SETTINGS_FIELD_DEFINITIONS) {
            if (!(definition.key in updates)) {
              continue;
            }
            await fillDialogField(page, surface.root, definition, updates[definition.key]!);
          }

          await clickSaveInProfileEditorSurface(page, surface, runtime.selectorLocale);

          return {
            ok: true,
            result: {
              status: "profile_settings_updated",
              updated_fields: Object.keys(updates),
              ...(typeof updates.industry === "string"
                ? { industry: updates.industry }
                : {})
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeUpdateProfilePublicProfile(
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
        actionType: UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE,
        profileName,
        targetUrl: LINKEDIN_PUBLIC_PROFILE_SETTINGS_URL,
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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE,
          actionId,
          profileName,
          {
            vanity_name: publicProfile.vanityName,
            public_profile_url: publicProfile.publicProfileUrl
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn public profile update."
          ),
        execute: async () => {
          await navigateToPublicProfileSettings(page);
          const input = await openPublicProfileVanityEditor(page);
          const currentVanityName = normalizeText(await input.inputValue().catch(() => ""));
          if (
            currentVanityName &&
            normalizeLinkedInVanityName(currentVanityName).toLowerCase() ===
              publicProfile.vanityName.toLowerCase()
          ) {
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

          await input.fill(publicProfile.vanityName);
          await savePublicProfileVanityName(page, publicProfile.vanityName);

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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          UPSERT_PROFILE_SECTION_ITEM_ACTION_TYPE,
          actionId,
          profileName,
          {
            section,
            mode,
            updated_fields: Object.keys(values)
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
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
        beforeExecute: createProfileRateLimitGuard(
          runtime,
          REMOVE_PROFILE_SECTION_ITEM_ACTION_TYPE,
          actionId,
          profileName,
          {
            section
          }
        ),
        mapError: (error) =>
          asLinkedInBuddyError(
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
              throw new LinkedInBuddyError(
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

export class UpdateProfilePublicProfileActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUpdateProfilePublicProfile(
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

export class AddProfileSkillActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeAddProfileSkill(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class ReorderProfileSkillsActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeReorderProfileSkills(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class EndorseProfileSkillActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeEndorseProfileSkill(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class RequestProfileRecommendationActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeRequestProfileRecommendation(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class WriteProfileRecommendationActionExecutor
  implements ActionExecutor<LinkedInProfileExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInProfileExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeWriteProfileRecommendation(
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
    [UPDATE_PROFILE_SETTINGS_ACTION_TYPE]: new UpdateProfileSettingsActionExecutor(),
    [UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE]:
      new UpdateProfilePublicProfileActionExecutor(),
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
      new ReorderProfileFeaturedItemsActionExecutor(),
    [ADD_PROFILE_SKILL_ACTION_TYPE]: new AddProfileSkillActionExecutor(),
    [REORDER_PROFILE_SKILLS_ACTION_TYPE]:
      new ReorderProfileSkillsActionExecutor(),
    [ENDORSE_PROFILE_SKILL_ACTION_TYPE]: new EndorseProfileSkillActionExecutor(),
    [REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE]:
      new RequestProfileRecommendationActionExecutor(),
    [WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE]:
      new WriteProfileRecommendationActionExecutor()
  };
}

export class LinkedInProfileService {
  constructor(private readonly runtime: LinkedInProfileRuntime) {}

  private prepareRateLimitedAction(input: {
    actionType: string;
    target: Record<string, unknown>;
    payload: Record<string, unknown>;
    preview: Record<string, unknown>;
    operatorNote?: string;
  }): PreparedActionResult {
    return this.runtime.twoPhaseCommit.prepare({
      actionType: input.actionType,
      target: input.target,
      payload: input.payload,
      preview: {
        ...input.preview,
        rate_limit: peekRateLimitPreview(
          this.runtime.rateLimiter,
          getProfileRateLimitConfig(input.actionType)
        )
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

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
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
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
          const settings = await extractEditableSettings(page, this.runtime.selectorLocale);
          const sections = await extractEditableSections(
            page,
            this.runtime.selectorLocale,
            profile
          );
          const featured = await extractEditableFeaturedSection(
            page,
            this.runtime.selectorLocale
          );
          const publicProfile = await extractEditablePublicProfile(page, profile);

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
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
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

    return this.prepareRateLimitedAction({
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
    input: PrepareUpdateProfileSettingsInput
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

    return this.prepareRateLimitedAction({
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
    input: PrepareUpdateProfilePublicProfileInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const publicProfile = normalizePreparedPublicProfileInput(input);

    const target = {
      profile_name: profileName
    };
    const preview = {
      summary: "Update LinkedIn public profile URL",
      target,
      vanity_name: publicProfile.vanityName,
      public_profile_url: publicProfile.publicProfileUrl
    };

    return this.prepareRateLimitedAction({
      actionType: UPDATE_PROFILE_PUBLIC_PROFILE_ACTION_TYPE,
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

    return this.prepareRateLimitedAction({
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
      throw new LinkedInBuddyError(
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

    return this.prepareRateLimitedAction({
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

    return this.prepareRateLimitedAction({
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

    return this.prepareRateLimitedAction({
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

    return this.prepareRateLimitedAction({
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
      throw new LinkedInBuddyError(
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

    return this.prepareRateLimitedAction({
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
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Featured reorder requires at least one itemId."
      );
    }

    if (new Set(itemIds).size !== itemIds.length) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Featured reorder itemIds must be unique."
      );
    }

    for (const itemId of itemIds) {
      if (!decodeProfileFeaturedItemId(itemId)) {
        throw new LinkedInBuddyError(
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

    return this.prepareRateLimitedAction({
      actionType: REORDER_PROFILE_FEATURED_ACTION_TYPE,
      target,
      payload: {
        item_ids: itemIds
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareAddSkill(input: PrepareAddSkillInput): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const skillName = normalizeSkillName(input.skillName);

    const target = {
      profile_name: profileName
    };
    const preview = {
      summary: `Add "${skillName}" to LinkedIn profile skills`,
      target,
      skill_name: skillName
    };

    return this.prepareRateLimitedAction({
      actionType: ADD_PROFILE_SKILL_ACTION_TYPE,
      target,
      payload: {
        skill_name: skillName
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareReorderSkills(
    input: PrepareReorderSkillsInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const skillNames = normalizeSkillNames(input.skillNames);

    const target = {
      profile_name: profileName
    };
    const preview = {
      summary: `Reorder LinkedIn skills (${skillNames.length})`,
      target,
      skill_names: skillNames
    };

    return this.prepareRateLimitedAction({
      actionType: REORDER_PROFILE_SKILLS_ACTION_TYPE,
      target,
      payload: {
        skill_names: skillNames
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareEndorseSkill(
    input: PrepareEndorseSkillInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const skillName = normalizeSkillName(input.skillName);
    const targetProfileUrl = resolveExternalProfileTarget(input.target, "target");

    const target = {
      profile_name: profileName,
      target_profile: normalizeText(input.target),
      target_profile_url: targetProfileUrl
    };
    const preview = {
      summary: `Endorse "${skillName}" on a LinkedIn profile`,
      target,
      skill_name: skillName
    };

    return this.prepareRateLimitedAction({
      actionType: ENDORSE_PROFILE_SKILL_ACTION_TYPE,
      target,
      payload: {
        skill_name: skillName
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareRequestRecommendation(
    input: PrepareRequestRecommendationInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const targetProfileUrl = resolveExternalProfileTarget(input.target, "target");
    const fields = normalizeOptionalEditableValues(
      {
        ...(input.relationship !== undefined
          ? { relationship: input.relationship }
          : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.company !== undefined ? { company: input.company } : {}),
        ...(input.message !== undefined ? { message: input.message } : {})
      },
      RECOMMENDATION_REQUEST_FIELD_DEFINITIONS
    );

    const target = {
      profile_name: profileName,
      target_profile: normalizeText(input.target),
      target_profile_url: targetProfileUrl
    };
    const preview = {
      summary: "Request a LinkedIn recommendation",
      target,
      ...(Object.keys(fields).length > 0 ? { fields } : {})
    };

    return this.prepareRateLimitedAction({
      actionType: REQUEST_PROFILE_RECOMMENDATION_ACTION_TYPE,
      target,
      payload: {
        fields
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareWriteRecommendation(
    input: PrepareWriteRecommendationInput
  ): PreparedActionResult {
    const profileName = input.profileName ?? "default";
    const targetProfileUrl = resolveExternalProfileTarget(input.target, "target");
    const fields = normalizeOptionalEditableValues(
      {
        ...(input.relationship !== undefined
          ? { relationship: input.relationship }
          : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.company !== undefined ? { company: input.company } : {}),
        text: input.text
      },
      RECOMMENDATION_WRITE_FIELD_DEFINITIONS
    );

    if (typeof fields.text !== "string" || fields.text.length === 0) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "text is required."
      );
    }

    const target = {
      profile_name: profileName,
      target_profile: normalizeText(input.target),
      target_profile_url: targetProfileUrl
    };
    const preview = {
      summary: "Write a LinkedIn recommendation",
      target,
      fields
    };

    return this.prepareRateLimitedAction({
      actionType: WRITE_PROFILE_RECOMMENDATION_ACTION_TYPE,
      target,
      payload: {
        fields
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
