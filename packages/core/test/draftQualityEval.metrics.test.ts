import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  LinkedInBuddyError,
  evaluateDraftQuality,
  parseDraftQualityCandidateSet,
  parseDraftQualityDataset,
  type DraftQualityCaseResult,
  type DraftQualityDataset,
  type DraftQualityDraftSource,
  type DraftQualityJudge,
  type DraftQualityMessageDirection,
  type DraftQualityToneLabel
} from "../src/index.js";

const FIXED_DATE = new Date("2026-03-08T12:00:00.000Z");

interface ThreadMessageInput {
  id?: string;
  author: string;
  direction: DraftQualityMessageDirection;
  text: string;
}

interface LengthInput {
  minWords?: number;
  maxWords?: number;
  targetWords?: number;
  maxSentences?: number;
}

interface ToneInput {
  required?: DraftQualityToneLabel[];
  optional?: DraftQualityToneLabel[];
  forbidden?: DraftQualityToneLabel[];
}

interface RequiredPointInput {
  id: string;
  aliases: string[];
}

interface SingleDraftCaseInput {
  caseId?: string;
  draftId?: string;
  draftSource?: DraftQualityDraftSource;
  draftText?: string;
  draftLabel?: string;
  messages?: ThreadMessageInput[];
  tone?: ToneInput;
  length?: LengthInput;
  requiredPoints?: RequiredPointInput[];
  forbiddenPhrases?: string[];
  manualNotes?: string[];
}

function createSingleDraftDataset(input: SingleDraftCaseInput = {}): DraftQualityDataset {
  const messages = (input.messages ?? [
    {
      author: "Jordan",
      direction: "inbound",
      text: "Could you send a short overview next week?"
    }
  ]).map((message, index) => ({
    id: message.id ?? `m${index + 1}`,
    author: message.author,
    direction: message.direction,
    text: message.text
  }));

  return parseDraftQualityDataset({
    schemaVersion: 1,
    cases: [
      {
        id: input.caseId ?? "metric_case_001",
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
          messages
        },
        expectations: {
          tone: {
            required: input.tone?.required ?? [],
            optional: input.tone?.optional ?? [],
            forbidden: input.tone?.forbidden ?? []
          },
          length: {
            minWords: input.length?.minWords ?? 1,
            maxWords: input.length?.maxWords ?? 40,
            ...(input.length?.targetWords !== undefined
              ? { targetWords: input.length.targetWords }
              : {}),
            ...(input.length?.maxSentences !== undefined
              ? { maxSentences: input.length.maxSentences }
              : {})
          },
          requiredPoints: input.requiredPoints ?? [],
          forbiddenPhrases: input.forbiddenPhrases ?? [],
          manualNotes: input.manualNotes ?? []
        },
        candidateDrafts: [
          {
            id: input.draftId ?? "draft_001",
            source: input.draftSource ?? "manual",
            text: input.draftText ?? "Thanks — I can send a short overview next week.",
            ...(input.draftLabel ? { label: input.draftLabel } : {})
          }
        ]
      }
    ]
  });
}

async function evaluateDataset(
  dataset: DraftQualityDataset,
  judge?: DraftQualityJudge,
  runId = "run_metric"
) {
  return evaluateDraftQuality({
    dataset,
    judge,
    now: FIXED_DATE,
    run_id: runId
  });
}

async function evaluateSingleDraft(
  input: SingleDraftCaseInput,
  judge?: DraftQualityJudge
): Promise<DraftQualityCaseResult> {
  const report = await evaluateDataset(createSingleDraftDataset(input), judge);
  const result = report.cases[0];

  if (!result) {
    throw new Error("Expected a single draft-quality result.");
  }

  return result;
}

