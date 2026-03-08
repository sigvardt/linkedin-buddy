import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LinkedInAssistantError,
  evaluateDraftQuality,
  parseDraftQualityCandidateSet,
  parseDraftQualityDataset,
  type DraftQualityJudge
} from "../src/index.js";

const FIXED_DATE = new Date("2026-03-08T12:00:00.000Z");

function readFixture(fileName: string): unknown {
  const fixtureUrl = new URL(`./fixtures/draft-quality/${fileName}`, import.meta.url);
  return JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown;
}

function createInlineDataset(): unknown {
  return {
    schemaVersion: 1,
    cases: [
      {
        id: "inline_case_001",
        channel: "linkedin_inbox",
        scenario: "Short warm acknowledgement",
        thread: {
          participants: [
            {
              id: "assistant",
              name: "You",
              role: "assistant"
            },
            {
              id: "contact",
              name: "Taylor",
              role: "contact"
            }
          ],
          messages: [
            {
              id: "m1",
              author: "Taylor",
              direction: "inbound",
              text: "Thanks for the context — could you follow up next week?"
            }
          ]
        },
        expectations: {
          tone: {
            required: ["warm"],
            forbidden: ["pushy"]
          },
          length: {
            minWords: 4,
            maxWords: 20,
            targetWords: 10
          },
          requiredPoints: [
            {
              id: "say_thanks",
              aliases: ["thanks", "thank you"]
            }
          ],
          manualNotes: ["This fixture uses camelCase input keys."]
        },
        candidateDrafts: [
          {
            id: "manual_ok",
            source: "manual",
            text: "Thanks again for the quick reply."
          }
        ]
      }
    ]
  };
}

