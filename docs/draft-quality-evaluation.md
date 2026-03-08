# Draft quality evaluation

`linkedin audit draft-quality` is a read-only, offline evaluation harness for
reply drafts. It scores candidate drafts against case-specific expectations for
relevance, tone, and length, keeps hard failures separate, and emits a
structured JSON report for local review, CI, and agent workflows.

The draft-quality evaluator is also exported from `@linkedin-assistant/core`
via `packages/core/src/index.ts`.

## What it evaluates

- Relevance: required-point alias coverage plus latest-inbound off-topic
  signals
- Tone: heuristic evidence for required, optional, and forbidden tone labels
- Length: minimum and maximum word counts, optional sentence limits, and
  distance from a target word count
- Hard failures: forbidden phrases that fail the draft even when metric scores
  look good
- Optional judge feedback: hybrid relevance and tone scoring without weakening
  deterministic failures

## Quick start

```bash
# Evaluate the repo smoke fixtures with a human-readable summary
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality \
  --dataset packages/core/test/fixtures/draft-quality/smoke-dataset.json \
  --candidates packages/core/test/fixtures/draft-quality/smoke-candidates.json

# Add per-draft detail to the human-readable summary
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality \
  --dataset packages/core/test/fixtures/draft-quality/smoke-dataset.json \
  --candidates packages/core/test/fixtures/draft-quality/smoke-candidates.json \
  --verbose

# Force JSON output and also persist the report to disk
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality \
  --dataset packages/core/test/fixtures/draft-quality/smoke-dataset.json \
  --candidates packages/core/test/fixtures/draft-quality/smoke-candidates.json \
  --json \
  --output reports/draft-quality.json

# Show built-in help and usage examples
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality --help
```

## CLI usage

Command shape:

```bash
linkedin audit draft-quality --dataset <path> [--candidates <path>] [--json] [--verbose] [--no-progress] [--output <path>]
```

Available switches:

- `--dataset <path>`: required JSON dataset file with cases, thread context,
  and expectations
- `--candidates <path>`: optional JSON file with additional candidate drafts
  keyed by `case_id` and `draft_id`
- `--json`: print the structured JSON report instead of the human-readable
  summary
- `--verbose`: include per-draft metric details in human-readable output
- `--no-progress`: hide live per-case progress lines in human-readable output
- `--output <path>`: write the JSON report to a file; parent directories are
  created automatically

Default output behavior:

- Interactive terminals default to a human-readable summary with per-case
  progress lines on `stderr`
- Non-interactive terminals default to JSON on `stdout`
- `--json` always forces JSON mode
- `--no-progress` only affects human-readable mode
- `--output` writes the JSON report in either mode and reports the resolved
  path in the human-readable summary

Exit codes:

- `0`: every evaluated draft passed
- `1`: at least one draft failed, a case was invalid, or the command hit a
  runtime/validation error

## Input format

The harness accepts two JSON inputs:

- a required dataset file with `cases`
- an optional candidates file with external drafts keyed by `case_id`

Representative dataset shape:

```json
{
  "schema_version": 1,
  "name": "draft-quality-smoke",
  "cases": [
    {
      "id": "followup_meeting_request_001",
      "channel": "linkedin_inbox",
      "scenario": "Warm follow-up when the contact is busy this week",
      "thread": {
        "participants": [
          {
            "id": "assistant",
            "name": "You",
            "role": "assistant"
          },
          {
            "id": "contact",
            "name": "Pat Morgan",
            "role": "contact"
          }
        ],
        "messages": [
          {
            "id": "m1",
            "author": "Pat Morgan",
            "direction": "inbound",
            "text": "Thanks for reaching out. This week is packed on my side."
          }
        ]
      },
      "expectations": {
        "tone": {
          "required": ["warm", "professional", "concise"],
          "optional": ["appreciative"],
          "forbidden": ["pushy", "robotic"]
        },
        "length": {
          "min_words": 20,
          "max_words": 50,
          "target_words": 35,
          "max_sentences": 2
        },
        "required_points": [
          {
            "id": "acknowledge_busyness",
            "aliases": ["packed", "busy", "totally understand", "no worries"]
          },
          {
            "id": "propose_next_week",
            "aliases": ["next week", "another time", "when your schedule opens up"]
          }
        ],
        "forbidden_phrases": ["just circling back", "as an AI"],
        "manual_notes": ["Keep the reply low-pressure and kind."]
      },
      "candidate_drafts": [
        {
          "id": "baseline_manual",
          "source": "manual",
          "text": "Thanks for the reply — totally understand that this week is packed. Happy to reconnect next week if that is easier for you."
        }
      ],
      "metadata": {
        "difficulty": "normal",
        "source": "synthetic"
      }
    }
  ]
}
```

