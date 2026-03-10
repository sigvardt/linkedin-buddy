# Live write validation

`linkedin test live --write-validation --account <id>` is the Tier 3
human-in-the-loop harness for validating real LinkedIn write operations against
an approved secondary account.

Examples below use the `linkedin` binary; `buddy` is an equivalent alias.

The feature is also exported from `@linkedin-buddy/core` through
`packages/core/src/writeValidation.ts` for custom harnesses.

For the Tier 2 read-only rehearsal lane, see `docs/live-validation.md`.
For broader E2E safety rules and fixture-replay context, see
`docs/e2e-testing.md`.

## Quick start

Capture or refresh an encrypted stored session for the dedicated secondary
account:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin auth session --session secondary-session
```

Register the secondary account and its approved targets:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin accounts add secondary \
  --designation secondary \
  --session secondary-session \
  --profile secondary \
  --label "Secondary validation account" \
  --message-thread /messaging/thread/abc123/ \
  --message-participant-pattern "Simon Miller" \
  --invite-profile https://www.linkedin.com/in/test-target/ \
  --invite-note "Quick validation hello" \
  --followup-profile https://www.linkedin.com/in/test-target/ \
  --reaction-post https://www.linkedin.com/feed/update/urn:li:activity:123/ \
  --reaction like \
  --post-visibility connections
```

Run the Tier 3 harness:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin test live --write-validation --account secondary
```

## Safety model

Write validation is intentionally stricter than the other validation lanes:

- it performs **real LinkedIn writes** and prints a startup warning before the
  browser begins sending them
- it validates the configured account and all required approved targets before
  any real action is sent
- it runs only against accounts registered as `secondary`
- it requires `--account <id>` and resolves the stored session through the
  account registry
- it rejects `--session`, `--yes`, and `--cdp-url`
- it requires an interactive terminal and a visible browser window
- it prompts before every action and requires the operator to type `yes`
- it serializes runs per account with a lock file so two write-validation runs
  cannot overlap on the same account

Blocking auth, challenge, or rate-limit failures stop the run early. The
remaining actions are recorded as `cancelled`, and the harness still writes a
partial report so the operator can review what already happened.

There is currently **no** Tier 3 `--dry-run` or `--action` flag. The CLI always
runs the same fixed five-action suite in order. If you want a no-write rehearsal,
use Tier 2 read-only validation first.

## Tier 1, Tier 2, and Tier 3

The three lanes are related, but they do different jobs:

- **Tier 1 fixture replay**: deterministic, CI-safe, and no live LinkedIn side
  effects. Use this for repeatable regression coverage.
- **Tier 2 live read-only validation**: loads real LinkedIn pages with a stored
  session but blocks writes. Treat this as the closest live “dry-run” for Tier 3.
- **Tier 3 live write validation**: confirms that real outbound actions still
  work, verifies the resulting side effect, and records cleanup guidance.

A practical operator flow is:

1. Refresh the stored session with `linkedin auth session`.
2. Rehearse with `linkedin test live --read-only --session <session>`.
3. Run `linkedin test live --write-validation --account <id>` only after the
   approved targets and account config look correct.

## What the harness runs

The harness always executes the same five scenarios, in this order:

1. `post.create`
2. `connections.send_invitation`
3. `send_message`
4. `network.followup_after_accept`
5. `feed.like_post`

Before each action, the CLI prints a preview with:

- action number and action type
- one-line summary
- risk class (`private`, `network`, or `public`)
- target payload
- outbound payload
- expected outcome

Any response other than `yes` cancels that one action and the harness continues
to the next scenario. If you cancel some actions, the overall run outcome becomes
`cancelled` even when the action you did execute passed.

## Account registry

Write validation resolves account metadata from
`LINKEDIN_BUDDY_HOME/config.json` under `writeValidation.accounts`.
Register or update entries with `linkedin accounts add` or the hidden
`linkedin accounts:add` alias.

If you omit `--profile` or `--session`, both default to the normalized account id.

A persisted entry looks like this after normalization:

```json
{
  "writeValidation": {
    "accounts": {
      "secondary": {
        "designation": "secondary",
        "label": "Secondary validation account",
        "profileName": "secondary",
        "sessionName": "secondary-session",
        "targets": {
          "send_message": {
            "thread": "https://www.linkedin.com/messaging/thread/abc123/",
            "participantPattern": "Simon Miller"
          },
          "connections.send_invitation": {
            "targetProfile": "https://www.linkedin.com/in/test-target/",
            "note": "Quick validation hello"
          },
          "network.followup_after_accept": {
            "profileUrlKey": "https://www.linkedin.com/in/test-target/"
          },
          "feed.like_post": {
            "postUrl": "https://www.linkedin.com/feed/update/urn:li:activity:123/",
            "reaction": "like"
          },
          "post.create": {
            "visibility": "connections"
          }
        }
      }
    }
  }
}
```

### `linkedin accounts add` flags

Required:

- `<account>`: logical account id
- `--designation <designation>`: `primary` or `secondary`

Identity fields:

- `--label <label>`: human-friendly label stored with the account
- `--profile <profile>`: local profile name used for DB-backed write state
- `--session <session>`: stored encrypted session captured with
  `linkedin auth session`

Approved target fields:

- `--message-thread <thread>`: approved thread id or URL for `send_message`
- `--message-participant-pattern <pattern>`: optional regex for checking the
  approved thread participant
- `--invite-profile <profile>`: approved profile URL or slug for
  `connections.send_invitation`
- `--invite-note <note>`: optional invitation note for the approved profile
- `--followup-profile <profile>`: accepted-connection profile URL or slug for
  `network.followup_after_accept`
- `--reaction-post <post>`: approved post URL for `feed.like_post`
- `--reaction <reaction>`: reaction to use for `feed.like_post`
  (`like`, `celebrate`, `support`, `love`, `insightful`, `funny`; defaults to
  `like`)
- `--post-visibility <visibility>`: visibility for `post.create` (`public` or
  `connections`; defaults to `connections`)
- `--force`: replace an existing account definition with the same id

Successful account registration prints JSON that includes `saved`,
`config_path`, and the normalized `account` payload. A typical response looks
like:

```json
{
  "saved": true,
  "config_path": "/tmp/linkedin-buddy/config.json",
  "account": {
    "id": "secondary",
    "designation": "secondary",
    "sessionName": "secondary-session"
  }
}
```

## Approved target examples by action

Use `--force` when you are updating an existing account entry.

### `send_message`

```bash
npm exec -w @linkedin-buddy/cli -- linkedin accounts add secondary \
  --designation secondary \
  --session secondary-session \
  --message-thread /messaging/thread/abc123/ \
  --message-participant-pattern "Simon Miller" \
  --force