describe("draft quality evaluator", () => {
  it("evaluates embedded and external drafts from the smoke fixtures", async () => {
    const dataset = parseDraftQualityDataset(readFixture("smoke-dataset.json"));
    const candidates = parseDraftQualityCandidateSet(readFixture("smoke-candidates.json"));

    const report = await evaluateDraftQuality({
      dataset,
      candidates,
      now: FIXED_DATE,
      run_id: "run_fixture",
      dataset_path: "fixtures/smoke-dataset.json",
      candidates_path: "fixtures/smoke-candidates.json"
    });

    expect(report.run_id).toBe("run_fixture");
    expect(report.summary.total_cases).toBe(2);
    expect(report.summary.evaluated_case_count).toBe(2);
    expect(report.summary.skipped_case_count).toBe(0);
    expect(report.summary.total_drafts).toBe(3);
    expect(report.summary.passed_drafts).toBe(2);
    expect(report.summary.failed_drafts).toBe(1);
    expect(report.summary.pass_rate).toBeCloseTo(0.667, 3);
    expect(report.summary.metric_averages.relevance).toBeCloseTo(0.833, 3);
    expect(report.summary.metric_averages.tone).toBeCloseTo(0.778, 3);
    expect(report.summary.metric_averages.length).toBeCloseTo(0.817, 3);
    expect(report.summary.source_counts.manual).toBe(1);
    expect(report.summary.source_counts.model).toBe(2);

    const baselineDraft = report.cases.find(
      (result) => result.case_id === "followup_meeting_request_001" && result.draft_id === "baseline_manual"
    );
    expect(baselineDraft?.overall.passed).toBe(true);

    const timelineDraft = report.cases.find(
      (result) => result.case_id === "timeline_clarification_001" && result.draft_id === "model_candidate"
    );
    expect(timelineDraft?.overall.passed).toBe(true);
    expect(timelineDraft?.metrics.tone.details.matched).toEqual(
      expect.arrayContaining(["professional", "direct"])
    );

    const failingDraft = report.cases.find(
      (result) => result.case_id === "followup_meeting_request_001" && result.draft_id === "too_pushy"
    );
    expect(failingDraft?.overall.passed).toBe(false);
    expect(failingDraft?.overall.failed_metrics).toEqual([
      "relevance",
      "tone",
      "length"
    ]);
    expect(failingDraft?.overall.hard_failures[0]?.kind).toBe("forbidden_phrase");
    expect(failingDraft?.overall.hard_failures[0]?.values).toEqual([
      "just circling back"
    ]);
    expect(failingDraft?.metrics.relevance.details.missing_point_ids).toEqual([
      "acknowledge_busyness"
    ]);
    expect(failingDraft?.metrics.tone.details.forbidden_triggered).toEqual(["pushy"]);
    expect(failingDraft?.metrics.length.passed).toBe(false);
  });

  it("parses camelCase dataset fields and carries manual notes into the report", async () => {
    const dataset = parseDraftQualityDataset(createInlineDataset());

    expect(dataset.cases[0]?.candidate_drafts).toHaveLength(1);
    expect(dataset.cases[0]?.expectations.length.min_words).toBe(4);

    const report = await evaluateDraftQuality({
      dataset,
      now: FIXED_DATE,
      run_id: "run_inline"
    });

    expect(report.summary.total_drafts).toBe(1);
    expect(report.cases[0]?.overall.passed).toBe(true);
    expect(report.cases[0]?.notes).toContain(
      "This fixture uses camelCase input keys."
    );
  });

  it("preserves deterministic failures even when a judge is optimistic", async () => {
    const dataset = parseDraftQualityDataset({
      schemaVersion: 1,
      cases: [
        {
          id: "judge_case_001",
          thread: {
            participants: [
              {
                id: "assistant",
                name: "You",
                role: "assistant"
              },
              {
                id: "contact",
                name: "Alex",
                role: "contact"
              }
            ],
            messages: [
              {
                id: "m1",
                author: "Alex",
                direction: "inbound",
                text: "Could you reconnect next week?"
              }
            ]
          },
          expectations: {
            tone: {
              required: ["warm"],
              forbidden: ["pushy"]
            },
            length: {
              minWords: 2,
              maxWords: 20,
              targetWords: 6
            },
            requiredPoints: [
              {
                id: "mention_next_week",
                aliases: ["next week"]
              }
            ]
          },
          candidateDrafts: [
            {
              id: "model_guess",
              source: "model",
              text: "Following up soon."
            }
          ]
        }
      ]
    });

    const judge: DraftQualityJudge = {
      evaluate: async () => ({
        relevance: {
          passed: true,
          score: 1,
          rationale: ["Judge thought the reply still addressed the schedule."]
        },
        tone: {
          passed: true,
          score: 1,
          rationale: ["Judge heard a friendly tone."]
        },
        notes: ["Judge note"]
      })
    };

    const report = await evaluateDraftQuality({
      dataset,
      judge,
      now: FIXED_DATE,
      run_id: "run_judge"
    });

    const result = report.cases[0];
    expect(result?.metrics.relevance.mode).toBe("hybrid");
    expect(result?.metrics.relevance.passed).toBe(false);
    expect(result?.metrics.relevance.details.judge_rationale).toContain(
      "Judge thought the reply still addressed the schedule."
    );
    expect(result?.metrics.tone.mode).toBe("hybrid");
    expect(result?.metrics.tone.passed).toBe(false);
    expect(result?.overall.passed).toBe(false);
    expect(result?.notes).toContain("Judge note");
  });

  it("rejects unsupported tone labels and duplicate external draft identifiers", () => {
    expect(() =>
      parseDraftQualityDataset({
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case",
            thread: {
              participants: [
                {
                  id: "assistant",
                  name: "You",
                  role: "assistant"
                }
              ],
              messages: [
                {
                  id: "m1",
                  author: "You",
                  direction: "outbound",
                  text: "Hello"
                }
              ]
            },
            expectations: {
              tone: {
                required: ["uplifting"]
              },
              length: {
                minWords: 1,
                maxWords: 10
              },
              requiredPoints: []
            },
            candidateDrafts: [
              {
                id: "draft_1",
                source: "manual",
                text: "Hello"
              }
            ]
          }
        ]
      })
    ).toThrowError(LinkedInAssistantError);

    expect(() =>
      parseDraftQualityCandidateSet({
        schema_version: 1,
        drafts: [
          {
            case_id: "case_1",
            id: "duplicate",
            source: "model",
            text: "One"
          },
          {
            case_id: "case_1",
            id: "duplicate",
            source: "model",
            text: "Two"
          }
        ]
      })
    ).toThrowError(LinkedInAssistantError);
  });
});