Representative external candidates file:

```json
{
  "schema_version": 1,
  "drafts": [
    {
      "case_id": "followup_meeting_request_001",
      "id": "model_candidate",
      "source": "model",
      "text": "Thanks for the reply. Totally understand this week is busy. Happy to reconnect next week if helpful."
    }
  ]
}
```

Notes:

- Input parsing accepts both snake_case and camelCase aliases for core fields,
  including `schema_version`/`schemaVersion`,
  `candidate_drafts`/`candidateDrafts`, `required_points`/`requiredPoints`,
  `manual_notes`/`manualNotes`, `min_words`/`minWords`, and similar nested
  fields
- Reports are always normalized to canonical snake_case keys
- Supported tone labels are `warm`, `professional`, `friendly`, `concise`,
  `curious`, `appreciative`, `direct`, `empathetic`, `pushy`, `robotic`, and
  `casual`
- Supported draft sources are `manual`, `model`, `imported`, and `synthetic`
- Case ids must be unique across the dataset, and draft ids must be unique per
  case across embedded plus external candidates
- External candidates must reference existing dataset case ids

## Reading the result

Representative human-readable output:

```text
Starting draft quality evaluation (2 cases, 3 drafts).
Evaluating case 1/2: followup_meeting_request_001 (2 drafts)...
Finished case 1/2: followup_meeting_request_001 — 1 passed, 1 failed.
Evaluating case 2/2: timeline_clarification_001 (1 draft)...
Finished case 2/2: timeline_clarification_001 — 1 passed, 0 failed.
Draft quality evaluation finished. 2 passed, 1 failed.

Draft Quality Evaluation: FAIL
Run: run_fixture
Generated At: 2026-03-08T12:00:00.000Z
Summary: 2 of 3 drafts passed (66.7%) across 2/2 cases.

Overview
- Cases: 2 total | 2 evaluated | 0 skipped
- Drafts: 2 passed | 1 failed
- Checks: 1 hard-check hit | 0 judge fallbacks | 0 warnings
- Sources: manual=1 | model=2

Metrics
- Relevance: 83.3% average | 1 failing draft
- Tone: 77.8% average | 1 failing draft
- Length: 81.7% average | 1 failing draft
```

The human-readable summary includes:

- `Overview`: case counts, pass/fail counts, hard-check hits, judge fallbacks,
  warnings, and source breakdown
- `Metrics`: average relevance, tone, and length scores plus failing-draft
  counts per metric
- `Warnings`: skipped-case warnings and judge fallback warnings, when present
- `Failures`: a concise per-draft summary of missing points, forbidden tones,
  length misses, hard failures, and notes
- `Draft Details`: per-draft detail when `--verbose` is enabled
- `Next Steps`: reminders for `--verbose`, `--json`, and `--output`

Important scoring and threshold rules:

- Relevance passes only when every required point is covered; the score is
  `covered_required_points / total_required_points`
- Tone passes only when every required tone label is matched and no forbidden
  tone label is triggered; the score is
  `matched_required_tones / required_tone_count`
- Length passes only when the draft stays within `min_words`, `max_words`, and
  optional `max_sentences`; the score starts at `1` and scales down by the
  worst exceeded bound
