import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LinkedInAssistantError,
  evaluateDraftQuality,
  parseDraftQualityCandidateSet,
  parseDraftQualityDataset,
  type DraftQualityDataset,
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

  it("tracks skipped cases separately from warning messages", async () => {
    const dataset = parseDraftQualityDataset({
      schemaVersion: 1,
      cases: [
        {
          id: "skipped_case_001",
          thread: {
            participants: [
              {
                id: "assistant",
                name: "You",
                role: "assistant"
              },
              {
                id: "contact",
                name: "Jordan",
                role: "contact"
              }
            ],
            messages: [
              {
                id: "m1",
                author: "Jordan",
                direction: "inbound",
                text: "Could you send a short note?"
              }
            ]
          },
          expectations: {
            tone: {
              required: [],
              forbidden: []
            },
            length: {
              minWords: 1,
              maxWords: 10
            },
            requiredPoints: []
          },
          candidateDrafts: []
        },
        {
          id: "evaluated_case_001",
          thread: {
            participants: [
              {
                id: "assistant",
                name: "You",
                role: "assistant"
              },
              {
                id: "contact",
                name: "Jordan",
                role: "contact"
              }
            ],
            messages: [
              {
                id: "m1",
                author: "Jordan",
                direction: "inbound",
                text: "Could you send a short note?"
              }
            ]
          },
          expectations: {
            tone: {
              required: [],
              forbidden: []
            },
            length: {
              minWords: 1,
              maxWords: 10
            },
            requiredPoints: []
          },
          candidateDrafts: [
            {
              id: "manual_ok",
              source: "manual",
              text: "Absolutely."
            }
          ]
        }
      ]
    });

    const report = await evaluateDraftQuality({
      dataset,
      now: FIXED_DATE,
      run_id: "run_skipped"
    });

    expect(report.summary.total_cases).toBe(2);
    expect(report.summary.evaluated_case_count).toBe(1);
    expect(report.summary.skipped_case_count).toBe(1);
    expect(report.summary.total_drafts).toBe(1);
    expect(report.warnings).toEqual([
      "Case skipped_case_001 has no candidate drafts and was skipped."
    ]);
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

  it("falls back to deterministic scores when judge feedback is malformed and logs the failure", async () => {
    const dataset = parseDraftQualityDataset(createInlineDataset());
    const logger = { log: vi.fn() };
    const judge: DraftQualityJudge = {
      evaluate: async () =>
        ({
          relevance: {
            passed: "definitely" as unknown as boolean
          }
        }) as unknown as Awaited<ReturnType<DraftQualityJudge["evaluate"]>>
    };

    const report = await evaluateDraftQuality({
      dataset,
      judge,
      logger,
      now: FIXED_DATE,
      run_id: "run_bad_judge"
    });

    expect(report.summary.judge_failure_count).toBe(1);
    expect(report.summary.warning_count).toBe(1);
    expect(report.cases[0]?.metrics.relevance.mode).toBe("deterministic");
    expect(report.cases[0]?.notes).toContain(
      "Judge fallback: deterministic scores were kept."
    );
    expect(report.warnings[0]).toContain(
      "Judge fallback for inline_case_001/manual_ok:"
    );
    expect(logger.log).toHaveBeenCalledWith(
      "error",
      "draft_quality.judge.failed",
      expect.objectContaining({
        case_id: "inline_case_001",
        draft_id: "manual_ok"
      })
    );
  });

  it("times out hung judges per draft without aborting the whole batch", async () => {
    const dataset = parseDraftQualityDataset(createInlineDataset());
    const logger = { log: vi.fn() };
    const judge: DraftQualityJudge = {
      evaluate: async () =>
        await new Promise<Awaited<ReturnType<DraftQualityJudge["evaluate"]>>>(() => undefined)
    };

    const report = await evaluateDraftQuality({
      dataset,
      judge,
      logger,
      limits: {
        judge_timeout_ms: 5
      },
      now: FIXED_DATE,
      run_id: "run_timeout_judge"
    });

    expect(report.summary.total_drafts).toBe(1);
    expect(report.summary.judge_failure_count).toBe(1);
    expect(report.warnings[0]).toContain("timed out after 5ms");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "draft_quality.judge.timeout",
      expect.objectContaining({
        case_id: "inline_case_001",
        draft_id: "manual_ok",
        timeout_ms: 5
      })
    );
  });

  it("revalidates typed inputs and enforces evaluation resource limits", async () => {
    const malformedDataset = {
      schema_version: 1,
      cases: []
    } as unknown as DraftQualityDataset;

    await expect(
      evaluateDraftQuality({
        dataset: malformedDataset,
        now: FIXED_DATE,
        run_id: "run_malformed_direct"
      })
    ).rejects.toThrowError(LinkedInAssistantError);

    const dataset = parseDraftQualityDataset(createInlineDataset());
    await expect(
      evaluateDraftQuality({
        dataset,
        limits: {
          max_draft_characters: 5
        },
        now: FIXED_DATE,
        run_id: "run_limit_direct"
      })
    ).rejects.toThrowError(LinkedInAssistantError);
  });

  it("avoids false duplicate collisions when case and draft ids include double colons", async () => {
    const dataset = parseDraftQualityDataset({
      schemaVersion: 1,
      cases: [
        {
          id: "a",
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
                author: "Jordan",
                direction: "inbound",
                text: "Hello"
              }
            ]
          },
          expectations: {
            tone: {
              required: [],
              forbidden: []
            },
            length: {
              minWords: 1,
              maxWords: 10
            },
            requiredPoints: []
          },
          candidateDrafts: [
            {
              id: "b::c",
              source: "manual",
              text: "Hello there"
            }
          ]
        },
        {
          id: "a::b",
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
                id: "m2",
                author: "Jordan",
                direction: "inbound",
                text: "Hi again"
              }
            ]
          },
          expectations: {
            tone: {
              required: [],
              forbidden: []
            },
            length: {
              minWords: 1,
              maxWords: 10
            },
            requiredPoints: []
          },
          candidateDrafts: []
        }
      ]
    });
    const candidates = parseDraftQualityCandidateSet({
      schemaVersion: 1,
      drafts: [
        {
          caseId: "a::b",
          id: "c",
          source: "model",
          text: "Hi there"
        }
      ]
    });

    const report = await evaluateDraftQuality({
      dataset,
      candidates,
      now: FIXED_DATE,
      run_id: "run_double_colon_ids"
    });

    expect(report.summary.total_drafts).toBe(2);
    expect(report.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ case_id: "a", draft_id: "b::c" }),
        expect.objectContaining({ case_id: "a::b", draft_id: "c" })
      ])
    );
  });

  it("isolates concurrent runs from judge input mutation", async () => {
    const dataset = parseDraftQualityDataset(createInlineDataset());
    const judge: DraftQualityJudge = {
      evaluate: async (input) => {
        input.draft_case.id = "tampered_case";
        input.draft.id = "tampered_draft";
        input.deterministic.relevance.details.missing_point_ids.push("fake_point");
        return {};
      }
    };

    const [firstReport, secondReport] = await Promise.all([
      evaluateDraftQuality({
        dataset,
        judge,
        now: FIXED_DATE,
        run_id: "run_concurrent_a"
      }),
      evaluateDraftQuality({
        dataset,
        judge,
        now: FIXED_DATE,
        run_id: "run_concurrent_b"
      })
    ]);

    expect(firstReport.cases[0]).toMatchObject({
      case_id: "inline_case_001",
      draft_id: "manual_ok"
    });
    expect(secondReport.cases[0]).toMatchObject({
      case_id: "inline_case_001",
      draft_id: "manual_ok"
    });
    expect(firstReport.cases[0]?.metrics.relevance.details.missing_point_ids).not.toContain(
      "fake_point"
    );
    expect(secondReport.cases[0]?.metrics.relevance.details.missing_point_ids).not.toContain(
      "fake_point"
    );
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

  it("rejects invalid external candidate merges during evaluation", async () => {
    const dataset = parseDraftQualityDataset({
      schemaVersion: 1,
      cases: [
        {
          id: "case_1",
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
              required: [],
              forbidden: []
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
    });

    const unknownCaseCandidates = parseDraftQualityCandidateSet({
      schemaVersion: 1,
      drafts: [
        {
          caseId: "missing_case",
          id: "draft_2",
          source: "model",
          text: "Hi there"
        }
      ]
    });

    await expect(
      evaluateDraftQuality({
        dataset,
        candidates: unknownCaseCandidates,
        now: FIXED_DATE,
        run_id: "run_unknown_case"
      })
    ).rejects.toThrowError(LinkedInAssistantError);

    const duplicateMergeCandidates = parseDraftQualityCandidateSet({
      schemaVersion: 1,
      drafts: [
        {
          caseId: "case_1",
          id: "draft_1",
          source: "model",
          text: "Hi again"
        }
      ]
    });

    await expect(
      evaluateDraftQuality({
        dataset,
        candidates: duplicateMergeCandidates,
        now: FIXED_DATE,
        run_id: "run_duplicate_merge"
      })
    ).rejects.toThrowError(LinkedInAssistantError);
  });
});