describe("draft quality evaluator scoring", () => {
  it("passes exact length boundaries and reports target distance", async () => {
    const result = await evaluateSingleDraft({
      draftText: "Thanks again today. Happy to help.",
      length: {
        minWords: 6,
        maxWords: 6,
        targetWords: 6,
        maxSentences: 2
      }
    });

    expect(result.metrics.length).toMatchObject({
      passed: true,
      score: 1,
      mode: "deterministic",
      details: {
        word_count: 6,
        sentence_count: 2,
        min_words: 6,
        max_words: 6,
        target_words: 6,
        max_sentences: 2,
        distance_from_target: 0
      }
    });
    expect(result.overall.passed).toBe(true);
  });

  it("handles empty drafts as zero-length failures without throwing", async () => {
    const dataset = createSingleDraftDataset({
      draftText: "Placeholder draft.",
      length: {
        minWords: 4,
        maxWords: 12,
        maxSentences: 2
      }
    });
    const draft = dataset.cases[0]?.candidate_drafts[0];

    if (!draft) {
      throw new Error("Expected a placeholder draft to mutate.");
    }

    draft.text = "";

    const report = await evaluateDataset(dataset, undefined, "run_empty_draft");
    const result = report.cases[0];

    expect(result?.metrics.length).toMatchObject({
      passed: false,
      score: 0,
      details: {
        word_count: 0,
        sentence_count: 0
      }
    });
    expect(result?.overall.failed_metrics).toEqual(["length"]);
  });

  it("matches unicode-equivalent required points across normalization forms", async () => {
    const result = await evaluateSingleDraft({
      draftText: "Thanks — happy to share the cafe\u0301 overview next week.",
      requiredPoints: [
        {
          id: "accented_keyword",
          aliases: ["café overview"]
        }
      ]
    });

    expect(result.metrics.relevance.passed).toBe(true);
    expect(result.metrics.relevance.details.covered_point_ids).toEqual([
      "accented_keyword"
    ]);
  });

  it("scales length scores when word and sentence limits are exceeded", async () => {
    const result = await evaluateSingleDraft({
      draftText: "One two three. Four five six. Seven eight nine.",
      length: {
        minWords: 1,
        maxWords: 6,
        targetWords: 5,
        maxSentences: 2
      }
    });

    expect(result.metrics.length).toMatchObject({
      passed: false,
      score: 0.667,
      details: {
        word_count: 9,
        sentence_count: 3,
        distance_from_target: 4
      }
    });
    expect(result.overall.failed_metrics).toEqual(["length"]);
  });

  it("scores relevance from required-point alias coverage", async () => {
    const result = await evaluateSingleDraft({
      draftText: "Thanks — I can send a short overview today.",
      tone: {
        required: ["warm"]
      },
      requiredPoints: [
        {
          id: "timeline",
          aliases: ["timeline"]
        },
        {
          id: "overview",
          aliases: ["short overview"]
        }
      ]
    });

    expect(result.metrics.relevance).toMatchObject({
      passed: false,
      score: 0.5,
      details: {
        total_required_points: 2,
        covered_point_ids: ["overview"],
        missing_point_ids: ["timeline"]
      }
    });
    expect(result.metrics.relevance.details.point_matches).toContainEqual({
      point_id: "overview",
      matched_aliases: ["short overview"]
    });
  });

  it("builds off-topic signals from the latest inbound message only", async () => {
    const result = await evaluateSingleDraft({
      messages: [
        {
          author: "Jordan",
          direction: "inbound",
          text: "The pilot still looks fine."
        },
        {
          author: "Jordan",
          direction: "inbound",
          text: "Could you send the pricing deck tomorrow?"
        }
      ],
      draftText: "Happy to discuss the pilot later."
    });

    expect(result.metrics.relevance.passed).toBe(true);
    expect(result.metrics.relevance.details.off_topic_signals).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pricing"),
        expect.stringContaining("latest inbound message")
      ])
    );
  });

  it("keeps hard failures separate from metric failures", async () => {
    const result = await evaluateSingleDraft({
      draftText: "Thanks again — next week works for me, so reply ASAP if helpful.",
      tone: {
        required: ["warm"]
      },
      length: {
        minWords: 8,
        maxWords: 20
      },
      requiredPoints: [
        {
          id: "mention_next_week",
          aliases: ["next week"]
        }
      ],
      forbiddenPhrases: ["reply ASAP"]
    });

    expect(result.metrics.relevance.passed).toBe(true);
    expect(result.metrics.tone.passed).toBe(true);
    expect(result.metrics.length.passed).toBe(true);
    expect(result.overall.failed_metrics).toEqual([]);
    expect(result.overall.passed).toBe(false);
    expect(result.overall.hard_failures).toEqual([
      {
        kind: "forbidden_phrase",
        message: "Draft used forbidden phrases: reply ASAP",
        values: ["reply ASAP"]
      }
    ]);
  });

  it("averages judge feedback into hybrid scores and deduplicates notes", async () => {
    const judge: DraftQualityJudge = {
      evaluate: async () => ({
        relevance: {
          passed: false,
          score: 0.4,
          rationale: ["Missed the specific ask.", "Missed the specific ask."]
        },
        tone: {
          passed: true,
          score: 0.6,
          rationale: ["Still reasonably warm."]
        },
        notes: ["Review note", "Review note"]
      })
    };

    const result = await evaluateSingleDraft(
      {
        draftText: "Thanks again — I can send the overview.",
        tone: {
          required: ["warm"]
        },
        requiredPoints: []
      },
      judge
    );

    expect(result.metrics.relevance.mode).toBe("hybrid");
    expect(result.metrics.relevance.passed).toBe(false);
    expect(result.metrics.relevance.score).toBe(0.7);
    expect(result.metrics.relevance.details.judge_rationale).toEqual([
      "Missed the specific ask."
    ]);
    expect(result.metrics.tone.mode).toBe("hybrid");
    expect(result.metrics.tone.score).toBe(0.8);
    expect(result.notes).toEqual(["Review note"]);
    expect(result.overall.failed_metrics).toEqual(["relevance"]);
  });
});