- Overall score is the average of relevance, tone, and length scores, rounded
  to three decimals
- `forbidden_phrases` produce `hard_failures`; they do not change the metric
  scores, but they still fail the overall result
- Empty draft text is evaluated as a zero-length draft instead of a parse error

Representative JSON fields:

```json
{
  "run_id": "run_fixture",
  "generated_at": "2026-03-08T12:00:00.000Z",
  "outcome": "fail",
  "summary": {
    "total_cases": 2,
    "evaluated_case_count": 2,
    "skipped_case_count": 0,
    "total_drafts": 3,
    "passed_drafts": 2,
    "failed_drafts": 1,
    "pass_rate": 0.667,
    "metric_averages": {
      "relevance": 0.833,
      "tone": 0.778,
      "length": 0.817
    },
    "failed_metric_counts": {
      "relevance": 1,
      "tone": 1,
      "length": 1
    },
    "hard_failure_count": 1,
    "judge_failure_count": 0,
    "warning_count": 0,
    "source_counts": {
      "manual": 1,
      "model": 2,
      "imported": 0,
      "synthetic": 0
    }
  },
  "warnings": [],
  "cases": [
    {
      "case_id": "followup_meeting_request_001",
      "draft_id": "too_pushy",
      "draft_source": "model",
      "overall": {
        "passed": false,
        "failed_metrics": ["relevance", "tone", "length"],
        "hard_failures": [
          {
            "kind": "forbidden_phrase",
            "message": "Draft used forbidden phrases: just circling back",
            "values": ["just circling back"]
          }
        ]
      }
    }
  ]
}
```

Per-draft report details include:

- `metrics.relevance.details.covered_point_ids` and
  `metrics.relevance.details.missing_point_ids`
- `metrics.relevance.details.off_topic_signals`, which only inspect the latest
  inbound message in the thread
- `metrics.tone.details.matched`, `missing`, `optional_matched`,
  `forbidden_triggered`, and `evidence`
- `metrics.length.details.word_count`, `sentence_count`, `target_words`, and
  `distance_from_target`
- `notes`, which start with dataset `manual_notes` and may include judge notes
  or judge-fallback notes

## Example workflows

### Evaluate a single draft

Embed a single `candidate_drafts` entry in the dataset and run the evaluator:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality \
  --dataset eval/single-draft-dataset.json \
  --verbose
```

This is the simplest workflow for reviewing one draft against one case.

### Batch evaluation with external candidates

Keep the benchmark dataset stable and swap in a separate candidates file for a
model run, a prompt variation, or imported reviewer drafts:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality \
  --dataset eval/dataset.json \
  --candidates eval/model-run-2026-03-08.json \
  --json \
  --output reports/model-run-2026-03-08.json
```

This keeps case expectations under version control while making each model run
easy to compare.

### CI integration

Use JSON mode plus `--output` so CI can archive the report while still relying
on the command exit code:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality \
  --dataset eval/dataset.json \
  --candidates eval/candidates.json \
  --json \
  --output reports/draft-quality.json
```

Recommended CI behavior:

- archive `reports/draft-quality.json` as a build artifact
- fail the job when the command exits with `1`
- use `summary.pass_rate`, `summary.metric_averages`, and per-draft failures to
  diagnose regressions

## Core API

Core entry points exported from `@linkedin-assistant/core`:

- `parseDraftQualityDataset(value)` validates and normalizes dataset input
- `parseDraftQualityCandidateSet(value)` validates and normalizes external
  candidate input
- `evaluateDraftQuality(input)` runs the full evaluation and returns a
  `DraftQualityReport`
- `DRAFT_QUALITY_SCHEMA_VERSION`, `DRAFT_QUALITY_TONE_LABELS`, and
  `DRAFT_QUALITY_DRAFT_SOURCES` expose the schema version and enum-like values
- `DraftQualityDataset`, `DraftQualityCandidateSet`, `DraftQualityReport`,
  `DraftQualityCaseResult`, `DraftQualityJudge`, and
  `EvaluateDraftQualityInput` define the public type surface

Example:

```ts
import { readFile } from "node:fs/promises";