```

The harness sends one validation reply into the approved thread and verifies that
the newest message text matches the sent payload.
Reply composition uses the same human-like typing simulation as
`HumanizedPage.type()`, including typed pauses and rare typo/correction loops.
If the harness degrades to direct input because of a safety timeout or a very
large payload, verification still checks the final message text.

### `connections.send_invitation`

```bash
npm exec -w @linkedin-buddy/cli -- linkedin accounts add secondary \
  --designation secondary \
  --session secondary-session \
  --invite-profile https://www.linkedin.com/in/test-target/ \
  --invite-note "Quick validation hello" \
  --force
```

The harness sends an invitation to the approved profile and re-checks the sent
invitations list.

### `network.followup_after_accept`

```bash
npm exec -w @linkedin-buddy/cli -- linkedin accounts add secondary \
  --designation secondary \
  --session secondary-session \
  --followup-profile https://www.linkedin.com/in/test-target/ \
  --force
```

The harness prepares the approved accepted-connection follow-up, confirms it,
and checks the local follow-up state for confirmation.
When the follow-up body is entered during confirm, it uses the same human-like
typing simulation layer as other composer-based actions.

### `feed.like_post`

```bash
npm exec -w @linkedin-buddy/cli -- linkedin accounts add secondary \
  --designation secondary \
  --session secondary-session \
  --reaction-post https://www.linkedin.com/feed/update/urn:li:activity:123/ \
  --reaction celebrate \
  --force