interface ToneHeuristicCase {
  label: DraftQualityToneLabel;
  expectationMode: "required" | "forbidden";
  draftText: string;
  evidenceFragment: string;
}

const TONE_HEURISTIC_CASES: ToneHeuristicCase[] = [
  {
    label: "warm",
    expectationMode: "required",
    draftText: "Thanks again — happy to reconnect next week.",
    evidenceFragment: "thanks"
  },
  {
    label: "professional",
    expectationMode: "required",
    draftText: "Thank you — please let me know what works for you.",
    evidenceFragment: "please"
  },
  {
    label: "friendly",
    expectationMode: "required",
    draftText: "Great to hear — happy to help.",
    evidenceFragment: "great"
  },
  {
    label: "concise",
    expectationMode: "required",
    draftText: "Thanks for the note.",
    evidenceFragment: "words within concise threshold"
  },
  {
    label: "curious",
    expectationMode: "required",
    draftText: "Would you be open to a quick chat next week?",
    evidenceFragment: "question mark"
  },
  {
    label: "appreciative",
    expectationMode: "required",
    draftText: "I appreciate the quick reply.",
    evidenceFragment: "appreciate"
  },
  {
    label: "direct",
    expectationMode: "required",
    draftText: "I can send a one-page overview today.",
    evidenceFragment: "i can send"
  },
  {
    label: "empathetic",
    expectationMode: "required",
    draftText: "Totally understand that this week is packed.",
    evidenceFragment: "totally understand"
  },
  {
    label: "pushy",
    expectationMode: "forbidden",
    draftText: "Just circling back!!!",
    evidenceFragment: "just circling back"
  },
  {
    label: "robotic",
    expectationMode: "forbidden",
    draftText: "As an AI, I can leverage synergy here.",
    evidenceFragment: "as an ai"
  },
  {
    label: "casual",
    expectationMode: "forbidden",
    draftText: "Hey, awesome — wanna chat?",
    evidenceFragment: "hey"
  }
];

describe("draft quality tone heuristics", () => {
  it.each(TONE_HEURISTIC_CASES)(
    "detects $label signals when used as a $expectationMode expectation",
    async ({ draftText, evidenceFragment, expectationMode, label }) => {
      const result = await evaluateSingleDraft({
        draftText,
        tone:
          expectationMode === "required"
            ? { required: [label] }
            : { forbidden: [label] }
      });

      if (expectationMode === "required") {
        expect(result.metrics.tone.passed).toBe(true);
        expect(result.metrics.tone.details.matched).toContain(label);
      } else {
        expect(result.metrics.tone.passed).toBe(false);
        expect(result.metrics.tone.details.forbidden_triggered).toContain(label);
      }

      expect(result.metrics.tone.details.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tone: label,
            signals: expect.arrayContaining([expect.stringContaining(evidenceFragment)])
          })
        ])
      );
    }
  );

  it("avoids over-crediting professional tone when casual or pushy signals appear", async () => {
    const result = await evaluateSingleDraft({
      draftText: "Hey there, thanks!!!",
      tone: {
        required: ["professional"],
        forbidden: ["casual", "pushy"]
      }
    });

    expect(result.metrics.tone.passed).toBe(false);
    expect(result.metrics.tone.details.matched).toEqual([]);
    expect(result.metrics.tone.details.missing).toEqual(["professional"]);
    expect(result.metrics.tone.details.forbidden_triggered).toEqual(
      expect.arrayContaining(["casual", "pushy"])
    );
  });
});

