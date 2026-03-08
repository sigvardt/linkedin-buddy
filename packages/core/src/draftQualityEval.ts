import { LinkedInAssistantError } from "./errors.js";
import { createRunId } from "./run.js";
import {
  DRAFT_QUALITY_DRAFT_SOURCES,
  DRAFT_QUALITY_SCHEMA_VERSION,
  DRAFT_QUALITY_TONE_LABELS,
  type DraftQualityCandidateDraft,
  type DraftQualityCandidateSet,
  type DraftQualityCase,
  type DraftQualityCaseResult,
  type DraftQualityDraftSource,
  type DraftQualityExpectations,
  type DraftQualityExternalCandidateDraft,
  type DraftQualityHardFailure,
  type DraftQualityJsonObject,
  type DraftQualityJsonValue,
  type DraftQualityJudgeMetricFeedback,
  type DraftQualityLengthDetails,
  type DraftQualityLengthExpectations,
  type DraftQualityMetricResult,
  type DraftQualityParticipant,
  type DraftQualityParticipantRole,
  type DraftQualityReport,
  type DraftQualityRelevanceDetails,
  type DraftQualityRequiredPoint,
  type DraftQualityThread,
  type DraftQualityThreadMessage,
  type DraftQualityToneDetails,
  type DraftQualityToneEvidence,
  type DraftQualityToneExpectations,
  type DraftQualityToneLabel,
  type DraftQualityMessageDirection,
  type DraftQualityDataset,
  type EvaluateDraftQualityInput
} from "./draftQualityTypes.js";

const NON_WORD_PATTERN = /[^\p{L}\p{N}]+/gu;
const SENTENCE_SPLIT_PATTERN = /[.!?]+/;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "but",
  "for",
  "from",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "just",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "their",
  "this",
  "to",
  "up",
  "we",
  "with",
  "you",
  "your"
]);

const WARM_SIGNALS = [
  "thanks",
  "thank you",
  "appreciate",
  "happy to",
  "glad",
  "understand",
  "totally understand",
  "no worries",
  "hope"
] as const;

const PROFESSIONAL_SIGNALS = [
  "thank you",
  "thanks",
  "appreciate",
  "happy to",
  "please",
  "let me know",
  "would you",
  "could you",
  "i can send"
] as const;

const FRIENDLY_SIGNALS = [
  "thanks",
  "thank you",
  "happy to",
  "glad",
  "great",
  "hope"
] as const;

const CURIOUS_SIGNALS = [
  "curious",
  "would you be open",
  "would you be interested",
  "could you",
  "what works",
  "when would"
] as const;

const APPRECIATIVE_SIGNALS = [
  "thanks",
  "thank you",
  "appreciate",
  "grateful"
] as const;

const DIRECT_SIGNALS = [
  "let me know",
  "can we",
  "could we",
  "would next week",
  "are you available",
  "open to",
  "happy to reconnect",
  "i can send",
  "send a one page overview",
  "send a one-page overview"
] as const;

const EMPATHETIC_SIGNALS = [
  "understand",
  "totally understand",
  "no worries",
  "sorry",
  "appreciate"
] as const;

const PUSHY_SIGNALS = [
  "just circling back",
  "circling back",
  "following up again",
  "asap",
  "urgent",
  "please respond",
  "bumping",
  "kind reminder",
  "checking again"
] as const;

const ROBOTIC_SIGNALS = [
  "as an ai",
  "i am an ai",
  "furthermore",
  "hereby",
  "leverage",
  "synergy",
  "dear sir",
  "dear madam",
  "your prompt"
] as const;

const CASUAL_SIGNALS = [
  "hey",
  "awesome",
  "super",
  "lol",
  "haha",
  "gonna",
  "wanna",
  "cheers"
] as const;

interface ToneContext {
  original_text: string;
  normalized_text: string;
  word_count: number;
  sentence_count: number;
  length_expectations: DraftQualityLengthExpectations;
}

interface DeterministicDraftEvaluation {
  relevance: DraftQualityMetricResult<DraftQualityRelevanceDetails>;
  tone: DraftQualityMetricResult<DraftQualityToneDetails>;
  length: DraftQualityMetricResult<DraftQualityLengthDetails>;
  hard_failures: DraftQualityHardFailure[];
}

function createInputError(
  message: string,
  details: Record<string, unknown> = {}
): LinkedInAssistantError {
  return new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    message,
    details
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readValue(
  record: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }

  return undefined;
}

function readOptionalString(
  record: Record<string, unknown>,
  keys: readonly string[],
  location: string
): string | undefined {
  const value = readValue(record, keys);
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw createInputError(`Expected ${location}.${keys[0]} to be a string.`, {
      location,
      field: keys[0]
    });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createInputError(`Expected ${location}.${keys[0]} to be non-empty.`, {
      location,
      field: keys[0]
    });
  }

  return trimmed;
}

function readRequiredString(
  record: Record<string, unknown>,
  keys: readonly string[],
  location: string
): string {
  const value = readOptionalString(record, keys, location);
  if (value === undefined) {
    throw createInputError(`Missing required field ${location}.${keys[0]}.`, {
      location,
      field: keys[0]
    });
  }

  return value;
}

