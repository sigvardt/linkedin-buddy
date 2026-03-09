# Live read-only validation

`linkedin test live --read-only` is the Tier 2 smoke test for selector and
page-shape drift on real LinkedIn pages. It is designed for a human operator,
stays strictly read-only, and favors local safety over broad automation.

Examples below use the `linkedin` binary; `owa` is an equivalent alias.

The feature is also exported from `@linkedin-assistant/core` through
`packages/core/src/liveValidation.ts` for custom harnesses.

For pipeline internals, see `docs/live-validation-architecture.md`.

Tier 3 real-action validation is documented separately in `docs/write-validation.md`.

## Quick start

Capture an encrypted stored session from a manual LinkedIn login:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin auth session --session smoke
```

Run the live read-only validation interactively:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke
```

Run the same validation in batch mode while keeping every guardrail enabled:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke --yes --json
```

## What the validator checks

The validator always exercises the same five read-only flows, in order:

- `feed`: signed-in home feed surface
- `profile`: signed-in profile header
- `notifications`: notifications surface
- `inbox`: conversation list and one readable thread when available
- `connections`: connections list surface

Every step records selector matches, failures, warnings, and page-load timing.

The CLI currently does **not** support running a single step in isolation. To
focus on one step, filter the JSON report or call the Core API from a custom
harness.

## Common workflows

### Interactive smoke test

Use the default human-readable summary and approve each step manually:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke
```

### Detailed human-readable output

There is no separate `--verbose` flag for this command. Human mode already
prints live progress plus the most detailed built-in summary. Use `--yes` when
you want the full human-readable output without stopping for step-by-step
prompts:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke --yes
```

### CI or script integration

Force JSON output and skip prompts so the command can run unattended:

```bash
mkdir -p reports
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke --yes --json > reports/live-validation.json
```

The command exits with `1` for selector or operation failures and `2` for
preflight/session/runtime errors that prevent the run from completing.

### Inspect one operation from the JSON report

The CLI still runs the full suite, but you can isolate one operation in the
structured output:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke --yes --json | jq '.operations[] | select(.operation == "notifications")'
```

### Tune retries and pacing for a slower session

Increase the timeout and retry envelope without changing the read-only safety
model:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke --yes --timeout-seconds 45 --max-retries 3 --retry-max-delay-ms 15000
```

## CLI options

- `--read-only`: required acknowledgement that the run must stay strictly
  read-only
- `--session <name>`: stored session name captured by `linkedin auth session`
- `--timeout-seconds <seconds>`: navigation and selector timeout per step
- `--max-requests <count>`: maximum allowed live page requests before the run
  stops
- `--min-interval-ms <ms>`: minimum delay between live page requests
- `--max-retries <count>`: transient retry count per step
- `--retry-base-delay-ms <ms>`: initial exponential backoff delay
- `--retry-max-delay-ms <ms>`: upper bound for exponential backoff delay
- `--no-progress`: hide live progress lines in human-readable mode
- `--yes`: skip per-step confirmation prompts
- `--json`: print the structured JSON report instead of the human-readable
  summary

Use `npm exec -w @linkedin-assistant/cli -- linkedin test live --help` for the
built-in help text and examples. The hidden `linkedin test:live` alias accepts
the same options.

## Configuration

- `LINKEDIN_ASSISTANT_HOME` controls where stored sessions, artifacts, and the
  rolling `latest-report.json` snapshot live.
- `PLAYWRIGHT_EXECUTABLE_PATH` overrides the Chromium executable when
  Playwright cannot find one on the current machine.
- `--session <name>` selects the encrypted stored session captured earlier.
- `--cdp-url` is intentionally unsupported for Tier 2 validation so the CLI can
  enforce the guarded stored-session flow.

## Safety guardrails

- `--read-only` is required; the command refuses to run without it.
- `--cdp-url` is rejected for this workflow so the validator uses only the
  encrypted stored session.
- Interactive runs prompt before each step unless `--yes` is supplied.
- The validator enforces a minimum 5-second delay between steps and a maximum
  of 20 steps per session.
- During the run, only `GET` requests to LinkedIn-owned domains are allowed.
  Non-GET requests and non-LinkedIn domains are blocked and recorded in the
  report.
- Any challenge, captcha, login redirect, or unexpected redirect stops the run.
- The validator never loads mutation-specific selectors or prepares outbound
  actions.

## Session capture and refresh

- `linkedin auth session` opens a dedicated Chromium window.
- Sign in manually and wait for LinkedIn to land on an authenticated page.
- The CLI captures Playwright storage state and stores it encrypted at rest.
- Session contents are never printed to stdout/stderr.
- If `linkedin test live --read-only` detects an expired or challenged session
  in an interactive terminal, it prompts to capture a fresh session and retries
  the validation once.

## Reports and exit codes

Each run writes:

- a run-scoped report under `artifacts/<run-id>/live-readonly/report.json`
- the structured event log for that run under `artifacts/<run-id>/events.jsonl`
- a stable snapshot at `artifacts/live-readonly/latest-report.json`

The stable snapshot is compared with the next run to highlight:

- new selector failures
- selector drift toward weaker fallback candidates
- recovered selectors

Exit behavior:

- `0` when every read-only operation passes
- `1` when one or more operations fail, including partial reports after a later
  blocking failure
- `2` when preflight, session, or runtime errors prevent the run from
  completing

## Reading the result

Human-readable output includes:

- a top-level summary with the session name, checked-at timestamp, and report
  paths
- an overview section with pass/fail counts, warning counts, request budget
  usage, and diff coverage
- per-operation summaries with selector match counts, retries, warnings, and
  timings
- optional sections for warnings, operation errors, selector failures,
  regressions, recoveries, blocked requests, and recommended next steps

JSON output preserves the full structured report, including:

- `operations[]`: page-by-page outcomes and selector-level results
- `diff`: regressions and recoveries versus the previous run
- `blocked_requests[]`: every aborted non-GET or non-LinkedIn request
- `request_limits`: request cap usage and the minimum interval policy
- `session`: stored-session metadata used for the run

If you want to compare only one page between runs, filter the `operations`
array by `operation` rather than trying to skip the rest of the suite.
