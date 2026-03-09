# Live validation architecture

`linkedin test live --read-only` is the Tier 2 live validation pipeline for
the production LinkedIn UI. The command is intentionally narrow: it reuses a
stored session, exercises only read-only surfaces, and emits structured output
that operators and automation can compare between runs.

For day-to-day operator usage, examples, and CLI flags, see
`docs/live-validation.md`.

## Components

- `packages/cli/src/bin/linkedin.ts`: defines the `linkedin test live`
  command, validates CLI flags, prompts before each step in interactive mode,
  and optionally refreshes the stored session when LinkedIn rejects it.
- `packages/core/src/liveValidation.ts`: owns the Tier 2 execution pipeline,
  including session loading, guarded browser setup, endpoint execution,
  retries, diffing, and report persistence.
- `packages/core/src/auth/sessionStore.ts`: encrypts Playwright storage state
  at rest and reloads it for the live validation run.
- `packages/cli/src/liveValidationOutput.ts`: formats the structured report
  into the human-readable terminal summary and translates live JSON log events
  into progress lines.

## End-to-end pipeline

1. The operator captures or refreshes a stored session with
   `linkedin auth session --session <name>`.
2. The CLI validates that `--read-only` is present, rejects `--cdp-url`,
   resolves output mode, and creates an optional per-step confirmation hook.
3. `runReadOnlyLinkedInLiveValidation()` loads the encrypted session,
   resolves artifact paths, creates a run id, and opens a JSON event log.
4. The core runtime loads the previous `latest-report.json` snapshot, when it
   exists, so the new run can compute selector regressions and recoveries.
5. The validator launches headless Chromium with the stored Playwright
   `storageState`, applies navigation and selector timeouts, and installs the
   read-only network guard.
6. The pipeline walks the fixed operation list in order: `feed`, `profile`,
   `notifications`, `inbox`, and `connections`.
7. Each operation waits for the rate limiter, verifies that the stored session
   still looks authenticated, loads the page, checks the relevant selector
   groups, and records warnings, matches, failures, and timing data.
8. Transient timeouts or network failures retry with exponential backoff. Hard
   failures such as auth redirects, challenges, and non-recoverable page
   errors stop the run early and return a partial report.
9. After the operation loop, the core runtime computes the diff versus the
   previous snapshot, persists `report.json`, updates `latest-report.json`, and
   logs the final summary event.
10. The CLI either prints the structured JSON report or formats the report into
    a human-readable summary.

## Session management

- Session capture is intentionally manual. The CLI opens Chromium in headed
  mode, waits for the operator to finish the LinkedIn login flow, and stores
  the resulting Playwright `storageState`.
- Stored sessions are encrypted on disk by `LinkedInSessionStore`, so the
  validator never depends on a plaintext cookie jar.
- Tier 2 validation always uses the stored-session flow. `--cdp-url` is
  rejected because the validator must control the browser context so it can
  enforce the network guard and generate comparable reports.
- If the first operation fails because the stored session is expired or hits a
  LinkedIn challenge, the interactive CLI can prompt the operator to rerun
  `linkedin auth session` and then retry the validation once.

## Endpoint execution and safety

- The CLI always runs the full five-step suite in a fixed order. There is no
  single-endpoint CLI flag, which keeps diffs comparable between runs and makes
  the request budget predictable.
- The network guard allows only `GET` requests to LinkedIn-owned domains. Any
  non-`GET` request or non-LinkedIn domain is aborted and recorded in the final
  report.
- `ReadOnlyOperationRateLimiter` enforces both a minimum interval between live
  requests and a hard maximum request count for the session.
- The `inbox` step has special handling: it verifies the message list first and
  then opens one readable thread when one is available. If no thread is
  available, the step can still pass with a warning after validating the inbox
  surface.
- Retry logic is limited to transient timeout and connectivity failures. The
  retry count and exponential backoff bounds are configurable from the CLI.

## Output formatting and persistence

- Every run writes `artifacts/<run-id>/live-readonly/report.json` and the
  corresponding `artifacts/<run-id>/events.jsonl` event stream.
- The rolling snapshot at
  `artifacts/live-readonly/latest-report.json` is the comparison baseline for
  the next run.
- `computeReadOnlyValidationDiff()` classifies selector changes into three
  buckets:
  - `new_failure`: a selector used to pass and now fails
  - `fallback_drift`: a selector still passes, but only with a weaker fallback
  - `recovered`: a selector previously failed and now passes again
- `ReadOnlyValidationProgressReporter` consumes JSON log events and writes
  concise progress lines to `stderr` in human mode.
- `formatReadOnlyValidationReport()` turns the structured report into the
  multi-section terminal summary with overview, operations, warnings, failures,
  regressions, blocked requests, and next steps.
- `formatReadOnlyValidationError()` turns structured CLI/runtime failures into
  a short operator-focused message with the error code, a suggested fix, and a
  pointer to `linkedin test live --help`.

## CI and automation notes

- Interactive terminals default to the human-readable summary; non-interactive
  terminals default to JSON. `--json` forces JSON in both cases.
- `--yes` skips the per-step confirmation prompts so the command can run
  unattended, but it does not disable the read-only guardrails.
- The final report is stable enough for CI assertions because the operation ids
  and diff categories are fixed. If you need to focus on one operation, filter
  the `operations` array from the JSON output rather than trying to skip the
  rest of the suite.
