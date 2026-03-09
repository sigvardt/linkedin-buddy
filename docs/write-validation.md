# Live write validation

`linkedin test live --write-validation --account <id>` is the Tier 3
human-in-the-loop harness for validating real LinkedIn write operations against
an approved secondary account.

Examples below use the `linkedin` binary; `owa` is an equivalent alias.

Unlike Tier 2 live validation, this workflow performs real outbound actions.
The CLI prints a prominent warning at startup, runs only in an interactive
terminal with a visible browser window, and requires the operator to type
`yes` before every action.

## Quick start

Capture or refresh a stored session for the secondary account:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin auth session --session secondary-session
```

Register the secondary account and its approved targets:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin accounts add secondary \
  --designation secondary \
  --session secondary-session \
  --profile secondary \
  --message-thread /messaging/thread/abc123/ \
  --message-participant-pattern "Simon Miller" \
  --invite-profile https://www.linkedin.com/in/test-target/ \
  --followup-profile https://www.linkedin.com/in/test-target/ \
  --reaction-post https://www.linkedin.com/feed/update/urn:li:activity:123/ \
  --reaction like \
  --post-visibility connections
```

Run the write-validation harness:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --write-validation --account secondary
```

Change the cooldown between real actions when needed:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --write-validation --account secondary --cooldown-seconds 20
```

Use JSON output while keeping prompts interactive:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --write-validation --account secondary --json
```

## Operator model

The harness always runs the same fixed suite, one action at a time, in this
order:

- `post.create`
- `connections.send_invitation`
- `send_message`
- `network.followup_after_accept`
- `feed.like_post`

Before each action, the CLI prints a preview containing:

- action number and action type
- one-line summary
- risk class
- target
- outbound payload
- expected outcome

The operator must then type `yes` to proceed. Any other response cancels that
single action and the harness continues to the next one.

Important behavior:

- `--yes` is rejected for write validation; there is no batch-confirm mode.
- Actions are never parallelized or batched.
- The default cooldown is 10 seconds between actions.
- `--cooldown-seconds <n>` changes the inter-action delay.
- `--timeout-seconds <n>` controls navigation and selector timeouts.
- `--no-progress` hides the live stderr progress stream in human mode.
- `--json` writes the structured result to stdout while prompts stay on stderr.

## CLI output and progress

Human-readable mode now shows three layers of feedback:

1. **Startup notices** — account, docs path, and preflight activity
2. **Live progress** — per-action stage updates such as prepare, screenshot,
   confirm, verify, retry, and cooldown
3. **Final summary** — color-coded pass/fail/cancelled sections with timing,
   report paths, action details, warnings, and next steps

The progress stream is designed for long-running scenarios such as invitation
sends and message validation. It mirrors the structured write-validation log
lifecycle without changing the underlying harness behavior.

## Account registry

Write validation resolves account metadata from
`LINKEDIN_ASSISTANT_HOME/config.json` under `writeValidation.accounts`.
Register or update entries with `linkedin accounts add` or the hidden
`linkedin accounts:add` alias.

Each account entry stores:

- designation: `primary` or `secondary`
- stored session name
- local profile name
- optional human label
- approved targets for every supported write action

Supported target options:

- `--message-thread <thread>` and optional `--message-participant-pattern <regex>`
- `--invite-profile <profile>` and optional `--invite-note <text>`
- `--followup-profile <profile>`
- `--reaction-post <post-url>` and optional `--reaction <reaction>`
- `--post-visibility <visibility>`

Use `--force` when you want to replace an existing account definition.

## Safety guardrails

The write-validation flow is intentionally stricter than Tier 2:

- It runs only against accounts registered as `secondary`.
- It hard-blocks accounts registered as `primary`.
- It requires `--account <id>` and ignores ad hoc session selection.
- It rejects `--session` overrides; the stored session comes from the account
  registry.
- It rejects `--yes`; every real action requires an explicit typed `yes`.
- It refuses to run in CI.
- It refuses to run in non-interactive or headless-style workflows.
- It rejects external browser attachment via `--cdp-url`.
- It cannot be combined with `--read-only`.

Use a dedicated secondary LinkedIn account and only approved test targets.

## What each action verifies

- `post.create`: creates a connections-only post and re-reads the published
  post from LinkedIn to confirm the content appears.
- `connections.send_invitation`: sends an invitation to the approved target and
  re-checks the sent invitations list.
- `send_message`: sends a message in the approved thread and re-reads the
  thread to confirm the latest message text.
- `network.followup_after_accept`: prepares and confirms the follow-up for an
  accepted connection, then checks the local follow-up state.
- `feed.like_post`: applies the configured reaction to the approved post and
  verifies the executor reported the reaction as active.

Some actions leave real side effects behind. The report includes
`cleanup_guidance[]` per action so the operator can remove test data afterward
when appropriate.

## Reports and artifacts

Each run writes:

- a run-scoped JSON report at `artifacts/<run-id>/live-write-validation/report.json`
- a run-scoped HTML report at `artifacts/<run-id>/live-write-validation/report.html`
- the structured audit log for that run at `artifacts/<run-id>/events.jsonl`
- a stable latest snapshot at `live-write-validation/<account>/latest-report.json`

The HTML report is meant for review in a browser. It includes:

- outcome cards with action, artifact, cleanup, and timing totals
- color-coded action cards
- filters by status and risk class
- direct links to JSON, latest snapshot, audit log, and captured artifacts

Each action result records:

- preview metadata shown before execution
- executor or LinkedIn response payload
- verification outcome and source
- before and after screenshot paths
- related artifact paths
- per-action duration
- cleanup guidance

The harness captures screenshots before and after every action. When the
underlying prepare/confirm flow does not already produce screenshot artifacts,
it captures fallback browser screenshots itself.

## Common setup fixes

If the harness fails during startup validation, use the message together with
these shortcuts:

- Missing `targets.send_message`:

  ```bash
  linkedin accounts add secondary --designation secondary --session secondary-session \
    --message-thread /messaging/thread/<id>/ --force
  ```

- Missing `targets.connections.send_invitation`:

  ```bash
  linkedin accounts add secondary --designation secondary --session secondary-session \
    --invite-profile https://www.linkedin.com/in/<slug>/ --force
  ```

- Missing `targets.network.followup_after_accept`:

  ```bash
  linkedin accounts add secondary --designation secondary --session secondary-session \
    --followup-profile https://www.linkedin.com/in/<slug>/ --force
  ```

- Missing `targets.feed.like_post`:

  ```bash
  linkedin accounts add secondary --designation secondary --session secondary-session \
    --reaction-post https://www.linkedin.com/feed/update/urn:li:activity:<id>/ \
    --reaction like --force
  ```

- Missing or stale stored session:

  ```bash
  linkedin auth session --session secondary-session
  ```

## Exit codes

- `0`: every action passed verification
- `1`: one or more actions failed verification or were cancelled
- `2`: preflight, session, or runtime errors prevented the run from completing

## Related docs

- `docs/live-validation.md` for Tier 2 read-only validation
- `docs/live-validation-architecture.md` for the Tier 2 pipeline internals
