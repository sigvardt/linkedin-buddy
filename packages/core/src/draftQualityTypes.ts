export const DRAFT_QUALITY_SCHEMA_VERSION = 1 as const;

export const DRAFT_QUALITY_TONE_LABELS = [
  "warm",
  "professional",
  "friendly",
  "concise",
  "curious",
  "appreciative",
  "direct",
  "empathetic",
  "pushy",
  "robotic",
  "casual"
] as const;

export type DraftQualityToneLabel =
  (typeof DRAFT_QUALITY_TONE_LABELS)[number];

export const DRAFT_QUALITY_DRAFT_SOURCES = [
  "manual",
  "model",
  "imported",
  "synthetic"
] as const;

export type DraftQualityDraftSource =
  (typeof DRAFT_QUALITY_DRAFT_SOURCES)[number];

export type DraftQualityMetricMode = "deterministic" | "hybrid";

export type DraftQualityJsonValue =
  | string
  | number
  | boolean
  | null
  | DraftQualityJsonObject
  | DraftQualityJsonValue[];

export interface DraftQualityJsonObject {
  [key: string]: DraftQualityJsonValue;
}

export type DraftQualityParticipantRole = "assistant" | "contact" | "other";

export type DraftQualityMessageDirection = "inbound" | "outbound";

export interface DraftQualityParticipant {
  id: string;
  name: string;
  role?: DraftQualityParticipantRole;
}

export interface DraftQualityThreadMessage {
  id: string;
  author: string;
  direction: DraftQualityMessageDirection;
  text: string;
  participant_id?: string;
  created_at?: string;
}

export interface DraftQualityThread {
  participants: DraftQualityParticipant[];
  messages: DraftQualityThreadMessage[];
}

export interface DraftQualityRequiredPoint {
  id: string;
  aliases: string[];
  description?: string;
}

export interface DraftQualityToneExpectations {
  required: DraftQualityToneLabel[];
  optional: DraftQualityToneLabel[];
  forbidden: DraftQualityToneLabel[];
}

export interface DraftQualityLengthExpectations {
  min_words: number;
  max_words: number;
  target_words?: number;
  max_sentences?: number;
}

export interface DraftQualityExpectations {
  tone: DraftQualityToneExpectations;
  length: DraftQualityLengthExpectations;
  required_points: DraftQualityRequiredPoint[];
  forbidden_phrases: string[];
  manual_notes: string[];
}

export interface DraftQualityCandidateDraft {
  id: string;
  source: DraftQualityDraftSource;
  text: string;
  label?: string;
  metadata?: DraftQualityJsonObject;
}

export interface DraftQualityExternalCandidateDraft
  extends DraftQualityCandidateDraft {
  case_id: string;
}

export interface DraftQualityCase {
  id: string;
  thread: DraftQualityThread;
  expectations: DraftQualityExpectations;
  candidate_drafts: DraftQualityCandidateDraft[];
  channel?: string;
  scenario?: string;
  metadata?: DraftQualityJsonObject;
}

export interface DraftQualityDataset {
  schema_version: typeof DRAFT_QUALITY_SCHEMA_VERSION;
  cases: DraftQualityCase[];
  name?: string;
  metadata?: DraftQualityJsonObject;
}

export interface DraftQualityCandidateSet {
  schema_version: typeof DRAFT_QUALITY_SCHEMA_VERSION;
  drafts: DraftQualityExternalCandidateDraft[];
  metadata?: DraftQualityJsonObject;
}

export interface DraftQualityPointMatch {
  point_id: string;
  matched_aliases: string[];
}

export interface DraftQualityRelevanceDetails {
  total_required_points: number;
  covered_point_ids: string[];
  missing_point_ids: string[];
  point_matches: DraftQualityPointMatch[];
  off_topic_signals: string[];
  forbidden_phrase_hits: string[];
  judge_rationale: string[];
}

export interface DraftQualityToneEvidence {
  tone: DraftQualityToneLabel;
  signals: string[];
}

export interface DraftQualityToneDetails {
  required: DraftQualityToneLabel[];
  matched: DraftQualityToneLabel[];
  missing: DraftQualityToneLabel[];
  optional_matched: DraftQualityToneLabel[];
  forbidden_requested: DraftQualityToneLabel[];
  forbidden_triggered: DraftQualityToneLabel[];
  evidence: DraftQualityToneEvidence[];
  judge_rationale: string[];
}

export interface DraftQualityLengthDetails {
  word_count: number;
  sentence_count: number;
  min_words: number;
  max_words: number;
  target_words: number | null;
  max_sentences: number | null;
  distance_from_target: number | null;
}

export interface DraftQualityMetricResult<TDetails> {
  passed: boolean;
  score: number;
  mode: DraftQualityMetricMode;
  details: TDetails;
}

export interface DraftQualityHardFailure {
  kind: "forbidden_phrase";
  message: string;
  values: string[];
}

export interface DraftQualityOverallResult {
  passed: boolean;
  score: number;
  failed_metrics: Array<"relevance" | "tone" | "length">;
  hard_failures: DraftQualityHardFailure[];
}

export interface DraftQualityCaseResult {
  case_id: string;
  draft_id: string;
  draft_source: DraftQualityDraftSource;
  overall: DraftQualityOverallResult;
  metrics: {
    relevance: DraftQualityMetricResult<DraftQualityRelevanceDetails>;
    tone: DraftQualityMetricResult<DraftQualityToneDetails>;
    length: DraftQualityMetricResult<DraftQualityLengthDetails>;
  };
  notes: string[];
  case_channel?: string;
  case_scenario?: string;
  draft_label?: string;
}

export interface DraftQualityMetricAverages {
  relevance: number;
  tone: number;
  length: number;
}

export interface DraftQualityReportSummary {
  total_cases: number;
  evaluated_case_count: number;
  skipped_case_count: number;
  total_drafts: number;
  passed_drafts: number;
  failed_drafts: number;
  pass_rate: number;
  metric_averages: DraftQualityMetricAverages;
  source_counts: Record<DraftQualityDraftSource, number>;
}

export interface DraftQualityReport {
  run_id: string;
  generated_at: string;
  outcome: "pass" | "fail";
  summary: DraftQualityReportSummary;
  warnings: string[];
  cases: DraftQualityCaseResult[];
  dataset_path?: string;
  candidates_path?: string;
}

export interface DraftQualityJudgeMetricFeedback {
  passed?: boolean;
  score?: number;
  rationale?: string[];
}

export interface DraftQualityJudgeInput {
  draft_case: DraftQualityCase;
  draft: DraftQualityCandidateDraft;
  deterministic: {
    relevance: DraftQualityMetricResult<DraftQualityRelevanceDetails>;
    tone: DraftQualityMetricResult<DraftQualityToneDetails>;
    length: DraftQualityMetricResult<DraftQualityLengthDetails>;
    hard_failures: DraftQualityHardFailure[];
  };
}

export interface DraftQualityJudgeResult {
  relevance?: DraftQualityJudgeMetricFeedback;
  tone?: DraftQualityJudgeMetricFeedback;
  notes?: string[];
}

export interface DraftQualityJudge {
  evaluate(input: DraftQualityJudgeInput): Promise<DraftQualityJudgeResult>;
}

export interface EvaluateDraftQualityInput {
  dataset: DraftQualityDataset;
  candidates?: DraftQualityCandidateSet;
  judge?: DraftQualityJudge;
  now?: Date;
  run_id?: string;
  dataset_path?: string;
  candidates_path?: string;
}
