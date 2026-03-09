# Live read-only validation

The live validation workflow is a Tier 2 smoke test for selector and page-shape
drift on real LinkedIn pages. It is designed for a human operator, stays
strictly read-only, and favors local safety over broad automation.

## Commands

Capture an encrypted stored session from a manual LinkedIn login:

```bash
npm exec -w @linkedin-assistant/cli -- owa auth:session --session smoke
```

Run the live read-only validation interactively:

```bash
npm exec -w @linkedin-assistant/cli -- owa test:live --read-only --session smoke
```

Run the same validation in batch mode while keeping every guardrail enabled:

```bash
npm exec -w @linkedin-assistant/cli -- owa test:live --read-only --session smoke --yes --json
```

## What the validator checks

The validator only exercises read-only flows:

- feed surface
- signed-in profile header
- notifications surface
- inbox conversation list and one readable thread when available
- connections surface

Every step records selector matches, failures, warnings, and page-load timing.

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

- `owa auth:session` opens a dedicated Chromium window.
- Sign in manually and wait for LinkedIn to land on an authenticated page.
- The CLI captures Playwright storage state and stores it encrypted at rest.
- Session contents are never printed to stdout/stderr.
- If `owa test:live --read-only` detects an expired or challenged session in an
  interactive terminal, it prompts to capture a fresh session and retries the
  validation once.

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
- `1` when one or more operations fail, or when the workflow is blocked by
  authentication / challenge / redirect guardrails