import {
  evaluateDraftQuality,
  parseDraftQualityCandidateSet,
  parseDraftQualityDataset,
  type DraftQualityJudge
} from "@linkedin-assistant/core";

const dataset = parseDraftQualityDataset(
  JSON.parse(await readFile("eval/dataset.json", "utf8"))
);
const candidates = parseDraftQualityCandidateSet(
  JSON.parse(await readFile("eval/candidates.json", "utf8"))
);

const judge: DraftQualityJudge = {
  evaluate: async ({ deterministic }) => ({
    relevance: {
      passed: deterministic.relevance.passed,
      score: deterministic.relevance.score,
      rationale: ["Optional human-or-LLM judge feedback goes here."]
    },
    tone: {
      passed: deterministic.tone.passed,
      score: deterministic.tone.score
    }
  })
};

const report = await evaluateDraftQuality({
  dataset,
  candidates,
  judge,
  limits: {
    max_cases: 1_000,
    max_drafts: 5_000,
    max_message_characters: 20_000,
    max_draft_characters: 20_000,
    max_total_text_characters: 2_000_000,
    judge_timeout_ms: 5_000
  },
  run_id: "run_manual_review",
  dataset_path: "eval/dataset.json",
  candidates_path: "eval/candidates.json",
  logger: {
    log(level, event, payload) {
      console.log(level, event, payload);
    }
  }
});

console.log(report.outcome, report.summary.pass_rate);
```

API behavior worth knowing:

- `evaluateDraftQuality()` reparses and revalidates its `dataset` and optional
  `candidates` inputs before scoring
- `judge` is optional and only affects relevance and tone, not length
- Judge feedback switches each returned metric from `deterministic` to
  `hybrid` mode
- Judge scores are averaged with deterministic scores, but deterministic metric
  failures remain sticky; a judge cannot turn a deterministic fail into a pass
- Malformed or timed-out judge feedback falls back per draft to deterministic
  scoring, increments `summary.judge_failure_count`, and adds a warning instead
  of aborting the full batch
- `judge_timeout_ms` defaults to `5000` and is capped at `60000`

Default evaluation limits:

- `max_cases`: `1000`
- `max_drafts`: `5000`
- `max_message_characters`: `20000`
- `max_draft_characters`: `20000`
- `max_total_text_characters`: `2000000`
- `judge_timeout_ms`: `5000`

## How it works internally

The evaluator runs in five phases:

1. Parse and normalize the dataset and optional candidates input from unknown
   JSON into typed core structures
2. Enforce schema and resource limits, including duplicate ids, unknown case
   references, unsupported tone labels, invalid length bounds, and text-size
   caps
3. Build a per-case draft lookup by combining embedded `candidate_drafts` with
   external `drafts`
4. Evaluate each draft deterministically for relevance, tone, length, and
   forbidden-phrase hard failures
5. Optionally call a `DraftQualityJudge`, merge relevance and tone feedback into
   hybrid scores, collect warnings, then aggregate everything into the final
   report summary

The CLI's progress reporter is powered by the evaluator's logger events. The
main events are:

- `draft_quality.evaluate.start`
- `draft_quality.case.start`
- `draft_quality.case.skipped`
- `draft_quality.case.done`
- `draft_quality.evaluate.complete`
- `draft_quality.judge.start`, `draft_quality.judge.complete`,
  `draft_quality.judge.timeout`, and `draft_quality.judge.failed`

## Where to find it

- README quick start: `README.md`
- CLI help: `linkedin audit draft-quality --help`
- Repo smoke fixtures:
  `packages/core/test/fixtures/draft-quality/smoke-dataset.json` and
  `packages/core/test/fixtures/draft-quality/smoke-candidates.json`
- Core exports: `packages/core/src/index.ts`