function readOptionalArray(
  record: Record<string, unknown>,
  keys: readonly string[],
  location: string
): unknown[] | undefined {
  const value = readValue(record, keys);
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw createInputError(`Expected ${location}.${keys[0]} to be an array.`, {
      location,
      field: keys[0]
    });
  }

  return value;
}

function readRequiredArray(
  record: Record<string, unknown>,
  keys: readonly string[],
  location: string
): unknown[] {
  const value = readOptionalArray(record, keys, location);
  if (value === undefined) {
    throw createInputError(`Missing required field ${location}.${keys[0]}.`, {
      location,
      field: keys[0]
    });
  }

  return value;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
  location: string
): number | undefined {
  const value = readValue(record, keys);
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw createInputError(`Expected ${location}.${keys[0]} to be a number.`, {
      location,
      field: keys[0]
    });
  }

  return value;
}

function readOptionalObject(
  record: Record<string, unknown>,
  keys: readonly string[],
  location: string
): Record<string, unknown> | undefined {
  const value = readValue(record, keys);
  if (value === undefined) {
    return undefined;
  }

  const parsed = asRecord(value);
  if (!parsed) {
    throw createInputError(`Expected ${location}.${keys[0]} to be an object.`, {
      location,
      field: keys[0]
    });
  }

  return parsed;
}