```

The harness applies the configured reaction and verifies that the executor
reported the target reaction as active.

### `post.create`

```bash
npm exec -w @linkedin-buddy/cli -- linkedin accounts add secondary \
  --designation secondary \
  --session secondary-session \
  --post-visibility connections \
  --force
```

The harness creates a new post, re-reads the published post from LinkedIn, and
checks that the validation text appears in the post content.
Post composition also uses the human-like typing simulation layer, with the same
direct-input fallback behavior for very long text or typing safety timeouts.

## Common workflows

### Run the full fixed suite

```bash
npm exec -w @linkedin-buddy/cli -- linkedin test live --write-validation --account secondary
```

Expected interactive output looks like:

```text
This will perform REAL actions on LinkedIn.
Running write validation against account "secondary". See docs/write-validation.md for account setup and approved targets.
Preparing the stored session, validating approved targets, and opening the interactive harness.
Starting write validation for account secondary (5 actions, cooldown 10s, timeout 30s).
Running 3/5: send_message — Send a message in the approved thread and verify the outbound message appears.
Write validation finished — 5 passed, 0 failed, 0 cancelled. Report: /tmp/live-write-validation/report.json
```

Composer-based actions (`send_message`, `network.followup_after_accept`, and
`post.create`) emit structured `humanize.typing.*` diagnostics while entering
text so you can see whether a run stayed fully simulated or degraded to direct
input.

### Run one action from the fixed suite

There is no `--action` flag today. To exercise one scenario in practice, run the
full harness and answer `yes` only for the action you want to validate.
Cancel the others by answering anything else.

```bash
npm exec -w @linkedin-buddy/cli -- linkedin test live --write-validation --account secondary
```

Example flow when only `send_message` is approved during the prompts:

```text
Action 1/5: post.create
Execute this action? no
Cancelled 1/5: post.create by operator.

Action 3/5: send_message
Execute this action? yes
Finished 3/5: send_message — PASS | verified | state=n/a | 5.0s | 2 artifacts
Write validation finished — 1 passed, 0 failed, 4 cancelled. Report: /tmp/live-write-validation/report.json
```

### Rehearse with the Tier 2 no-write lane

Tier 3 has no dedicated `--dry-run` flag. The recommended no-write rehearsal is
Tier 2 live read-only validation against the same stored session:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin test live --read-only --session secondary-session --yes
```

Expected progress looks like:

```text
Starting live validation for session secondary-session (5 steps, request cap 20, min interval 5.0s).
Live validation finished — 5 passed, 0 failed. Report: /tmp/live-readonly/report.json
```

Use this lane to confirm the stored session is still healthy before starting real
Tier 3 writes.

### Emit JSON while keeping prompts interactive

```bash
mkdir -p reports
npm exec -w @linkedin-buddy/cli -- linkedin test live --write-validation --account secondary --json > reports/write-validation.json
```

In JSON mode, prompts still go to `stderr`, while the final report goes to
`stdout`. The saved report starts like:

```json
{
  "outcome": "pass",
  "action_count": 5,
  "report_path": "/tmp/live-write-validation/report.json",
  "html_report_path": "/tmp/live-write-validation/report.html",
  "latest_report_path": "/tmp/live-write-validation/secondary/latest-report.json"
}
```

### Review the HTML report

Every completed run writes a standalone HTML report automatically. No extra flag
is required.

```bash
npm exec -w @linkedin-buddy/cli -- linkedin test live --write-validation --account secondary --json > reports/write-validation.json
jq -r '.html_report_path' reports/write-validation.json
```

Typical output:

```text
/tmp/live-write-validation/report.html
```

The human-readable report also includes the path directly:

```text
Report HTML: /tmp/live-write-validation/report.html
Open /tmp/live-write-validation/report.html in a browser for the color-coded validation report.
```

### Slow the pace between real actions

```bash
npm exec -w @linkedin-buddy/cli -- linkedin test live --write-validation --account secondary --cooldown-seconds 20 --timeout-seconds 45
```

Use this when the account is rate-limited or the target surfaces load slowly.

## CLI options

### `linkedin test live --write-validation`

These flags affect Tier 3 runs directly:

