import {
  LINKEDIN_PROFILE_SECTION_TYPES,
  LinkedInBuddyError,
  type LinkedInEditableProfile,
  type LinkedInProfileEditableSection,
  type LinkedInProfileEditableSectionItem,
  type LinkedInProfileSectionItemMatch,
  type LinkedInProfileSectionType,
  type PrepareRemoveSectionItemInput,
  type PrepareUpdateIntroInput,
  type PrepareUpdatePublicProfileInput,
  type PrepareUpdateSettingsInput,
  type PrepareUpsertSectionItemInput
} from "@linkedin-buddy/core";

const SUPPORTED_SECTION_TYPES = LINKEDIN_PROFILE_SECTION_TYPES.filter(
  (section) => section !== "about"
);

const SECTION_KEY_ALIASES = new Map<string, LinkedInProfileSectionType>([
  ["experience", "experience"],
  ["education", "education"],
  ["certifications", "certifications"],
  ["licensescertifications", "certifications"],
  ["languages", "languages"],
  ["projects", "projects"],
  ["volunteerexperience", "volunteer_experience"],
  ["volunteer_experience", "volunteer_experience"],
  ["honorsawards", "honors_awards"],
  ["honors_awards", "honors_awards"],
  ["skills", "skills"]
]);

const INTRO_FIELD_KEYS = new Set(["firstName", "lastName", "headline", "location"]);
const SETTINGS_FIELD_KEYS = new Set(["industry"]);
const PUBLIC_PROFILE_FIELD_ALIASES = new Map<string, "customProfileUrl">([
  ["customprofileurl", "customProfileUrl"],
  ["publicprofileurl", "customProfileUrl"],
  ["vanityurl", "customProfileUrl"]
]);

const SECTION_IDENTITY_FIELDS: Record<Exclude<LinkedInProfileSectionType, "about">, string[]> = {
  experience: ["title", "company"],
  education: ["school", "degree"],
  certifications: ["name", "issuingOrganization"],
  languages: ["name"],
  projects: ["title"],
  volunteer_experience: ["role", "organization"],
  honors_awards: ["title", "issuer"],
  skills: ["name"]
};

type SeedSectionType = Exclude<LinkedInProfileSectionType, "about">;

export interface ProfileSeedUnsupportedField {
  path: string;
  reason: string;
  issueNumber: number;
}

export interface ProfileSeedSectionInput {
  itemId?: string;
  match?: LinkedInProfileSectionItemMatch;
  values: Record<string, unknown>;
}

export interface ProfileSeedSpec {
  intro?: Record<string, unknown>;
  about?: string | null;
  sections: Partial<Record<SeedSectionType, ProfileSeedSectionInput[]>>;
  unsupportedFields: ProfileSeedUnsupportedField[];
}

export interface ProfileSeedPlan {
  actions: ProfileSeedPlanAction[];
  unsupportedFields: ProfileSeedUnsupportedField[];
}

export type ProfileSeedPlanAction =
  | {
      kind: "update_intro";
      summary: string;
      input: PrepareUpdateIntroInput;
    }
  | {
      kind: "update_settings";
      summary: string;
      input: PrepareUpdateSettingsInput;
    }
  | {
      kind: "update_public_profile";
      summary: string;
      input: PrepareUpdatePublicProfileInput;
    }
  | {
      kind: "upsert_section_item";
      summary: string;
      input: PrepareUpsertSectionItemInput;
    }
  | {
      kind: "remove_section_item";
      summary: string;
      input: PrepareRemoveSectionItemInput;
    };

export function parseProfileSeedSpec(input: unknown): ProfileSeedSpec {
  if (!isRecord(input)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Profile seed spec must be a JSON object."
    );
  }

  const unsupportedFields: ProfileSeedUnsupportedField[] = [];
  const intro = normalizeIntroSpec(input.intro) ?? {};
  const about = normalizeAboutSpec(input.about);
  const sections: Partial<Record<SeedSectionType, ProfileSeedSectionInput[]>> = {};

  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (rawKey === "intro" || rawKey === "about" || rawKey === "metadata" || rawKey === "notes") {
      continue;
    }

    if (rawKey === "recommendations") {
      if (Array.isArray(rawValue) && rawValue.length > 0) {
        unsupportedFields.push({
          path: "recommendations",
          reason: "Recommendations are not exposed by the current LinkedIn profile edit automation.",
          issueNumber: 0
        });
      }
      continue;
    }

    if (rawKey === "industry") {
      intro.industry = rawValue;
      continue;
    }

    const publicProfileKey = PUBLIC_PROFILE_FIELD_ALIASES.get(normalizeKey(rawKey));
    if (publicProfileKey) {
      intro[publicProfileKey] = rawValue;
      continue;
    }

    const section = SECTION_KEY_ALIASES.get(normalizeKey(rawKey));
    if (!section || section === "about") {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `Unsupported profile seed spec key "${rawKey}".`
      );
    }

    sections[section] = normalizeSectionInputs(rawValue, rawKey);
  }

  return {
    ...(Object.keys(intro).length > 0 ? { intro } : {}),
    ...(about !== undefined ? { about } : {}),
    sections,
    unsupportedFields
  };
}