describe("draft quality evaluator parsing and integration", () => {
  it.each([
    {
      name: "an empty case list",
      payload: {
        schemaVersion: 1,
        cases: []
      }
    },
    {
      name: "conflicting tone expectations",
      payload: {
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case_001",
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
                  text: "Hello there"
                }
              ]
            },
            expectations: {
              tone: {
                required: ["warm"],
                forbidden: ["warm"]
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
                text: "Thanks for the message."
              }
            ]
          }
        ]
      }
    },
    {
      name: "inverted length bounds",
      payload: {
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case_002",
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
                  text: "Hello there"
                }
              ]
            },
            expectations: {
              tone: {
                required: [],
                forbidden: []
              },
              length: {
                minWords: 8,
                maxWords: 4
              },
              requiredPoints: []
            },
            candidateDrafts: [
              {
                id: "draft_1",
                source: "manual",
                text: "Thanks for the message."
              }
            ]
          }
        ]
      }
    },
    {
      name: "out-of-range target words",
      payload: {
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case_003",
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
                  text: "Hello there"
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
                maxWords: 4,
                targetWords: 6
              },
              requiredPoints: []
            },
            candidateDrafts: [
              {
                id: "draft_1",
                source: "manual",
                text: "Thanks for the message."
              }
            ]
          }
        ]
      }
    },
    {
      name: "whitespace-only candidate drafts",
      payload: {
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case_004",
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
                  text: "Hello there"
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
                text: "   "
              }
            ]
          }
        ]
      }
    },
    {
      name: "non-serializable metadata values",
      payload: {
        schemaVersion: 1,
        metadata: {
          bad: () => "nope"
        },
        cases: [
          {
            id: "invalid_case_005",
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
                  text: "Hello there"
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
                text: "Thanks for the message."
              }
            ]
          }
        ]
      }
    }
  ])("rejects %s", ({ payload }) => {
    expect(() => parseDraftQualityDataset(payload)).toThrowError(LinkedInBuddyError);
  });

  it("rejects visually empty candidate drafts made only of zero-width characters", () => {
    expect(() =>
      parseDraftQualityDataset({
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case_zero_width",
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
                  text: "Hello there"
                }
              ]
            },
            expectations: {
              tone: {
                required: [],
                forbidden: []
              },
              length: {
                minWords: 0,
                maxWords: 10
              },
              requiredPoints: []
            },
            candidateDrafts: [
              {
                id: "draft_1",
                source: "manual",
                text: "\u200B\u200B"
              }
            ]
          }
        ]
      })
    ).toThrowError(LinkedInBuddyError);
  });

  it("rejects duplicate participant ids, duplicate message ids, and unknown participant references", () => {
    expect(() =>
      parseDraftQualityDataset({
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case_participants",
            thread: {
              participants: [
                {
                  id: "assistant",
                  name: "You",
                  role: "assistant"
                },
                {
                  id: "assistant",
                  name: "Jordan",
                  role: "contact"
                }
              ],
              messages: [
                {
                  id: "m1",
                  author: "Jordan",
                  direction: "inbound",
                  text: "Hello there"
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
                text: "Thanks for the note."
              }
            ]
          }
        ]
      })
    ).toThrowError(LinkedInBuddyError);

    expect(() =>
      parseDraftQualityDataset({
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case_messages",
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
                  text: "Hello there"
                },
                {
                  id: "m1",
                  author: "Jordan",
                  direction: "inbound",
                  text: "Checking in"
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
                text: "Thanks for the note."
              }
            ]
          }
        ]
      })
    ).toThrowError(LinkedInBuddyError);

    expect(() =>
      parseDraftQualityDataset({
        schemaVersion: 1,
        cases: [
          {
            id: "invalid_case_refs",
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
                  text: "Hello there",
                  participantId: "missing_contact"
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
                text: "Thanks for the note."
              }
            ]
          }
        ]
      })
    ).toThrowError(LinkedInBuddyError);
  });

  it("rejects metadata that exceeds the maximum nesting depth", () => {
    const deepMetadata: Record<string, unknown> = {};
    let current: Record<string, unknown> = deepMetadata;

    for (let index = 0; index < 25; index += 1) {
      current.child = {};
      current = current.child as Record<string, unknown>;
    }

    expect(() =>
      parseDraftQualityDataset({
        schemaVersion: 1,
        metadata: deepMetadata,
        cases: [
          {
            id: "invalid_case_metadata_depth",
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
                  text: "Hello there"
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
                text: "Thanks for the note."
              }
            ]
          }
        ]
      })
    ).toThrowError(LinkedInBuddyError);
  });

  it("evaluates a mixed multi-case batch end to end", async () => {
    const totalCases = 12;
    const cases = Array.from({ length: totalCases }, (_, index) => ({
      id: `batch_case_${index + 1}`,
      thread: {
        participants: [
          {
            id: "assistant",
            name: "You",
            role: "assistant"
          },
          {
            id: "contact",
            name: `Contact ${index + 1}`,
            role: "contact"
          }
        ],
        messages: [
          {
            id: `m${index + 1}`,
            author: `Contact ${index + 1}`,
            direction: "inbound",
            text: `Could you send the overview for project ${index + 1} next week?`
          }
        ]
      },
      expectations: {
        tone: {
          required: ["warm"],
          forbidden: ["pushy"]
        },
        length: {
          minWords: 6,
          maxWords: 20,
          targetWords: 10,
          maxSentences: 1
        },
        requiredPoints: [
          {
            id: "mention_overview",
            aliases: ["overview"]
          },
          {
            id: "mention_next_week",
            aliases: ["next week"]
          }
        ]
      },
      candidateDrafts:
        index % 2 === 0
          ? [
              {
                id: "embedded",
                source: "manual",
                label: `baseline-${index + 1}`,
                text: "Thanks — I can send the overview next week."
              }
            ]
          : []
    }));

    const dataset = parseDraftQualityDataset({
      schemaVersion: 1,
      name: "draft-quality-batch",
      cases
    });
    const candidates = parseDraftQualityCandidateSet({
      schemaVersion: 1,
      drafts: Array.from({ length: totalCases / 2 }, (_, externalIndex) => {
        const caseNumber = externalIndex * 2 + 2;
        return {
          caseId: `batch_case_${caseNumber}`,
          id: "external",
          source: "model",
          label: `candidate-${caseNumber}`,
          text: "Thanks — I can send the overview next week."
        };
      })
    });

    const report = await evaluateDraftQuality({
      dataset,
      candidates,
      now: FIXED_DATE,
      run_id: "run_batch"
    });

    expect(report.run_id).toBe("run_batch");
    expect(report.generated_at).toBe(FIXED_DATE.toISOString());
    expect(report.outcome).toBe("pass");
    expect(report.summary).toMatchObject({
      total_cases: totalCases,
      evaluated_case_count: totalCases,
      skipped_case_count: 0,
      total_drafts: totalCases,
      passed_drafts: totalCases,
      failed_drafts: 0,
      pass_rate: 1,
      metric_averages: {
        relevance: 1,
        tone: 1,
        length: 1
      },
      source_counts: {
        manual: totalCases / 2,
        model: totalCases / 2,
        imported: 0,
        synthetic: 0
      }
    });
    expect(report.warnings).toEqual([]);
    expect(report.cases).toHaveLength(totalCases);
    expect(report.cases.every((result) => result.overall.passed)).toBe(true);
    expect(
      report.cases.some(
        (result) =>
          result.case_id === "batch_case_2" && result.draft_label === "candidate-2"
      )
    ).toBe(true);
  });

  it("evaluates medium-sized batches within a modest CI time budget", async () => {
    const totalCases = 80;
    const dataset = parseDraftQualityDataset({
      schemaVersion: 1,
      cases: Array.from({ length: totalCases }, (_, index) => ({
        id: `perf_case_${index + 1}`,
        thread: {
          participants: [
            {
              id: "assistant",
              name: "You",
              role: "assistant"
            },
            {
              id: "contact",
              name: `Contact ${index + 1}`,
              role: "contact"
            }
          ],
          messages: [
            {
              id: `m${index + 1}`,
              author: `Contact ${index + 1}`,
              direction: "inbound",
              text: `Could you send the overview for project ${index + 1} next week?`
            }
          ]
        },
        expectations: {
          tone: {
            required: ["warm"],
            forbidden: ["pushy"]
          },
          length: {
            minWords: 6,
            maxWords: 20,
            maxSentences: 1
          },
          requiredPoints: [
            {
              id: "mention_overview",
              aliases: ["overview"]
            },
            {
              id: "mention_next_week",
              aliases: ["next week"]
            }
          ]
        },
        candidateDrafts: Array.from({ length: 3 }, (_, draftIndex) => ({
          id: `draft_${draftIndex + 1}`,
          source: draftIndex % 2 === 0 ? "manual" : "model",
          text: "Thanks — I can send the overview next week."
        }))
      }))
    });

    const startedAt = performance.now();
    const report = await evaluateDraftQuality({
      dataset,
      now: FIXED_DATE,
      run_id: "run_perf"
    });
    const durationMs = performance.now() - startedAt;

    expect(report.summary.total_cases).toBe(totalCases);
    expect(report.summary.total_drafts).toBe(totalCases * 3);
    expect(report.summary.failed_drafts).toBe(0);
    expect(durationMs).toBeLessThan(1_000);
  });
});
