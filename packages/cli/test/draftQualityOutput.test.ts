import { describe, expect, it } from "vitest";
import type { DraftQualityReport, LinkedInAssistantErrorPayload } from "@linkedin-assistant/core";
import {
  formatDraftQualityError,
  formatDraftQualityReport,
  resolveDraftQualityOutputMode
} from "../src/draftQualityOutput.js";

function createDraftQualityReportFixture(): DraftQualityReport {
  return {
    run_id: "run_dq_test",
    generated_at: "2026-03-08T12:00:00.000Z",
    outcome: "fail",
    dataset_path: "packages/core/test/fixtures/draft-quality/smoke-dataset.json",
    candidates_path: "packages/core/test/fixtures/draft-quality/smoke-candidates.json",
    summary: {
      total_cases: 2,
      evaluated_case_count: 2,
      skipped_case_count: 0,
      total_drafts: 2,
      passed_drafts: 1,
      failed_drafts: 1,
      pass_rate: 0.5,
      metric_averages: {
        relevance: 0.75,
        tone: 0.833,
        length: 1
      },
      source_counts: {
        manual: 1,
        model: 1,
        imported: 0,
        synthetic: 0
      }
    },
    warnings: ["Case skipped_case_001 has no candidate drafts and was skipped."],
    cases: [
      {
        case_id: "followup_meeting_request_001",
        draft_id: "baseline_manual",
        draft_source: "manual",
        overall: {
          passed: true,
          score: 1,
          failed_metrics: [],
          hard_failures: []
        },
        metrics: {
          relevance: {
            passed: true,
            score: 1,
            mode: "deterministic",
            details: {
              total_required_points: 2,
              covered_point_ids: ["acknowledge_busyness", "propose_next_week"],
              missing_point_ids: [],
              point_matches: [
                {
                  point_id: "acknowledge_busyness",
                  matched_aliases: ["packed"]
                },
                {
                  point_id: "propose_next_week",
                  matched_aliases: ["next week"]
                }
              ],
              off_topic_signals: [],
              forbidden_phrase_hits: [],
              judge_rationale: []
            }
          },
          tone: {
            passed: true,
            score: 1,
            mode: "deterministic",
            details: {
              required: ["warm", "professional", "concise"],
              matched: ["warm", "professional", "concise"],
              missing: [],
              optional_matched: [],
              forbidden_requested: ["pushy", "robotic"],
              forbidden_triggered: [],
              evidence: [
                {
                  tone: "warm",
                  signals: ["thanks"]
                }
              ],
              judge_rationale: []
            }
          },
          length: {
            passed: true,
            score: 1,
            mode: "deterministic",
            details: {
              word_count: 24,
              sentence_count: 2,
              min_words: 20,
              max_words: 50,
              target_words: 35,
              max_sentences: 2,
              distance_from_target: 11
            }
          }
        },
        notes: ["Synthetic calibration baseline."],
        case_channel: "linkedin_inbox",
        case_scenario: "Warm follow-up when the contact is busy this week"
      },
      {
        case_id: "followup_meeting_request_001",
        draft_id: "too_pushy",
        draft_source: "model",
        overall: {
          passed: false,
          score: 0.561,
          failed_metrics: ["relevance", "tone"],
          hard_failures: [
            {
              kind: "forbidden_phrase",
              message: "Draft used forbidden phrases: just circling back",
              values: ["just circling back"]
            }
          ]
        },
        metrics: {
          relevance: {
            passed: false,
            score: 0.5,
            mode: "deterministic",
            details: {
              total_required_points: 2,
              covered_point_ids: ["propose_next_week"],
              missing_point_ids: ["acknowledge_busyness"],
              point_matches: [
                {
                  point_id: "acknowledge_busyness",
                  matched_aliases: []
                },
                {
                  point_id: "propose_next_week",
                  matched_aliases: ["next week"]
                }
              ],
              off_topic_signals: ["Draft missed every required point for the active thread."],
              forbidden_phrase_hits: ["just circling back"],
              judge_rationale: []
            }
          },
          tone: {
            passed: false,
            score: 0.667,
            mode: "deterministic",
            details: {
              required: ["warm", "professional", "concise"],
              matched: ["concise"],
              missing: ["warm", "professional"],
              optional_matched: [],
              forbidden_requested: ["pushy", "robotic"],
              forbidden_triggered: ["pushy"],
              evidence: [
                {
                  tone: "pushy",
                  signals: ["just circling back", "repeated exclamation marks"]
                }
              ],
              judge_rationale: []
            }
          },
          length: {
            passed: true,
            score: 1,
            mode: "deterministic",
            details: {
              word_count: 21,
              sentence_count: 2,
              min_words: 20,
              max_words: 50,
              target_words: 35,
              max_sentences: 2,
              distance_from_target: 14
            }
          }
        },
        notes: ["Keep the reply low-pressure and kind."],
        case_channel: "linkedin_inbox",
        case_scenario: "Warm follow-up when the contact is busy this week"
      }
    ]
  };
}

describe("draft quality output helpers", () => {
  it("defaults to human output in interactive terminals unless JSON is forced", () => {
    expect(resolveDraftQualityOutputMode({ json: false }, true)).toBe("human");
    expect(resolveDraftQualityOutputMode({ json: false }, false)).toBe("json");
    expect(resolveDraftQualityOutputMode({ json: true }, true)).toBe("json");
  });

  it("renders a scannable human-readable report", () => {
    const output = formatDraftQualityReport(createDraftQualityReportFixture());

    expect(output).toContain("Draft Quality Evaluation: FAIL");
    expect(output).toContain(
      "Summary: Evaluated 2 drafts across 2/2 cases. 1 passed. 1 failed. Pass rate 50.0%."
    );
    expect(output).toContain(
      "Metric Averages: relevance 75.0% | tone 83.3% | length 100.0%"
    );
    expect(output).toContain("Warnings");
    expect(output).toContain("Failures");
    expect(output).toContain("Hard checks: Draft used forbidden phrases: just circling back");
  });

  it("adds per-draft detail in verbose mode", () => {
    const output = formatDraftQualityReport(createDraftQualityReportFixture(), {
      verbose: true
    });

    expect(output).toContain("Draft Details");
    expect(output).toContain(
      "PASS followup_meeting_request_001/baseline_manual (manual)"
    );
    expect(output).toContain(
      "FAIL followup_meeting_request_001/too_pushy (model)"
    );
    expect(output).toContain("Tone: FAIL matched concise");
  });

  it("formats friendly human-readable errors", () => {
    const error: LinkedInAssistantErrorPayload = {
      code: "ACTION_PRECONDITION_FAILED",
      message: "Draft-quality dataset must contain at least one case.",
      details: {
        location: "dataset.cases"
      }
    };

    const output = formatDraftQualityError(error);

    expect(output).toContain(
      "Draft quality evaluation failed: Draft-quality dataset must contain at least one case."
    );
    expect(output).toContain("Location: dataset.cases");
  });
});