export function createProfileSeedPlan(
  current: LinkedInEditableProfile,
  spec: ProfileSeedSpec,
  options: {
    profileName: string;
    operatorNote?: string;
    replace: boolean;
  }
): ProfileSeedPlan {
  const actions: ProfileSeedPlanAction[] = [];
  const currentSections = new Map<LinkedInProfileSectionType, LinkedInProfileEditableSection>(
    current.sections.map((section) => [section.section, section])
  );

  if (spec.intro) {
    const introUpdates = createIntroUpdates(current, spec.intro);
    if (Object.keys(introUpdates).length > 0) {
      actions.push({
        kind: "update_intro",
        summary: `Update intro (${Object.keys(introUpdates).join(", ")})`,
        input: {
          profileName: options.profileName,
          ...introUpdates,
          ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
        }
      });
    }

    const settingsUpdates = createSettingsUpdates(current, spec.intro);
    if (Object.keys(settingsUpdates).length > 0) {
      actions.push({
        kind: "update_settings",
        summary: `Update profile settings (${Object.keys(settingsUpdates).join(", ")})`,
        input: {
          profileName: options.profileName,
          ...settingsUpdates,
          ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
        }
      });
    }

    const vanityName = createPublicProfileUpdate(current, spec.intro);
    if (vanityName) {
      actions.push({
        kind: "update_public_profile",
        summary: `Update public profile URL (${vanityName})`,
        input: {
          profileName: options.profileName,
          vanityName,
          ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
        }
      });
    }
  }

  if (spec.about !== undefined) {
    const aboutSection = currentSections.get("about");
    const currentAboutItem = aboutSection?.items[0];
    const desiredAbout = typeof spec.about === "string" ? spec.about.trim() : "";
    const currentAbout = readCurrentAboutText(currentAboutItem);

    if (desiredAbout !== currentAbout) {
      if (desiredAbout.length === 0) {
        actions.push({
          kind: "remove_section_item",
          summary: currentAboutItem ? "Clear about summary" : "No-op clear about summary",
          input: {
            profileName: options.profileName,
            section: "about",
            ...(currentAboutItem ? { itemId: currentAboutItem.item_id } : {}),
            ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
          }
        });
      } else {
        actions.push({
          kind: "upsert_section_item",
          summary: currentAboutItem ? "Update about summary" : "Create about summary",
          input: {
            profileName: options.profileName,
            section: "about",
            ...(currentAboutItem ? { itemId: currentAboutItem.item_id } : {}),
            values: { text: desiredAbout },
            ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
          }
        });
      }
    }
  }

  for (const section of SUPPORTED_SECTION_TYPES) {
    const desiredItems = spec.sections[section];
    if (!desiredItems) {
      continue;
    }

    const currentItems = currentSections.get(section)?.items ?? [];
    const matchedCurrentItemIds = new Set<string>();

    for (const desiredItem of desiredItems) {
      const matchedItem = findCurrentSectionItem(currentItems, section, desiredItem);
      const resolvedItemId = matchedItem?.item_id ?? desiredItem.itemId;
      if (matchedItem) {
        matchedCurrentItemIds.add(matchedItem.item_id);
      }

      actions.push({
        kind: "upsert_section_item",
        summary: buildUpsertSummary(section, desiredItem.values, Boolean(resolvedItemId)),
        input: {
          profileName: options.profileName,
          section,
          ...(resolvedItemId ? { itemId: resolvedItemId } : {}),
          ...(!resolvedItemId && desiredItem.match ? { match: desiredItem.match } : {}),
          values: desiredItem.values,
          ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
        }
      });
    }

    if (options.replace) {
      for (const currentItem of currentItems) {
        if (matchedCurrentItemIds.has(currentItem.item_id)) {
          continue;
        }

        actions.push({
          kind: "remove_section_item",
          summary: buildRemoveSummary(section, currentItem),
          input: {
            profileName: options.profileName,
            section,
            itemId: currentItem.item_id,
            ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
          }
        });
      }
    }
  }

  return {
    actions,
    unsupportedFields: [...spec.unsupportedFields]
  };
}