function parseJsonValue(value: unknown, location: string): DraftQualityJsonValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => parseJsonValue(item, `${location}[${index}]`));
  }

  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be JSON-serializable.`, {
      location
    });
  }

  const parsed: DraftQualityJsonObject = {};
  for (const [key, entry] of Object.entries(record)) {
    parsed[key] = parseJsonValue(entry, `${location}.${key}`);
  }
  return parsed;
}

function parseMetadataObject(
  record: Record<string, unknown> | undefined,
  location: string
): DraftQualityJsonObject | undefined {
  if (!record) {
    return undefined;
  }

  return parseJsonValue(record, location) as DraftQualityJsonObject;
}

function parseInteger(
  value: number,
  location: string,
  field: string,
  minimum: number
): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw createInputError(
      `Expected ${location}.${field} to be an integer greater than or equal to ${minimum}.`,
      {
        location,
        field,
        minimum
      }
    );
  }

  return value;
}

function isToneLabel(value: string): value is DraftQualityToneLabel {
  return (DRAFT_QUALITY_TONE_LABELS as readonly string[]).includes(value);
}

function isDraftSource(value: string): value is DraftQualityDraftSource {
  return (DRAFT_QUALITY_DRAFT_SOURCES as readonly string[]).includes(value);
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const uniqueValues: T[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function parseStringList(values: unknown[], location: string): string[] {
  const parsedValues = values.map((value, index) => {
    if (typeof value !== "string") {
      throw createInputError(`Expected ${location}[${index}] to be a string.`, {
        location,
        index
      });
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw createInputError(`Expected ${location}[${index}] to be non-empty.`, {
        location,
        index
      });
    }

    return trimmed;
  });

  return uniqueStrings(parsedValues);
}

function parseToneLabels(values: unknown[], location: string): DraftQualityToneLabel[] {
  const parsedValues = parseStringList(values, location);
  return parsedValues.map((value) => {
    if (!isToneLabel(value)) {
      throw createInputError(`Unsupported tone label "${value}" at ${location}.`, {
        location,
        tone_label: value,
        supported_tone_labels: DRAFT_QUALITY_TONE_LABELS
      });
    }

    return value;
  });
}

function parseParticipantRole(
  value: string | undefined,
  location: string
): DraftQualityParticipantRole | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "assistant" || value === "contact" || value === "other") {
    return value;
  }

  throw createInputError(`Unsupported participant role "${value}" at ${location}.`, {
    location,
    participant_role: value
  });
}

function parseMessageDirection(
  value: string,
  location: string
): DraftQualityMessageDirection {
  if (value === "inbound" || value === "outbound") {
    return value;
  }

  throw createInputError(`Unsupported message direction "${value}" at ${location}.`, {
    location,
    direction: value
  });
}

function parseDraftSource(
  value: string,
  location: string
): DraftQualityDraftSource {
  if (isDraftSource(value)) {
    return value;
  }

  throw createInputError(`Unsupported draft source "${value}" at ${location}.`, {
    location,
    draft_source: value,
    supported_sources: DRAFT_QUALITY_DRAFT_SOURCES
  });
}

function parseParticipant(value: unknown, location: string): DraftQualityParticipant {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const id = readRequiredString(record, ["id"], location);
  const name = readRequiredString(record, ["name"], location);
  const role = parseParticipantRole(
    readOptionalString(record, ["role"], location),
    `${location}.role`
  );

  return {
    id,
    name,
    ...(role ? { role } : {})
  };
}

function parseThreadMessage(
  value: unknown,
  location: string
): DraftQualityThreadMessage {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const id = readRequiredString(record, ["id"], location);
  const author = readRequiredString(record, ["author"], location);
  const direction = parseMessageDirection(
    readRequiredString(record, ["direction"], location),
    `${location}.direction`
  );
  const text = readRequiredString(record, ["text"], location);
  const participantId = readOptionalString(
    record,
    ["participant_id", "participantId"],
    location
  );
  const createdAt = readOptionalString(record, ["created_at", "createdAt"], location);

  return {
    id,
    author,
    direction,
    text,
    ...(participantId ? { participant_id: participantId } : {}),
    ...(createdAt ? { created_at: createdAt } : {})
  };
}

function parseThread(value: unknown, location: string): DraftQualityThread {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const participants = readRequiredArray(record, ["participants"], location).map(
    (entry, index) => parseParticipant(entry, `${location}.participants[${index}]`)
  );
  const messages = readRequiredArray(record, ["messages"], location).map(
    (entry, index) => parseThreadMessage(entry, `${location}.messages[${index}]`)
  );

  if (participants.length === 0) {
    throw createInputError(`Expected ${location}.participants to include at least one participant.`, {
      location
    });
  }

  if (messages.length === 0) {
    throw createInputError(`Expected ${location}.messages to include at least one message.`, {
      location
    });
  }

  return {
    participants,
    messages
  };
}

function parseRequiredPoint(
  value: unknown,
  location: string
): DraftQualityRequiredPoint {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const id = readRequiredString(record, ["id"], location);
  const description = readOptionalString(record, ["description"], location);
  const aliasValues = readRequiredArray(record, ["aliases", "match_any", "matchAny"], location);
  const aliases = parseStringList(aliasValues, `${location}.aliases`);

  if (aliases.length === 0) {
    throw createInputError(`Expected ${location}.aliases to include at least one phrase.`, {
      location,
      point_id: id
    });
  }

  return {
    id,
    aliases,
    ...(description ? { description } : {})
  };
}

function parseLengthExpectations(
  value: unknown,
  location: string
): DraftQualityLengthExpectations {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const minWords = parseInteger(
    readOptionalNumber(record, ["min_words", "minWords"], location) ?? NaN,
    location,
    "min_words",
    0
  );
  const maxWords = parseInteger(
    readOptionalNumber(record, ["max_words", "maxWords"], location) ?? NaN,
    location,
    "max_words",
    1
  );
  const targetWordsValue = readOptionalNumber(
    record,
    ["target_words", "targetWords"],
    location
  );
  const maxSentencesValue = readOptionalNumber(
    record,
    ["max_sentences", "maxSentences"],
    location
  );

  if (minWords > maxWords) {
    throw createInputError(
      `${location}.min_words must be less than or equal to ${location}.max_words.`,
      { location }
    );
  }

  const targetWords =
    targetWordsValue === undefined
      ? undefined
      : parseInteger(targetWordsValue, location, "target_words", 0);
  const maxSentences =
    maxSentencesValue === undefined
      ? undefined
      : parseInteger(maxSentencesValue, location, "max_sentences", 1);

  if (targetWords !== undefined && (targetWords < minWords || targetWords > maxWords)) {
    throw createInputError(
      `${location}.target_words must stay within the configured word-count range.`,
      { location, min_words: minWords, max_words: maxWords, target_words: targetWords }
    );
  }

  return {
    min_words: minWords,
    max_words: maxWords,
    ...(targetWords !== undefined ? { target_words: targetWords } : {}),
    ...(maxSentences !== undefined ? { max_sentences: maxSentences } : {})
  };
}

function parseToneExpectations(
  value: unknown,
  location: string
): DraftQualityToneExpectations {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const required = parseToneLabels(
    readOptionalArray(record, ["required"], location) ?? [],
    `${location}.required`
  );
  const forbidden = parseToneLabels(
    readOptionalArray(record, ["forbidden"], location) ?? [],
    `${location}.forbidden`
  );
  const optional = parseToneLabels(
    readOptionalArray(record, ["optional"], location) ?? [],
    `${location}.optional`
  ).filter((label) => !required.includes(label) && !forbidden.includes(label));

  const conflictingLabels = required.filter((label) => forbidden.includes(label));
  if (conflictingLabels.length > 0) {
    throw createInputError(
      `${location} includes tone labels that are both required and forbidden.`,
      {
        location,
        conflicting_tone_labels: conflictingLabels
      }
    );
  }

  return {
    required,
    optional,
    forbidden
  };
}

function parseExpectations(
  value: unknown,
  location: string
): DraftQualityExpectations {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const tone = parseToneExpectations(
    readValue(record, ["tone"]),
    `${location}.tone`
  );
  const length = parseLengthExpectations(
    readValue(record, ["length"]),
    `${location}.length`
  );
  const requiredPoints = readRequiredArray(
    record,
    ["required_points", "requiredPoints"],
    location
  ).map((entry, index) => parseRequiredPoint(entry, `${location}.required_points[${index}]`));
  const forbiddenPhrases = parseStringList(
    readOptionalArray(record, ["forbidden_phrases", "forbiddenPhrases"], location) ?? [],
    `${location}.forbidden_phrases`
  );
  const manualNotes = parseStringList(
    readOptionalArray(record, ["manual_notes", "manualNotes"], location) ?? [],
    `${location}.manual_notes`
  );

  const seenPointIds = new Set<string>();
  for (const point of requiredPoints) {
    if (seenPointIds.has(point.id)) {
      throw createInputError(`Duplicate required point id "${point.id}" in ${location}.`, {
        location,
        point_id: point.id
      });
    }
    seenPointIds.add(point.id);
  }

  return {
    tone,
    length,
    required_points: requiredPoints,
    forbidden_phrases: forbiddenPhrases,
    manual_notes: manualNotes
  };
}

function parseCandidateDraft(
  value: unknown,
  location: string
): DraftQualityCandidateDraft {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const id = readRequiredString(record, ["id"], location);
  const source = parseDraftSource(
    readRequiredString(record, ["source"], location),
    `${location}.source`
  );
  const text = readRequiredString(record, ["text"], location);
  const label = readOptionalString(record, ["label"], location);
  const metadata = parseMetadataObject(
    readOptionalObject(record, ["metadata"], location),
    `${location}.metadata`
  );

  return {
    id,
    source,
    text,
    ...(label ? { label } : {}),
    ...(metadata ? { metadata } : {})
  };
}

function parseExternalCandidateDraft(
  value: unknown,
  location: string
): DraftQualityExternalCandidateDraft {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const caseId = readRequiredString(record, ["case_id", "caseId"], location);
  const draft = parseCandidateDraft(record, location);

  return {
    case_id: caseId,
    ...draft
  };
}

function parseSchemaVersion(
  record: Record<string, unknown>,
  location: string
): typeof DRAFT_QUALITY_SCHEMA_VERSION {
  const version = readOptionalNumber(record, ["schema_version", "schemaVersion"], location);
  if (version === undefined) {
    return DRAFT_QUALITY_SCHEMA_VERSION;
  }

  if (version !== DRAFT_QUALITY_SCHEMA_VERSION) {
    throw createInputError(`Unsupported schema version ${String(version)} at ${location}.`, {
      location,
      schema_version: version,
      supported_schema_version: DRAFT_QUALITY_SCHEMA_VERSION
    });
  }

  return DRAFT_QUALITY_SCHEMA_VERSION;
}

function assertUniqueDraftIds(
  drafts: DraftQualityCandidateDraft[],
  location: string,
  caseId: string
): void {
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.id)) {
      throw createInputError(
        `Duplicate draft id "${draft.id}" found for case "${caseId}".`,
        {
          location,
          case_id: caseId,
          draft_id: draft.id
        }
      );
    }
    seen.add(draft.id);
  }
}

function parseCase(value: unknown, location: string): DraftQualityCase {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const id = readRequiredString(record, ["id"], location);
  const channel = readOptionalString(record, ["channel"], location);
  const scenario = readOptionalString(record, ["scenario"], location);
  const thread = parseThread(readValue(record, ["thread"]), `${location}.thread`);
  const expectations = parseExpectations(
    readValue(record, ["expectations"]),
    `${location}.expectations`
  );
  const candidateDrafts = (
    readOptionalArray(record, ["candidate_drafts", "candidateDrafts"], location) ?? []
  ).map((entry, index) => parseCandidateDraft(entry, `${location}.candidate_drafts[${index}]`));
  const metadata = parseMetadataObject(
    readOptionalObject(record, ["metadata"], location),
    `${location}.metadata`
  );

  assertUniqueDraftIds(candidateDrafts, `${location}.candidate_drafts`, id);

  return {
    id,
    thread,
    expectations,
    candidate_drafts: candidateDrafts,
    ...(channel ? { channel } : {}),
    ...(scenario ? { scenario } : {}),
    ...(metadata ? { metadata } : {})
  };
}

export function parseDraftQualityDataset(value: unknown): DraftQualityDataset {
  const record = asRecord(value);
  if (!record) {
    throw createInputError("Draft-quality dataset must be a JSON object.");
  }

  const schemaVersion = parseSchemaVersion(record, "dataset");
  const name = readOptionalString(record, ["name"], "dataset");
  const metadata = parseMetadataObject(
    readOptionalObject(record, ["metadata"], "dataset"),
    "dataset.metadata"
  );
  const cases = readRequiredArray(record, ["cases"], "dataset").map((entry, index) =>
    parseCase(entry, `dataset.cases[${index}]`)
  );

  if (cases.length === 0) {
    throw createInputError("Draft-quality dataset must contain at least one case.", {
      location: "dataset.cases"
    });
  }

  const seenCaseIds = new Set<string>();
  for (const draftCase of cases) {
    if (seenCaseIds.has(draftCase.id)) {
      throw createInputError(`Duplicate case id "${draftCase.id}" in dataset.`, {
        case_id: draftCase.id
      });
    }
    seenCaseIds.add(draftCase.id);
  }

  return {
    schema_version: schemaVersion,
    cases,
    ...(name ? { name } : {}),
    ...(metadata ? { metadata } : {})
  };
}

export function parseDraftQualityCandidateSet(value: unknown): DraftQualityCandidateSet {
  const record = asRecord(value);
  if (!record) {
    throw createInputError("Draft-quality candidates file must be a JSON object.");
  }

  const schemaVersion = parseSchemaVersion(record, "candidates");
  const metadata = parseMetadataObject(
    readOptionalObject(record, ["metadata"], "candidates"),
    "candidates.metadata"
  );
  const drafts = readRequiredArray(
    record,
    ["drafts", "candidates", "candidate_drafts", "candidateDrafts"],
    "candidates"
  ).map((entry, index) => parseExternalCandidateDraft(entry, `candidates.drafts[${index}]`));

  const seenDraftKeys = new Set<string>();
  for (const draft of drafts) {
    const draftKey = `${draft.case_id}::${draft.id}`;
    if (seenDraftKeys.has(draftKey)) {
      throw createInputError(
        `Duplicate draft id "${draft.id}" found for case "${draft.case_id}" in candidates file.`,
        {
          case_id: draft.case_id,
          draft_id: draft.id
        }
      );
    }

    seenDraftKeys.add(draftKey);
  }

  return {
    schema_version: schemaVersion,
    drafts,
    ...(metadata ? { metadata } : {})
  };
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(NON_WORD_PATTERN, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenizeText(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function countWords(value: string): number {
  return tokenizeText(value).length;
}

function countSentences(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  const segments = trimmed
    .split(SENTENCE_SPLIT_PATTERN)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments.length === 0 ? 1 : segments.length;
}

function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedNeedle = normalizeText(needle);

  if (normalizedHaystack.length === 0 || normalizedNeedle.length === 0) {
    return false;
  }

  return ` ${normalizedHaystack} `.includes(` ${normalizedNeedle} `);
}

function matchSignalPhrases(text: string, phrases: readonly string[]): string[] {
  return uniqueStrings(phrases.filter((phrase) => containsNormalizedPhrase(text, phrase)));
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

function roundScore(value: number): number {
  return Math.round(clampScore(value) * 1_000) / 1_000;
}

function detectToneEvidence(
  tone: DraftQualityToneLabel,
  context: ToneContext
): string[] {
  switch (tone) {
    case "warm":
      return matchSignalPhrases(context.original_text, WARM_SIGNALS);
    case "professional": {
      const blockers = matchSignalPhrases(context.original_text, CASUAL_SIGNALS);
      if (blockers.length > 0 || /!{2,}/.test(context.original_text)) {
        return [];
      }

      return matchSignalPhrases(context.original_text, PROFESSIONAL_SIGNALS);
    }
    case "friendly":
      return matchSignalPhrases(context.original_text, FRIENDLY_SIGNALS);
    case "concise": {
      const wordThreshold =
        context.length_expectations.target_words ??
        Math.min(context.length_expectations.max_words, 30);
      const sentenceThreshold = Math.min(
        context.length_expectations.max_sentences ?? 2,
        2
      );

      if (
        context.word_count <= wordThreshold &&
        context.sentence_count <= sentenceThreshold
      ) {
        return [
          `${context.word_count} words within concise threshold ${wordThreshold}`,
          `${context.sentence_count} sentences within concise threshold ${sentenceThreshold}`
        ];
      }

      return [];
    }
    case "curious": {
      const evidence = matchSignalPhrases(context.original_text, CURIOUS_SIGNALS);
      if (context.original_text.includes("?")) {
        evidence.push("question mark");
      }
      return uniqueStrings(evidence);
    }
    case "appreciative":
      return matchSignalPhrases(context.original_text, APPRECIATIVE_SIGNALS);
    case "direct":
      return matchSignalPhrases(context.original_text, DIRECT_SIGNALS);
    case "empathetic":
      return matchSignalPhrases(context.original_text, EMPATHETIC_SIGNALS);
    case "pushy": {
      const evidence = matchSignalPhrases(context.original_text, PUSHY_SIGNALS);
      if (/!{2,}/.test(context.original_text)) {
        evidence.push("repeated exclamation marks");
      }
      return uniqueStrings(evidence);
    }
    case "robotic":
      return matchSignalPhrases(context.original_text, ROBOTIC_SIGNALS);
    case "casual":
      return matchSignalPhrases(context.original_text, CASUAL_SIGNALS);
  }
}

function evaluateLength(
  expectations: DraftQualityLengthExpectations,
  draftText: string
): DraftQualityMetricResult<DraftQualityLengthDetails> {
  const wordCount = countWords(draftText);
  const sentenceCount = countSentences(draftText);
  let score = 1;

  if (wordCount < expectations.min_words && expectations.min_words > 0) {
    score = Math.min(score, wordCount / expectations.min_words);
  }

  if (wordCount > expectations.max_words && wordCount > 0) {
    score = Math.min(score, expectations.max_words / wordCount);
  }

  if (
    expectations.max_sentences !== undefined &&
    sentenceCount > expectations.max_sentences &&
    sentenceCount > 0
  ) {
    score = Math.min(score, expectations.max_sentences / sentenceCount);
  }

  return {
    passed:
      wordCount >= expectations.min_words &&
      wordCount <= expectations.max_words &&
      (expectations.max_sentences === undefined ||
        sentenceCount <= expectations.max_sentences),
    score: roundScore(score),
    mode: "deterministic",
    details: {
      word_count: wordCount,
      sentence_count: sentenceCount,
      min_words: expectations.min_words,
      max_words: expectations.max_words,
      target_words: expectations.target_words ?? null,
      max_sentences: expectations.max_sentences ?? null,
      distance_from_target:
        expectations.target_words === undefined
          ? null
          : Math.abs(wordCount - expectations.target_words)
    }
  };
}

function extractLatestInboundMessage(thread: DraftQualityThread): DraftQualityThreadMessage | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const candidate = thread.messages[index];
    if (candidate && candidate.direction === "inbound") {
      return candidate;
    }
  }

  return null;
}

function extractKeywords(value: string): string[] {
  const tokens = tokenizeText(value);
  const filteredTokens = tokens.filter(
    (token) => token.length >= 4 && !STOP_WORDS.has(token)
  );
  return uniqueStrings(filteredTokens).slice(0, 6);
}

function buildOffTopicSignals(
  thread: DraftQualityThread,
  draftText: string,
  totalRequiredPoints: number,
  coveredPointCount: number
): string[] {
  const signals: string[] = [];
  const latestInbound = extractLatestInboundMessage(thread);

  if (totalRequiredPoints > 0 && coveredPointCount === 0) {
    signals.push("Draft missed every required point for the active thread.");
  }

  if (!latestInbound) {
    return signals;
  }

  const latestKeywords = extractKeywords(latestInbound.text);
  if (latestKeywords.length === 0) {
    return signals;
  }

  const draftTokens = new Set(tokenizeText(draftText));
  const overlappingKeywords = latestKeywords.filter((keyword) => draftTokens.has(keyword));

  if (overlappingKeywords.length === 0) {
    signals.push(
      `Draft shares no keywords with the latest inbound message (${latestKeywords.join(", ")}).`
    );
  } else if (overlappingKeywords.length === 1 && latestKeywords.length >= 3) {
    signals.push(
      `Draft only overlaps one latest-message keyword (${overlappingKeywords[0]}).`
    );
  }

  return signals;
}

function evaluateRelevance(
  expectations: DraftQualityExpectations,
  thread: DraftQualityThread,
  draftText: string,
  forbiddenPhraseHits: string[]
): DraftQualityMetricResult<DraftQualityRelevanceDetails> {
  const pointMatches = expectations.required_points.map((point) => {
    const matchedAliases = point.aliases.filter((alias) =>
      containsNormalizedPhrase(draftText, alias)
    );

    return {
      point_id: point.id,
      matched_aliases: uniqueStrings(matchedAliases)
    };
  });

  const coveredPointIds = pointMatches
    .filter((pointMatch) => pointMatch.matched_aliases.length > 0)
    .map((pointMatch) => pointMatch.point_id);
  const missingPointIds = pointMatches
    .filter((pointMatch) => pointMatch.matched_aliases.length === 0)
    .map((pointMatch) => pointMatch.point_id);
  const totalRequiredPoints = expectations.required_points.length;

  return {
    passed: missingPointIds.length === 0,
    score: totalRequiredPoints === 0 ? 1 : roundScore(coveredPointIds.length / totalRequiredPoints),
    mode: "deterministic",
    details: {
      total_required_points: totalRequiredPoints,
      covered_point_ids: coveredPointIds,
      missing_point_ids: missingPointIds,
      point_matches: pointMatches,
      off_topic_signals: buildOffTopicSignals(
        thread,
        draftText,
        totalRequiredPoints,
        coveredPointIds.length
      ),
      forbidden_phrase_hits: forbiddenPhraseHits,
      judge_rationale: []
    }
  };
}

function evaluateTone(
  expectations: DraftQualityExpectations,
  draftText: string,
  length: DraftQualityMetricResult<DraftQualityLengthDetails>
): DraftQualityMetricResult<DraftQualityToneDetails> {
  const context: ToneContext = {
    original_text: draftText,
    normalized_text: normalizeText(draftText),
    word_count: length.details.word_count,
    sentence_count: length.details.sentence_count,
    length_expectations: expectations.length
  };
  const labelsToInspect = uniqueStrings([
    ...expectations.tone.required,
    ...expectations.tone.optional,
    ...expectations.tone.forbidden
  ]);
  const evidenceByTone = new Map<DraftQualityToneLabel, string[]>();

  for (const tone of labelsToInspect) {
    evidenceByTone.set(tone, detectToneEvidence(tone, context));
  }

  const matchedRequired = expectations.tone.required.filter(
    (tone) => (evidenceByTone.get(tone)?.length ?? 0) > 0
  );
  const missingRequired = expectations.tone.required.filter(
    (tone) => (evidenceByTone.get(tone)?.length ?? 0) === 0
  );
  const optionalMatched = expectations.tone.optional.filter(
    (tone) => (evidenceByTone.get(tone)?.length ?? 0) > 0
  );
  const forbiddenTriggered = expectations.tone.forbidden.filter(
    (tone) => (evidenceByTone.get(tone)?.length ?? 0) > 0
  );

  const evidence: DraftQualityToneEvidence[] = labelsToInspect
    .map((tone) => {
      const signals = evidenceByTone.get(tone) ?? [];
      if (signals.length === 0) {
        return null;
      }

      return {
        tone,
        signals
      };
    })
    .filter((entry): entry is DraftQualityToneEvidence => entry !== null);

  return {
    passed: missingRequired.length === 0 && forbiddenTriggered.length === 0,
    score:
      expectations.tone.required.length === 0
        ? 1
        : roundScore(matchedRequired.length / expectations.tone.required.length),
    mode: "deterministic",
    details: {
      required: expectations.tone.required,
      matched: matchedRequired,
      missing: missingRequired,
      optional_matched: optionalMatched,
      forbidden_requested: expectations.tone.forbidden,
      forbidden_triggered: forbiddenTriggered,
      evidence,
      judge_rationale: []
    }
  };
}

function mergeJudgeMetric<TDetails extends { judge_rationale: string[] }>(
  metric: DraftQualityMetricResult<TDetails>,
  feedback: DraftQualityJudgeMetricFeedback | undefined
): DraftQualityMetricResult<TDetails> {
  if (!feedback) {
    return metric;
  }

  const mergedRationale = uniqueStrings([
    ...metric.details.judge_rationale,
    ...(feedback.rationale ?? [])
  ]);

  return {
    passed: metric.passed && (feedback.passed ?? true),
    score:
      typeof feedback.score === "number"
        ? roundScore((metric.score + clampScore(feedback.score)) / 2)
        : metric.score,
    mode: "hybrid",
    details: {
      ...metric.details,
      judge_rationale: mergedRationale
    }
  };
}

function createForbiddenPhraseFailures(forbiddenPhraseHits: string[]): DraftQualityHardFailure[] {
  if (forbiddenPhraseHits.length === 0) {
    return [];
  }

  return [
    {
      kind: "forbidden_phrase",
      message: `Draft used forbidden phrases: ${forbiddenPhraseHits.join(", ")}`,
      values: forbiddenPhraseHits
    }
  ];
}

function evaluateDeterministicDraft(
  draftCase: DraftQualityCase,
  draft: DraftQualityCandidateDraft
): DeterministicDraftEvaluation {
  const forbiddenPhraseHits = uniqueStrings(
    draftCase.expectations.forbidden_phrases.filter((phrase) =>
      containsNormalizedPhrase(draft.text, phrase)
    )
  );
  const length = evaluateLength(draftCase.expectations.length, draft.text);
  const relevance = evaluateRelevance(
    draftCase.expectations,
    draftCase.thread,
    draft.text,
    forbiddenPhraseHits
  );
  const tone = evaluateTone(draftCase.expectations, draft.text, length);

  return {
    relevance,
    tone,
    length,
    hard_failures: createForbiddenPhraseFailures(forbiddenPhraseHits)
  };
}

function createOverallResult(input: {
  relevance: DraftQualityMetricResult<DraftQualityRelevanceDetails>;
  tone: DraftQualityMetricResult<DraftQualityToneDetails>;
  length: DraftQualityMetricResult<DraftQualityLengthDetails>;
  hard_failures: DraftQualityHardFailure[];
}) {
  const failedMetrics: Array<"relevance" | "tone" | "length"> = [];

  if (!input.relevance.passed) {
    failedMetrics.push("relevance");
  }

  if (!input.tone.passed) {
    failedMetrics.push("tone");
  }

  if (!input.length.passed) {
    failedMetrics.push("length");
  }

  return {
    passed: failedMetrics.length === 0 && input.hard_failures.length === 0,
    score: roundScore(
      (input.relevance.score + input.tone.score + input.length.score) / 3
    ),
    failed_metrics: failedMetrics,
    hard_failures: input.hard_failures
  };
}

function buildCandidateLookup(
  dataset: DraftQualityDataset,
  candidates?: DraftQualityCandidateSet
): Map<string, DraftQualityCandidateDraft[]> {
  const draftsByCaseId = new Map<string, DraftQualityCandidateDraft[]>();
  const seenDraftKeys = new Set<string>();
  const knownCaseIds = new Set(dataset.cases.map((draftCase) => draftCase.id));

  for (const draftCase of dataset.cases) {
    const caseDrafts = [...draftCase.candidate_drafts];
    draftsByCaseId.set(draftCase.id, caseDrafts);
    for (const draft of caseDrafts) {
      seenDraftKeys.add(`${draftCase.id}::${draft.id}`);
    }
  }

  for (const externalDraft of candidates?.drafts ?? []) {
    if (!knownCaseIds.has(externalDraft.case_id)) {
      throw createInputError(
        `Candidates file references unknown case "${externalDraft.case_id}".`,
        {
          case_id: externalDraft.case_id,
          draft_id: externalDraft.id
        }
      );
    }

    const draftKey = `${externalDraft.case_id}::${externalDraft.id}`;
    if (seenDraftKeys.has(draftKey)) {
      throw createInputError(
        `Duplicate draft id "${externalDraft.id}" found for case "${externalDraft.case_id}" across dataset and candidates inputs.`,
        {
          case_id: externalDraft.case_id,
          draft_id: externalDraft.id
        }
      );
    }

    seenDraftKeys.add(draftKey);
    const caseDrafts = draftsByCaseId.get(externalDraft.case_id);
    if (!caseDrafts) {
      throw createInputError(
        `No case bucket found for external draft "${externalDraft.id}".`,
        {
          case_id: externalDraft.case_id,
          draft_id: externalDraft.id
        }
      );
    }

    caseDrafts.push({
      id: externalDraft.id,
      source: externalDraft.source,
      text: externalDraft.text,
      ...(externalDraft.label ? { label: externalDraft.label } : {}),
      ...(externalDraft.metadata ? { metadata: externalDraft.metadata } : {})
    });
  }

  return draftsByCaseId;
}

function createSourceCounts(): Record<DraftQualityDraftSource, number> {
  return {
    manual: 0,
    model: 0,
    imported: 0,
    synthetic: 0
  };
}

export async function evaluateDraftQuality(
  input: EvaluateDraftQualityInput
): Promise<DraftQualityReport> {
  const now = input.now ?? new Date();
  const runId = input.run_id ?? createRunId(now);
  const draftsByCaseId = buildCandidateLookup(input.dataset, input.candidates);
  const sourceCounts = createSourceCounts();
  const warnings: string[] = [];
  const caseResults: DraftQualityCaseResult[] = [];

  for (const draftCase of input.dataset.cases) {
    const drafts = draftsByCaseId.get(draftCase.id) ?? [];

    if (drafts.length === 0) {
      warnings.push(`Case ${draftCase.id} has no candidate drafts and was skipped.`);
      continue;
    }

    for (const draft of drafts) {
      sourceCounts[draft.source] += 1;

      const deterministic = evaluateDeterministicDraft(draftCase, draft);
      let relevance = deterministic.relevance;
      let tone = deterministic.tone;
      const length = deterministic.length;
      const notes = [...draftCase.expectations.manual_notes];

      if (input.judge) {
        const judgeResult = await input.judge.evaluate({
          draft_case: draftCase,
          draft,
          deterministic
        });
        relevance = mergeJudgeMetric(relevance, judgeResult.relevance);
        tone = mergeJudgeMetric(tone, judgeResult.tone);
        notes.push(...(judgeResult.notes ?? []));
      }

      caseResults.push({
        case_id: draftCase.id,
        draft_id: draft.id,
        draft_source: draft.source,
        overall: createOverallResult({
          relevance,
          tone,
          length,
          hard_failures: deterministic.hard_failures
        }),
        metrics: {
          relevance,
          tone,
          length
        },
        notes: uniqueStrings(notes),
        ...(draftCase.channel ? { case_channel: draftCase.channel } : {}),
        ...(draftCase.scenario ? { case_scenario: draftCase.scenario } : {}),
        ...(draft.label ? { draft_label: draft.label } : {})
      });
    }
  }

  if (caseResults.length === 0) {
    throw createInputError(
      "No candidate drafts were found. Provide embedded candidate_drafts or a separate candidates file.",
      {
        dataset_case_count: input.dataset.cases.length,
        candidates_supplied: Boolean(input.candidates)
      }
    );
  }

  const passedDrafts = caseResults.filter((result) => result.overall.passed).length;
  const failedDrafts = caseResults.length - passedDrafts;
  const totalMetricScores = caseResults.reduce(
    (totals, result) => {
      totals.relevance += result.metrics.relevance.score;
      totals.tone += result.metrics.tone.score;
      totals.length += result.metrics.length.score;
      return totals;
    },
    { relevance: 0, tone: 0, length: 0 }
  );

  return {
    run_id: runId,
    generated_at: now.toISOString(),
    outcome: failedDrafts === 0 ? "pass" : "fail",
    summary: {
      total_cases: input.dataset.cases.length,
      evaluated_case_count: input.dataset.cases.length - warnings.length,
      skipped_case_count: warnings.length,
      total_drafts: caseResults.length,
      passed_drafts: passedDrafts,
      failed_drafts: failedDrafts,
      pass_rate: roundScore(passedDrafts / caseResults.length),
      metric_averages: {
        relevance: roundScore(totalMetricScores.relevance / caseResults.length),
        tone: roundScore(totalMetricScores.tone / caseResults.length),
        length: roundScore(totalMetricScores.length / caseResults.length)
      },
      source_counts: sourceCounts
    },
    warnings,
    cases: caseResults,
    ...(input.dataset_path ? { dataset_path: input.dataset_path } : {}),
    ...(input.candidates_path ? { candidates_path: input.candidates_path } : {})
  };
}
