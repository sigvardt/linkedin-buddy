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
  type DraftQualityEvaluationLimits,
  type DraftQualityEvaluationLogger,
  type DraftQualityExpectations,
  type DraftQualityFailedMetricCounts,
  type DraftQualityExternalCandidateDraft,
  type DraftQualityHardFailure,
  type DraftQualityJsonObject,
  type DraftQualityJsonValue,
  type DraftQualityJudgeMetricFeedback,
  type DraftQualityJudgeResult,
  type DraftQualityLengthDetails,
  type DraftQualityLengthExpectations,
  type DraftQualityMetricResult,
  type DraftQualityParticipant,
  type DraftQualityParticipantRole,
  type DraftQualityReport,
  type DraftQualityReportSummary,
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
const INVISIBLE_TEXT_PATTERN = /[\p{Cf}\s]+/gu;
const SENTENCE_SPLIT_PATTERN = /[.!?]+/;
const MAX_JSON_VALUE_DEPTH = 20;
const DEFAULT_DRAFT_QUALITY_MAX_CASES = 1_000;
const DEFAULT_DRAFT_QUALITY_MAX_DRAFTS = 5_000;
const DEFAULT_DRAFT_QUALITY_MAX_MESSAGE_CHARACTERS = 20_000;
const DEFAULT_DRAFT_QUALITY_MAX_DRAFT_CHARACTERS = 20_000;
const DEFAULT_DRAFT_QUALITY_MAX_TOTAL_TEXT_CHARACTERS = 2_000_000;
const DEFAULT_DRAFT_QUALITY_JUDGE_TIMEOUT_MS = 5_000;
const MAX_DRAFT_QUALITY_JUDGE_TIMEOUT_MS = 60_000;

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

interface ResolvedDraftQualityEvaluationLimits {
  max_cases: number;
  max_drafts: number;
  max_message_characters: number;
  max_draft_characters: number;
  max_total_text_characters: number;
  judge_timeout_ms: number;
}

interface EvaluateJudgeResult {
  judgeResult?: DraftQualityJudgeResult;
  warning?: string;
  failed: boolean;
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

function normalizeUnicodeText(value: string): string {
  try {
    return value.normalize("NFKC");
  } catch {
    return value;
  }
}

function hasVisibleText(value: string): boolean {
  return normalizeUnicodeText(value).replace(INVISIBLE_TEXT_PATTERN, "").length > 0;
}

function logEvaluationEvent(
  logger: DraftQualityEvaluationLogger | undefined,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown>
): void {
  if (!logger) {
    return;
  }

  try {
    logger.log(level, event, payload);
  } catch {
    // Logging must never break evaluation.
  }
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

function readOptionalBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
  location: string
): boolean | undefined {
  const value = readValue(record, keys);
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw createInputError(`Expected ${location}.${keys[0]} to be a boolean.`, {
      location,
      field: keys[0]
    });
  }