function normalizeIntroSpec(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "profile seed intro must be a JSON object."
    );
  }

  const intro: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(value)) {
    if (INTRO_FIELD_KEYS.has(key)) {
      intro[key] = rawValue;
      continue;
    }

    if (SETTINGS_FIELD_KEYS.has(key)) {
      intro[key] = rawValue;
      continue;
    }

    const publicProfileKey = PUBLIC_PROFILE_FIELD_ALIASES.get(normalizeKey(key));
    if (publicProfileKey) {
      intro[publicProfileKey] = rawValue;
      continue;
    }

    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Unsupported intro field "${key}" in profile seed spec.`
    );
  }

  return Object.keys(intro).length > 0 ? intro : undefined;
}

function normalizeAboutSpec(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && typeof value.text === "string") {
    return value.text;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    'profile seed "about" must be a string, null, or an object with a string "text" field.'
  );
}

function normalizeSectionInputs(
  value: unknown,
  label: string
): ProfileSeedSectionInput[] {
  if (!Array.isArray(value)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON array.`
    );
  }

  return value.map((entry, index) => normalizeSectionInput(entry, `${label}[${index}]`));
}

function normalizeSectionInput(
  value: unknown,
  label: string
): ProfileSeedSectionInput {
  if (!isRecord(value)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const itemId = typeof value.itemId === "string" ? value.itemId.trim() : undefined;
  const rawMatch =
    isRecord(value.match) || isRecord(value._match)
      ? (isRecord(value.match) ? value.match : value._match)
      : undefined;
  const match = rawMatch ? normalizeMatch(rawMatch as Record<string, unknown>, `.match`) : undefined;
  const values: Record<string, unknown> = {};

  for (const [key, entryValue] of Object.entries(value)) {
    if (key === "itemId" || key === "match" || key === "_match" || key === "_itemId") {
      continue;
    }
    values[key] = entryValue;
  }

  if (Object.keys(values).length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must include at least one section value.`
    );
  }

  return {
    ...(itemId ? { itemId } : {}),
    ...(match ? { match } : {}),
    values
  };
}

function normalizeMatch(
  value: Record<string, unknown>,
  label: string
): LinkedInProfileSectionItemMatch {
  const match: LinkedInProfileSectionItemMatch = {};

  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `${label}.${key} must be a string.`
      );
    }

    if (
      key !== "sourceId" &&
      key !== "primaryText" &&
      key !== "secondaryText" &&
      key !== "tertiaryText" &&
      key !== "rawText"
    ) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `${label}.${key} is not a supported match field.`
      );
    }

    match[key] = rawValue;
  }

  return match;
}

function createIntroUpdates(
  current: LinkedInEditableProfile,
  desiredIntro: Record<string, unknown>
): Record<string, string> {
  const updates: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(desiredIntro)) {
    if (!INTRO_FIELD_KEYS.has(key)) {
      continue;
    }

    const desiredValue = readString(rawValue);
    if (!desiredValue) {
      continue;
    }

    const currentValue =
      key === "firstName"
        ? normalizeForCompare(readFirstName(current.intro.full_name))
        : key === "lastName"
          ? normalizeForCompare(readLastName(current.intro.full_name))
          : key === "headline"
            ? normalizeForCompare(current.intro.headline)
            : normalizeForCompare(current.intro.location);

    if (normalizeForCompare(desiredValue) !== currentValue) {
      updates[key] = desiredValue;
    }
  }

  return updates;
}

function createSettingsUpdates(
  current: LinkedInEditableProfile,
  desiredIntro: Record<string, unknown>
): Record<string, string> {
  const desiredIndustry = readString(desiredIntro.industry);
  if (!desiredIndustry) {
    return {};
  }

  return normalizeForCompare(desiredIndustry) !== normalizeForCompare(current.settings.industry)
    ? { industry: desiredIndustry }
    : {};
}

function createPublicProfileUpdate(
  current: LinkedInEditableProfile,
  desiredIntro: Record<string, unknown>
): string | undefined {
  const desiredValue = readString(desiredIntro.customProfileUrl);
  if (!desiredValue) {
    return undefined;
  }

  const vanityName = normalizePublicProfileValue(desiredValue);
  return normalizeForCompare(vanityName) !== normalizeForCompare(current.public_profile.vanity_name)
    ? vanityName
    : undefined;
}

function readFirstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

function readLastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

function readCurrentAboutText(item: LinkedInProfileEditableSectionItem | undefined): string {
  if (!item) {
    return "";
  }

  return readString(item.description || item.raw_text || item.primary_text);
}

function findCurrentSectionItem(
  currentItems: readonly LinkedInProfileEditableSectionItem[],
  section: SeedSectionType,
  desiredItem: ProfileSeedSectionInput
): LinkedInProfileEditableSectionItem | undefined {
  if (desiredItem.itemId) {
    return currentItems.find((item) => item.item_id === desiredItem.itemId);
  }

  const explicitMatch = desiredItem.match;
  if (explicitMatch) {
    return currentItems.find((item) => doesItemMatch(item, explicitMatch));
  }

  const identityStrings = SECTION_IDENTITY_FIELDS[section]
    .map((field) => normalizeForCompare(desiredItem.values[field]))
    .filter(Boolean);

  if (identityStrings.length === 0) {
    return undefined;
  }

  return currentItems.find((item) => {
    const haystack = normalizeForCompare(
      [item.primary_text, item.secondary_text, item.tertiary_text, item.description, item.raw_text]
        .filter(Boolean)
        .join(" ")
    );
    return identityStrings.every((needle) => haystack.includes(needle));
  });
}

function doesItemMatch(
  item: LinkedInProfileEditableSectionItem,
  match: LinkedInProfileSectionItemMatch
): boolean {
  const comparisons: Array<[string | undefined, string]> = [
    [match.sourceId, normalizeForCompare(item.source_id)],
    [match.primaryText, normalizeForCompare(item.primary_text)],
    [match.secondaryText, normalizeForCompare(item.secondary_text)],
    [match.tertiaryText, normalizeForCompare(item.tertiary_text)],
    [match.rawText, normalizeForCompare(item.raw_text)]
  ];
  let matched = 0;

  for (const [expected, actual] of comparisons) {
    if (!expected) {
      continue;
    }

    const normalizedExpected = normalizeForCompare(expected);
    if (!normalizedExpected) {
      continue;
    }

    if (actual === normalizedExpected || actual.includes(normalizedExpected)) {
      matched += 1;
      continue;
    }

    return false;
  }

  return matched > 0;
}

function buildUpsertSummary(
  section: SeedSectionType,
  values: Record<string, unknown>,
  updating: boolean
): string {
  const subject = describeSectionValues(section, values);
  return `${updating ? "Update" : "Create"} ${section.replaceAll("_", " ")} item${subject ? `: ${subject}` : ""}`;
}

function buildRemoveSummary(
  section: SeedSectionType,
  item: LinkedInProfileEditableSectionItem
): string {
  const subject = describeSectionItem(section, item);
  return `Remove ${section.replaceAll("_", " ")} item${subject ? `: ${subject}` : ""}`;
}

function describeSectionValues(
  section: SeedSectionType,
  values: Record<string, unknown>
): string {
  switch (section) {
    case "experience":
      return joinSummaryParts(values.title, values.company);
    case "education":
      return joinSummaryParts(values.school, values.degree);
    case "certifications":
      return joinSummaryParts(values.name, values.issuingOrganization);
    case "languages":
      return joinSummaryParts(values.name, values.proficiency);
    case "projects":
      return readString(values.title);
    case "volunteer_experience":
      return joinSummaryParts(values.role, values.organization);
    case "honors_awards":
      return joinSummaryParts(values.title, values.issuer);
    case "skills":
      return readString(values.name);
  }
}

function describeSectionItem(
  section: SeedSectionType,
  item: LinkedInProfileEditableSectionItem
): string {
  switch (section) {
    case "experience":
    case "education":
    case "certifications":
    case "languages":
    case "volunteer_experience":
    case "honors_awards":
      return joinSummaryParts(item.primary_text, item.secondary_text);
    case "projects":
      return readString(item.primary_text);
    case "skills":
      return readString(item.primary_text);
  }
}

function joinSummaryParts(...parts: unknown[]): string {
  return parts.map((part) => readString(part)).filter(Boolean).join(" — ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePublicProfileValue(value: string): string {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return "";
  }

  if (/^https?:\/\//iu.test(trimmedValue) || trimmedValue.startsWith("/in/")) {
    try {
      const normalizedUrl = trimmedValue.startsWith("/in/")
        ? `https://www.linkedin.com${trimmedValue}`
        : trimmedValue;
      const parsed = new URL(normalizedUrl);
      const vanityMatch = /^\/in\/([^/]+)\/?$/iu.exec(parsed.pathname);
      return vanityMatch?.[1]?.trim() ?? "";
    } catch {
      return "";
    }
  }

  return trimmedValue.replace(/^\/+|\/+$/gu, "").replace(/^in\//iu, "");
}

function normalizeForCompare(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