- `--write-validation`: select the Tier 3 real-action harness
- `--account <id>`: required write-validation account id
- `--cooldown-seconds <seconds>`: cooldown between actions, default `10`
- `--timeout-seconds <seconds>`: navigation and selector timeout, default `30`
- `--no-progress`: hide the live progress stream in human mode
- `--json`: print the structured final report to `stdout`

These flags are explicitly rejected for Tier 3:

- `--read-only`
- `--session <name>`
- `--yes`
- `--cdp-url <url>`

`linkedin test live` also exposes Tier 2-only pacing and retry flags such as
`--max-requests`, `--min-interval-ms`, `--max-retries`,
`--retry-base-delay-ms`, and `--retry-max-delay-ms`. They belong to the
read-only lane and do not affect `--write-validation` runs.

Use `npm exec -w @linkedin-buddy/cli -- linkedin test live --help` for the
built-in help text. The hidden `linkedin test:live` alias accepts the same
options.

### `linkedin accounts add`

Use `linkedin accounts add <account> --designation secondary ...` to create or
update the account registry entry that Tier 3 will resolve at runtime. The
hidden `linkedin accounts:add` alias behaves the same way.

## Output formats

### Human-readable text

Human mode shows three layers:

1. startup warnings and notices
2. live progress on `stderr`
3. a formatted summary with `Overview`, `Reports`, `Actions`, and
   `Recommendations`

A typical final summary contains lines such as:

```text
Write Validation FAIL
Overview
- Actions: 0 passed actions | 1 failed action | 0 cancelled actions
Reports
- Report JSON: /tmp/report.json
- Report HTML: /tmp/report.html
Actions
- 1/1 FAIL send_message | private | unverified | state=n/a | 5.0s | 1 artifact | ACTION_PRECONDITION_FAILED
Recommendations
- Open /tmp/report.html in a browser for the color-coded validation report.
```

### JSON report

The JSON report preserves the complete run contract, including:

- `account`: resolved account id, designation, label, profile, and session
- `action_count`, `pass_count`, `fail_count`, `cancelled_count`, and `outcome`
- `actions[]`: per-action previews, verification data, artifact paths, warnings,
  cleanup guidance, and any structured error details
- `report_path`, `html_report_path`, `audit_log_path`, and `latest_report_path`
- `recommended_actions[]`: operator guidance for cleanup, review, or reruns

### HTML report

The HTML report is a standalone browser-friendly review artifact. It includes:

- outcome cards for actions, cleanup items, duration, and artifact counts
- color-coded action cards
- filters by status and risk class
- links to the JSON report, audit log, latest snapshot, and captured artifacts

## Reports, artifacts, and snapshots

Each completed run writes:

- a run-scoped JSON report at
  `artifacts/<run-id>/live-write-validation/report.json`
- a run-scoped HTML report at
  `artifacts/<run-id>/live-write-validation/report.html`
- the structured audit log for that run at `artifacts/<run-id>/events.jsonl`
- a stable latest snapshot at
  `LINKEDIN_BUDDY_HOME/live-write-validation/<account>/latest-report.json`

Each action result records:

- the preview shown before confirmation
- the executor or LinkedIn response payload
- verification status and verification source
- before and after screenshot paths
- any additional artifact paths
- per-action duration
- cleanup guidance when the action leaves a lasting side effect

The harness captures screenshots before and after every action. When the
underlying prepare/confirm flow does not already produce screenshot artifacts,
it captures fallback browser screenshots itself.

## Exit codes

- `0`: every action passed verification
- `1`: one or more actions failed verification or were cancelled
- `2`: preflight, session, or runtime errors prevented the run from completing

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

- Missing `targets.post.create`:

  ```bash
  linkedin accounts add secondary --designation secondary --session secondary-session \
    --post-visibility connections --force
  ```

- Missing or stale stored session:

  ```bash
  linkedin auth session --session secondary-session
  ```

## Related docs

- `docs/live-validation.md` for Tier 2 live read-only validation
- `docs/live-validation-architecture.md` for the Tier 2 pipeline internals
- `docs/e2e-testing.md` for the fixture-replay lane and live E2E safety rules