  return value;
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

function parseJsonValue(
  value: unknown,
  location: string,
  depth: number = 0
): DraftQualityJsonValue {
  if (depth > MAX_JSON_VALUE_DEPTH) {
    throw createInputError(`Expected ${location} to stay within metadata depth limits.`, {
      location,
      max_depth: MAX_JSON_VALUE_DEPTH
    });
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => parseJsonValue(item, `${location}[${index}]`, depth + 1));
  }

  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be JSON-serializable.`, {
      location
    });
  }

  const parsed: DraftQualityJsonObject = {};
  for (const [key, entry] of Object.entries(record)) {
    parsed[key] = parseJsonValue(entry, `${location}.${key}`, depth + 1);
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

    if (!hasVisibleText(trimmed)) {
      throw createInputError(`Expected ${location}[${index}] to include visible text.`, {
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
  if (!hasVisibleText(text)) {
    throw createInputError(`Expected ${location}.text to include visible text.`, {
      location,
      field: "text"
    });
  }
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

function assertUniqueParticipantIds(
  participants: DraftQualityParticipant[],
  location: string
): void {
  const seen = new Set<string>();

  for (const participant of participants) {
    if (seen.has(participant.id)) {
      throw createInputError(
        `Duplicate participant id "${participant.id}" found in ${location}.participants.`,
        {
          location,
          participant_id: participant.id
        }
      );
    }

    seen.add(participant.id);
  }
}

function assertUniqueMessageIds(messages: DraftQualityThreadMessage[], location: string): void {
  const seen = new Set<string>();

  for (const message of messages) {
    if (seen.has(message.id)) {
      throw createInputError(
        `Duplicate message id "${message.id}" found in ${location}.messages.`,
        {
          location,
          message_id: message.id
        }
      );
    }

    seen.add(message.id);
  }
}

function assertKnownParticipantReferences(
  participants: DraftQualityParticipant[],
  messages: DraftQualityThreadMessage[],
  location: string
): void {
  const participantIds = new Set(participants.map((participant) => participant.id));

  for (const message of messages) {
    if (message.participant_id && !participantIds.has(message.participant_id)) {
      throw createInputError(
        `Message "${message.id}" references unknown participant id "${message.participant_id}".`,
        {
          location,
          message_id: message.id,
          participant_id: message.participant_id
        }
      );
    }
  }
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

  assertUniqueParticipantIds(participants, location);
  assertUniqueMessageIds(messages, location);
  assertKnownParticipantReferences(participants, messages, location);

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

  return parseCandidateDraftRecord(record, location);
}

function parseCandidateDraftRecord(
  record: Record<string, unknown>,
  location: string
): DraftQualityCandidateDraft {
  const id = readRequiredString(record, ["id"], location);
  const source = parseDraftSource(
    readRequiredString(record, ["source"], location),
    `${location}.source`
  );
  const textValue = readValue(record, ["text"]);
  if (textValue === undefined) {
    throw createInputError(`Missing required field ${location}.text.`, {
      location,
      field: "text"
    });
  }

  if (typeof textValue !== "string") {
    throw createInputError(`Expected ${location}.text to be a string.`, {
      location,
      field: "text"
    });
  }

  const text = textValue;
  if (text.length > 0 && !hasVisibleText(text)) {
    throw createInputError(`Expected ${location}.text to include visible text.`, {
      location,
      field: "text"
    });
  }
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
  const draft = parseCandidateDraftRecord(record, location);

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

function addSeenDraftId(
  seenDraftIds: Map<string, Set<string>>,
  caseId: string,
  draftId: string,
  onDuplicate: () => never
): void {
  const draftIds = seenDraftIds.get(caseId);
  if (draftIds?.has(draftId)) {
    onDuplicate();
  }

  if (draftIds) {
    draftIds.add(draftId);
    return;
  }

  seenDraftIds.set(caseId, new Set([draftId]));
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

  const seenDraftIds = new Map<string, Set<string>>();
  for (const draft of drafts) {
    addSeenDraftId(seenDraftIds, draft.case_id, draft.id, () => {
      throw createInputError(
        `Duplicate draft id "${draft.id}" found for case "${draft.case_id}" in candidates file.`,
        {
          case_id: draft.case_id,
          draft_id: draft.id
        }
      );
    });
  }

  return {
    schema_version: schemaVersion,
    drafts,
    ...(metadata ? { metadata } : {})
  };
}

function normalizeText(value: string): string {
  return normalizeUnicodeText(value)
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
  draftTokens: ReadonlySet<string>,
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
  const draftTokens = new Set(tokenizeText(draftText));
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
        draftTokens,
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

function resolveEvaluationLimits(
  limits: DraftQualityEvaluationLimits | undefined
): ResolvedDraftQualityEvaluationLimits {
  const parseLimit = (
    value: number | undefined,
    field: keyof ResolvedDraftQualityEvaluationLimits,
    defaultValue: number,
    minimum: number,
    maximum?: number
  ): number => {
    if (value === undefined) {
      return defaultValue;
    }

    const location = `evaluate.limits.${field}`;
    if (!Number.isInteger(value) || value < minimum) {
      throw createInputError(
        `Expected ${location} to be an integer greater than or equal to ${minimum}.`,
        {
          location,
          field,
          minimum
        }
      );
    }

    const parsed = value;
    if (maximum !== undefined && parsed > maximum) {
      throw createInputError(
        `Expected ${location} to be less than or equal to ${maximum}.`,
        {
          location,
          field,
          maximum
        }
      );
    }

    return parsed;
  };

  return {
    max_cases: parseLimit(
      limits?.max_cases,
      "max_cases",
      DEFAULT_DRAFT_QUALITY_MAX_CASES,
      1
    ),
    max_drafts: parseLimit(
      limits?.max_drafts,
      "max_drafts",
      DEFAULT_DRAFT_QUALITY_MAX_DRAFTS,
      1
    ),
    max_message_characters: parseLimit(
      limits?.max_message_characters,
      "max_message_characters",
      DEFAULT_DRAFT_QUALITY_MAX_MESSAGE_CHARACTERS,
      1
    ),
    max_draft_characters: parseLimit(
      limits?.max_draft_characters,
      "max_draft_characters",
      DEFAULT_DRAFT_QUALITY_MAX_DRAFT_CHARACTERS,
      1
    ),
    max_total_text_characters: parseLimit(
      limits?.max_total_text_characters,
      "max_total_text_characters",
      DEFAULT_DRAFT_QUALITY_MAX_TOTAL_TEXT_CHARACTERS,
      1
    ),
    judge_timeout_ms: parseLimit(
      limits?.judge_timeout_ms,
      "judge_timeout_ms",
      DEFAULT_DRAFT_QUALITY_JUDGE_TIMEOUT_MS,
      0,
      MAX_DRAFT_QUALITY_JUDGE_TIMEOUT_MS
    )
  };
}

function validateResourceLimits(
  dataset: DraftQualityDataset,
  candidates: DraftQualityCandidateSet | undefined,
  limits: ResolvedDraftQualityEvaluationLimits
): void {
  if (dataset.cases.length > limits.max_cases) {
    throw createInputError(
      `Draft-quality dataset includes ${dataset.cases.length} cases, which exceeds the limit of ${limits.max_cases}.`,
      {
        location: "dataset.cases",
        case_count: dataset.cases.length,
        limit: limits.max_cases
      }
    );
  }

  let totalDraftCount = 0;
  let totalTextCharacters = 0;

  for (const draftCase of dataset.cases) {
    for (const message of draftCase.thread.messages) {
      totalTextCharacters += message.text.length;
      if (message.text.length > limits.max_message_characters) {
        throw createInputError(
          `Message "${message.id}" in case "${draftCase.id}" exceeds the configured character limit.`,
          {
            case_id: draftCase.id,
            message_id: message.id,
            character_count: message.text.length,
            limit: limits.max_message_characters
          }
        );
      }
    }

    for (const draft of draftCase.candidate_drafts) {
      totalDraftCount += 1;
      totalTextCharacters += draft.text.length;
      if (draft.text.length > limits.max_draft_characters) {
        throw createInputError(
          `Draft "${draft.id}" in case "${draftCase.id}" exceeds the configured character limit.`,
          {
            case_id: draftCase.id,
            draft_id: draft.id,
            character_count: draft.text.length,
            limit: limits.max_draft_characters
          }
        );
      }
    }
  }

  for (const draft of candidates?.drafts ?? []) {
    totalDraftCount += 1;
    totalTextCharacters += draft.text.length;
    if (draft.text.length > limits.max_draft_characters) {
      throw createInputError(
        `Draft "${draft.id}" in case "${draft.case_id}" exceeds the configured character limit.`,
        {
          case_id: draft.case_id,
          draft_id: draft.id,
          character_count: draft.text.length,
          limit: limits.max_draft_characters
        }
      );
    }
  }

  if (totalDraftCount > limits.max_drafts) {
    throw createInputError(
      `Draft-quality evaluation includes ${totalDraftCount} drafts, which exceeds the limit of ${limits.max_drafts}.`,
      {
        draft_count: totalDraftCount,
        limit: limits.max_drafts
      }
    );
  }

  if (totalTextCharacters > limits.max_total_text_characters) {
    throw createInputError(
      `Draft-quality evaluation includes ${totalTextCharacters} text characters, which exceeds the limit of ${limits.max_total_text_characters}.`,
      {
        total_text_characters: totalTextCharacters,
        limit: limits.max_total_text_characters
      }
    );
  }
}

function parseJudgeMetricFeedback(
  value: unknown,
  location: string
): DraftQualityJudgeMetricFeedback {
  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const passed = readOptionalBoolean(record, ["passed"], location);
  const score = readOptionalNumber(record, ["score"], location);
  const rationaleValues = readOptionalArray(record, ["rationale"], location);
  const rationale = rationaleValues
    ? parseStringList(rationaleValues, `${location}.rationale`)
    : undefined;

  return {
    ...(passed === undefined ? {} : { passed }),
    ...(score === undefined ? {} : { score }),
    ...(rationale ? { rationale } : {})
  };
}

function parseJudgeResult(value: unknown, location: string): DraftQualityJudgeResult {
  if (value === undefined || value === null) {
    return {};
  }

  const record = asRecord(value);
  if (!record) {
    throw createInputError(`Expected ${location} to be an object.`, { location });
  }

  const relevanceValue = readValue(record, ["relevance"]);
  const toneValue = readValue(record, ["tone"]);
  const notesValue = readOptionalArray(record, ["notes"], location);

  return {
    ...(relevanceValue === undefined
      ? {}
      : { relevance: parseJudgeMetricFeedback(relevanceValue, `${location}.relevance`) }),
    ...(toneValue === undefined
      ? {}
      : { tone: parseJudgeMetricFeedback(toneValue, `${location}.tone`) }),
    ...(notesValue ? { notes: parseStringList(notesValue, `${location}.notes`) } : {})
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => LinkedInAssistantError
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function buildCandidateLookup(
  dataset: DraftQualityDataset,
  candidates?: DraftQualityCandidateSet
): Map<string, DraftQualityCandidateDraft[]> {
  const draftsByCaseId = new Map<string, DraftQualityCandidateDraft[]>(
    dataset.cases.map((draftCase) => [draftCase.id, [...draftCase.candidate_drafts]])
  );
  const seenDraftIds = new Map<string, Set<string>>();

  for (const draftCase of dataset.cases) {
    for (const draft of draftCase.candidate_drafts) {
      addSeenDraftId(seenDraftIds, draftCase.id, draft.id, () => {
        throw createInputError(
          `Duplicate draft id "${draft.id}" found for case "${draftCase.id}" across dataset and candidates inputs.`,
          {
            case_id: draftCase.id,
            draft_id: draft.id
          }
        );
      });
    }
  }

  for (const externalDraft of candidates?.drafts ?? []) {
    const { case_id: caseId, ...draft } = externalDraft;
    const caseDrafts = draftsByCaseId.get(caseId);
    if (!caseDrafts) {
      throw createInputError(
        `Candidates file references unknown case "${caseId}".`,
        {
          case_id: caseId,
          draft_id: draft.id
        }
      );
    }

    addSeenDraftId(seenDraftIds, caseId, draft.id, () => {
      throw createInputError(
        `Duplicate draft id "${draft.id}" found for case "${caseId}" across dataset and candidates inputs.`,
        {
          case_id: caseId,
          draft_id: draft.id
        }
      );
    });
    caseDrafts.push(draft);
  }

  return draftsByCaseId;
}

function createSourceCounts(): Record<DraftQualityDraftSource, number> {
  return Object.fromEntries(
    DRAFT_QUALITY_DRAFT_SOURCES.map((source) => [source, 0])
  ) as Record<DraftQualityDraftSource, number>;
}

async function evaluateDraftCaseResult(input: {
  draftCase: DraftQualityCase;
  draft: DraftQualityCandidateDraft;
  judge?: EvaluateDraftQualityInput["judge"];
  judgeTimeoutMs: number;
  logger: DraftQualityEvaluationLogger | undefined;
}): Promise<{ result: DraftQualityCaseResult; warning?: string; judgeFailed: boolean }> {
  const deterministic = evaluateDeterministicDraft(input.draftCase, input.draft);
  let relevance = deterministic.relevance;
  let tone = deterministic.tone;
  const length = deterministic.length;
  const notes = [...input.draftCase.expectations.manual_notes];
  let warning: string | undefined;
  let judgeFailed = false;

  const judge = input.judge;

  if (judge) {
    logEvaluationEvent(input.logger, "debug", "draft_quality.judge.start", {
      case_id: input.draftCase.id,
      draft_id: input.draft.id,
      timeout_ms: input.judgeTimeoutMs
    });

    const judgePromise = Promise.resolve().then(() =>
      judge.evaluate(
        structuredClone({
          draft_case: input.draftCase,
          draft: input.draft,
          deterministic
        })
      )
    );

    let evaluatedJudge: EvaluateJudgeResult;

    try {
      const judgeResult = parseJudgeResult(
        await withTimeout(judgePromise, input.judgeTimeoutMs, () =>
          new LinkedInAssistantError(
            "TIMEOUT",
            `Draft-quality judge timed out after ${input.judgeTimeoutMs}ms.`,
            {
              case_id: input.draftCase.id,
              draft_id: input.draft.id,
              timeout_ms: input.judgeTimeoutMs
            }
          )
        ),
        `judge_result.${input.draftCase.id}.${input.draft.id}`
      );

      evaluatedJudge = {
        judgeResult,
        failed: false
      };

      logEvaluationEvent(input.logger, "debug", "draft_quality.judge.complete", {
        case_id: input.draftCase.id,
        draft_id: input.draft.id,
        has_relevance_feedback: Boolean(judgeResult.relevance),
        has_tone_feedback: Boolean(judgeResult.tone),
        note_count: judgeResult.notes?.length ?? 0
      });
    } catch (error) {
      judgeFailed = true;
      const normalizedError =
        error instanceof LinkedInAssistantError
          ? error
          : new LinkedInAssistantError(
              "UNKNOWN",
              `Draft-quality judge failed for ${input.draftCase.id}/${input.draft.id}.`,
              {
                case_id: input.draftCase.id,
                draft_id: input.draft.id,
                cause: error instanceof Error ? error.message : String(error)
              },
              error instanceof Error ? { cause: error } : undefined
            );

      warning = `Judge fallback for ${input.draftCase.id}/${input.draft.id}: ${normalizedError.message} Deterministic scores were kept.`;
      notes.push("Judge fallback: deterministic scores were kept.");

      logEvaluationEvent(
        input.logger,
        normalizedError.code === "TIMEOUT" ? "warn" : "error",
        normalizedError.code === "TIMEOUT"
          ? "draft_quality.judge.timeout"
          : "draft_quality.judge.failed",
        {
          case_id: input.draftCase.id,
          draft_id: input.draft.id,
          error_code: normalizedError.code,
          message: normalizedError.message,
          ...normalizedError.details
        }
      );

      evaluatedJudge = {
        failed: true,
        warning
      };
    }

    if (evaluatedJudge.judgeResult) {
      relevance = mergeJudgeMetric(relevance, evaluatedJudge.judgeResult.relevance);
      tone = mergeJudgeMetric(tone, evaluatedJudge.judgeResult.tone);
      notes.push(...(evaluatedJudge.judgeResult.notes ?? []));
    }
  }

  return {
    result: {
      case_id: input.draftCase.id,
      draft_id: input.draft.id,
      draft_source: input.draft.source,
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
      ...(input.draftCase.channel ? { case_channel: input.draftCase.channel } : {}),
      ...(input.draftCase.scenario ? { case_scenario: input.draftCase.scenario } : {}),
      ...(input.draft.label ? { draft_label: input.draft.label } : {})
    },
    ...(warning ? { warning } : {}),
    judgeFailed
  };
}

function createReportSummary(input: {
  totalCases: number;
  skippedCaseCount: number;
  caseResults: DraftQualityCaseResult[];
  sourceCounts: Record<DraftQualityDraftSource, number>;
  judgeFailureCount: number;
  warningCount: number;
}): DraftQualityReportSummary {
  const totalDrafts = input.caseResults.length;
  const passedDrafts = input.caseResults.filter((result) => result.overall.passed).length;
  const failedDrafts = totalDrafts - passedDrafts;
  const totalMetricScores = input.caseResults.reduce(
    (totals, result) => {
      totals.relevance += result.metrics.relevance.score;
      totals.tone += result.metrics.tone.score;
      totals.length += result.metrics.length.score;
      return totals;
    },
    { relevance: 0, tone: 0, length: 0 }
  );
  const failedMetricCounts = input.caseResults.reduce<DraftQualityFailedMetricCounts>(
    (totals, result) => {
      if (!result.metrics.relevance.passed) {
        totals.relevance += 1;
      }
      if (!result.metrics.tone.passed) {
        totals.tone += 1;
      }
      if (!result.metrics.length.passed) {
        totals.length += 1;
      }
      return totals;
    },
    { relevance: 0, tone: 0, length: 0 }
  );
  const hardFailureCount = input.caseResults.reduce(
    (total, result) => total + result.overall.hard_failures.length,
    0
  );

  return {
    total_cases: input.totalCases,
    evaluated_case_count: input.totalCases - input.skippedCaseCount,
    skipped_case_count: input.skippedCaseCount,
    total_drafts: totalDrafts,
    passed_drafts: passedDrafts,
    failed_drafts: failedDrafts,
    pass_rate: totalDrafts === 0 ? 0 : roundScore(passedDrafts / totalDrafts),
    metric_averages: {
      relevance: totalDrafts === 0 ? 0 : roundScore(totalMetricScores.relevance / totalDrafts),
      tone: totalDrafts === 0 ? 0 : roundScore(totalMetricScores.tone / totalDrafts),
      length: totalDrafts === 0 ? 0 : roundScore(totalMetricScores.length / totalDrafts)
    },
    failed_metric_counts: failedMetricCounts,
    hard_failure_count: hardFailureCount,
    judge_failure_count: input.judgeFailureCount,
    warning_count: input.warningCount,
    source_counts: input.sourceCounts
  };
}

export async function evaluateDraftQuality(
  input: EvaluateDraftQualityInput
): Promise<DraftQualityReport> {
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw createInputError("Expected evaluate.now to be a valid Date.", {
      location: "evaluate.now"
    });
  }

  const runId = input.run_id === undefined ? createRunId(now) : input.run_id.trim();
  if (runId.length === 0) {
    throw createInputError("Expected evaluate.run_id to be non-empty when provided.", {
      location: "evaluate.run_id"
    });
  }

  try {
    const dataset = parseDraftQualityDataset(input.dataset);
    const candidates = input.candidates
      ? parseDraftQualityCandidateSet(input.candidates)
      : undefined;
    const limits = resolveEvaluationLimits(input.limits);
    validateResourceLimits(dataset, candidates, limits);

    const draftsByCaseId = buildCandidateLookup(dataset, candidates);
    const totalDraftCount = Array.from(draftsByCaseId.values()).reduce(
      (total, drafts) => total + drafts.length,
      0
    );

    logEvaluationEvent(input.logger, "info", "draft_quality.evaluate.start", {
      run_id: runId,
      total_cases: dataset.cases.length,
      candidate_draft_count: totalDraftCount,
      embedded_draft_count: dataset.cases.reduce(
        (total, draftCase) => total + draftCase.candidate_drafts.length,
        0
      ),
      external_draft_count: candidates?.drafts.length ?? 0,
      judge_enabled: Boolean(input.judge)
    });

    const sourceCounts = createSourceCounts();
    const warnings: string[] = [];
    const caseResults: DraftQualityCaseResult[] = [];
    let skippedCaseCount = 0;
    let judgeFailureCount = 0;

    for (const [caseOffset, draftCase] of dataset.cases.entries()) {
      const drafts = draftsByCaseId.get(draftCase.id) ?? [];
      const caseIndex = caseOffset + 1;

      if (drafts.length === 0) {
        skippedCaseCount += 1;
        const warning = `Case ${draftCase.id} has no candidate drafts and was skipped.`;
        warnings.push(warning);
        logEvaluationEvent(input.logger, "warn", "draft_quality.case.skipped", {
          run_id: runId,
          case_id: draftCase.id,
          case_index: caseIndex,
          total_cases: dataset.cases.length,
          reason: "no_candidate_drafts"
        });
        continue;
      }

      logEvaluationEvent(input.logger, "info", "draft_quality.case.start", {
        run_id: runId,
        case_id: draftCase.id,
        case_index: caseIndex,
        total_cases: dataset.cases.length,
        draft_count: drafts.length
      });

      let casePassedDrafts = 0;
      let caseFailedDrafts = 0;

      for (const draft of drafts) {
        sourceCounts[draft.source] += 1;

        const evaluation = await evaluateDraftCaseResult({
          draftCase,
          draft,
          judge: input.judge,
          judgeTimeoutMs: limits.judge_timeout_ms,
          logger: input.logger
        });
        caseResults.push(evaluation.result);

        if (evaluation.result.overall.passed) {
          casePassedDrafts += 1;
        } else {
          caseFailedDrafts += 1;
        }

        if (evaluation.warning) {
          warnings.push(evaluation.warning);
        }

        if (evaluation.judgeFailed) {
          judgeFailureCount += 1;
        }
      }

      logEvaluationEvent(input.logger, "info", "draft_quality.case.done", {
        run_id: runId,
        case_id: draftCase.id,
        case_index: caseIndex,
        total_cases: dataset.cases.length,
        draft_count: drafts.length,
        passed_drafts: casePassedDrafts,
        failed_drafts: caseFailedDrafts
      });
    }

    if (caseResults.length === 0) {
      throw createInputError(
        "No candidate drafts were found. Provide embedded candidate_drafts or a separate candidates file.",
        {
          dataset_case_count: dataset.cases.length,
          candidates_supplied: Boolean(candidates)
        }
      );
    }

    const summary = createReportSummary({
      totalCases: dataset.cases.length,
      skippedCaseCount,
      caseResults,
      sourceCounts,
      judgeFailureCount,
      warningCount: warnings.length
    });

    const report = {
      run_id: runId,
      generated_at: now.toISOString(),
      outcome: summary.failed_drafts === 0 ? "pass" : "fail",
      summary,
      warnings,
      cases: caseResults,
      ...(input.dataset_path ? { dataset_path: input.dataset_path } : {}),
      ...(input.candidates_path ? { candidates_path: input.candidates_path } : {})
    } satisfies DraftQualityReport;

    logEvaluationEvent(input.logger, "info", "draft_quality.evaluate.complete", {
      run_id: runId,
      outcome: report.outcome,
      total_drafts: report.summary.total_drafts,
      failed_drafts: report.summary.failed_drafts,
      warning_count: report.summary.warning_count,
      judge_failure_count: report.summary.judge_failure_count
    });

    return report;
  } catch (error) {
    const normalizedError =
      error instanceof LinkedInAssistantError
        ? error
        : new LinkedInAssistantError(
            "UNKNOWN",
            "Draft-quality evaluation failed.",
            {
              cause: error instanceof Error ? error.message : String(error)
            },
            error instanceof Error ? { cause: error } : undefined
          );

    logEvaluationEvent(input.logger, "error", "draft_quality.evaluate.failed", {
      run_id: runId,
      error_code: normalizedError.code,
      message: normalizedError.message,
      ...normalizedError.details
    });

    throw error;
  }
}
