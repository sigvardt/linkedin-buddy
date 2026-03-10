# linkedin-owa-agentools

LinkedIn automation monorepo with a shared TypeScript core, local CLI, and MCP stdio server.

## Monorepo Layout

- `packages/core` (`@linkedin-assistant/core`)
- `packages/cli` (`@linkedin-assistant/cli`) with `linkedin` bin
- `packages/mcp` (`@linkedin-assistant/mcp`) with `linkedin-mcp` bin

## Requirements

- Node.js 22+
- npm 10+

Install dependencies:

```bash
npm install
```

`playwright-core` does not bundle browsers. Install Chromium:

```bash
npx playwright install chromium
```

Optional browser path override:

```bash
export PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome-or-chromium
```

Default tool-owned state home (profiles, DB, artifacts):

- `~/.linkedin-assistant/linkedin-owa-agentools`
- Override with `LINKEDIN_ASSISTANT_HOME=/custom/path`
- Confirm-failure trace size cap: `LINKEDIN_ASSISTANT_CONFIRM_TRACE_MAX_BYTES` (defaults to `26214400`)
- Anti-bot evasion profile: `LINKEDIN_ASSISTANT_EVASION_LEVEL` (defaults to `moderate`; supports `minimal`, `moderate`, `paranoid`)
- Verbose evasion diagnostics: `LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS` (defaults to `false`; when `true`, debug evasion events are written to the run log)
- See `docs/evasion.md` for the evasion profiles, status output, and diagnostics hooks
- Selector locale for UI-text fallbacks: `LINKEDIN_ASSISTANT_SELECTOR_LOCALE` (defaults to `en`; supports `en`, `da`; region tags like `da-DK` normalize to `da`; unsupported values fall back to `en` with a warning; see `docs/selector-locale.md`)

Scheduler / scheduled follow-up configuration:

- `LINKEDIN_ASSISTANT_SCHEDULER_ENABLED=true|false` toggles local scheduler work (defaults to `true`)
- `LINKEDIN_ASSISTANT_SCHEDULER_ENABLED_LANES=followup_preparation` controls enabled lanes; set it to an empty string to disable all lanes
- `LINKEDIN_ASSISTANT_SCHEDULER_POLL_INTERVAL_SECONDS=300` controls daemon polling cadence
- `LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_START=09:00`, `LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_END=17:00`, and `LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE=<IANA zone>` define the business-hours review window
- `LINKEDIN_ASSISTANT_SCHEDULER_FOLLOWUP_DELAY_MINUTES=15` delays follow-up preparation after acceptance is detected
- See `docs/scheduler.md` for the full scheduler guide, architecture notes, and every scheduler env var

Activity webhook / polling configuration:

- `LINKEDIN_ASSISTANT_ACTIVITY_ENABLED=true|false` toggles local activity polling and webhook delivery work (defaults to `true`)
- `LINKEDIN_ASSISTANT_ACTIVITY_DAEMON_POLL_INTERVAL_SECONDS=60` controls daemon wake-up cadence
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_WATCHES_PER_TICK=4` bounds LinkedIn polling work per tick
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_CONCURRENT_WATCHES=20` caps active watches per profile
- `LINKEDIN_ASSISTANT_ACTIVITY_MIN_POLL_INTERVAL_SECONDS=60` sets the minimum interval schedule accepted for activity watches
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERIES_PER_TICK=12` bounds webhook delivery work per tick
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH=250` bounds queued `pending` + `leased` webhook deliveries before new watch polling backs off
- `LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS=120`, `LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS=60`, and `LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS=5` control lease recovery under clock skew
- `LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS=10` caps one webhook POST attempt
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERY_ATTEMPTS=6` sets the default retry ceiling per subscription delivery
- `LINKEDIN_ASSISTANT_ACTIVITY_INITIAL_BACKOFF_SECONDS=60` and `LINKEDIN_ASSISTANT_ACTIVITY_MAX_BACKOFF_SECONDS=86400` control exponential backoff for retryable delivery failures and watch poll failures
- See `docs/activity-webhooks.md` for quickstart steps, CLI workflows, diagnostics, and every activity env var

Privacy / redaction controls:

- `LINKEDIN_ASSISTANT_REDACTION_MODE=off|partial|full`
- `LINKEDIN_ASSISTANT_STORAGE_MODE=full|excerpt`
- `LINKEDIN_ASSISTANT_MESSAGE_EXCERPT_LENGTH=80`
- `LINKEDIN_ASSISTANT_REDACTION_HASH_SALT=your-local-salt`

`partial` hashes names and stores/logs only short message excerpts. `full` replaces sensitive message bodies with fully redacted markers.

Post safety lint configuration:

- Optional config file: `~/.linkedin-assistant/linkedin-owa-agentools/config.json`
- JSON shape:

```json
{
  "postSafetyLint": {
    "maxLength": 2800,
    "bannedPhrases": ["take this offline", "guaranteed returns"],
    "validateLinkPreviews": true,
    "linkPreviewValidationTimeoutMs": 5000
  }
}
```

- Environment overrides:
  - `LINKEDIN_ASSISTANT_POST_SAFETY_MAX_LENGTH`
  - `LINKEDIN_ASSISTANT_POST_SAFETY_BANNED_PHRASES` (JSON array or comma/newline-separated list)
  - `LINKEDIN_ASSISTANT_POST_SAFETY_VALIDATE_LINK_PREVIEWS`
  - `LINKEDIN_ASSISTANT_POST_SAFETY_LINK_TIMEOUT_MS`

Live write-validation account registry:

- Optional config file: `~/.linkedin-assistant/linkedin-owa-agentools/config.json`
- JSON shape:

```json
{
  "writeValidation": {
    "accounts": {
      "secondary": {
        "designation": "secondary",
        "profileName": "secondary",
        "sessionName": "secondary-session",
        "targets": {
          "send_message": {
            "thread": "https://www.linkedin.com/messaging/thread/abc123/"
          },
          "connections.send_invitation": {
            "targetProfile": "https://www.linkedin.com/in/test-target/"
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

- Use `linkedin accounts add` or `linkedin accounts:add` to create and update
  these entries instead of editing JSON manually when possible.

## Human-like Typing Simulation

The core `humanize(page, options?)` wrapper includes a typing simulation layer
for high-signal text entry. It is used for credential entry during login and
for composer-based flows that call `HumanizedPage.type()`, such as replies,
follow-ups, and posts.

The simulation layer:

- types one grapheme at a time with profile-based speed, jitter, and
  word-boundary timing
- inserts short thinking pauses, longer sentence-break pauses, Shift lead time,
  and occasional adjacent-key typos with automatic correction
- emits `humanize.typing.*` diagnostics and degrades to direct input when text
  is too long for safe simulation or a typing safety timeout is hit

Configuration surface:

- `typingProfile`: choose `careful` (default), `casual`, or `fast`
- `typingProfileOverrides`: fine-tune delay, jitter, typo, and pause settings
- `typingDelay` / `typingJitter`: legacy per-character overrides for coarse
  speed tuning
- per-call `HumanizedTypingOptions.profile`, `profileOverrides`, and
  `fieldLabel`
- built-in presets are exported as `TYPING_PROFILES`

Basic usage:

```ts
import { humanize } from "@linkedin-assistant/core";

const hp = humanize(page, { typingProfile: "careful" });
await hp.type('[role="textbox"]', "Thanks for sharing this update.", {
  fieldLabel: "message composer"
});
```

See `packages/core/README.md` for more profile examples and
`docs/human-typing-architecture.md` for the underlying design.

## Anti-bot evasion

The core package ships an opt-in anti-bot evasion module for Playwright pages,
along with runtime-level status snapshots and debug diagnostics.

Configuration surface:

- default level: `moderate`
- `LINKEDIN_ASSISTANT_EVASION_LEVEL=minimal|moderate|paranoid`
- `LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS=true|false`
- `createCoreRuntime({ evasionLevel, evasionDiagnostics })` for direct Core callers
- precedence is runtime option → environment variable → built-in default

Diagnostics surface:

- there is no standalone `linkedin evasion` CLI group or `linkedin.evasion.*` MCP tool today
- `linkedin status` includes a top-level `evasion` block
- `linkedin health` includes `session.evasion`
- `linkedin.session.status` includes `status.evasion`
- `linkedin.session.health` includes `session.evasion`
- read-only status and health checks report the resolved config without injecting synthetic input
- CLI and MCP do not expose evasion-specific flags or tool args; use env vars or direct Core runtime options
- enabling diagnostics records `evasion.*` events in the run log for easier troubleshooting

```ts
import { EvasionSession, createCoreRuntime } from "@linkedin-assistant/core";

const runtime = createCoreRuntime({
  evasionLevel: "paranoid",
  evasionDiagnostics: true
});

const session = new EvasionSession(page, runtime.evasion.level, {
  diagnosticsEnabled: runtime.evasion.diagnosticsEnabled,
  diagnosticsLabel: "feed",
  logger: runtime.logger
});
```

See `docs/evasion.md` for the profile matrix, configuration reference,
CLI/MCP JSON paths, and troubleshooting guide.

## Selector Locale Support

Locale-aware selectors let the runtime prefer localized LinkedIn UI phrases
before falling back to English. This keeps the existing structural selectors
and candidate ordering intact while making text-bearing selectors more reliable
on supported non-English LinkedIn sessions.

- Supported locales: `en`, `da`
- Region tags normalize to their supported base locale (`da-DK` → `da`, `en-US` → `en`)
- Precedence: explicit CLI / MCP / Core runtime input → `LINKEDIN_ASSISTANT_SELECTOR_LOCALE` → `en`
- Unsupported, blank, malformed, or overly long locale values fall back to `en` with a warning
- Browser language is diagnostic only; it does not silently override explicit config
- Selector locale is not currently read from `config.json`; use the CLI flag, MCP input, runtime option, or env var

```bash
# Default the current shell to Danish selector phrases
export LINKEDIN_ASSISTANT_SELECTOR_LOCALE=da
npm exec -w @linkedin-assistant/cli -- linkedin status --profile default

# Override the locale for one command with a normalized region tag
npm exec -w @linkedin-assistant/cli -- linkedin --selector-locale da-DK audit selectors --profile default
```

MCP clients can pass `"selectorLocale": "da"` in tool arguments, and Core
callers can pass `createCoreRuntime({ selectorLocale: "da" })`.

See `docs/selector-locale.md` for CLI, MCP, Core API, architecture, and
migration guidance.

## CLI Usage

Run commands via workspace binaries:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin status --profile default
npm exec -w @linkedin-assistant/cli -- linkedin health --profile default
npm exec -w @linkedin-assistant/cli -- linkedin login --profile default --timeout-minutes 10
```

- `linkedin status` and `linkedin health` now include the resolved anti-bot evasion snapshot in their JSON output so you can confirm the active level, enabled features, and diagnostics flag before reproducing session issues.
- There is no dedicated `linkedin evasion` command group yet; configure evasion through env vars and inspect it through `status` / `health`. See `docs/evasion.md` for the exact JSON paths and troubleshooting workflow.

Isolation note:

- Omitting `--cdp-url` uses a dedicated Playwright persistent profile owned by this tool.
- Passing `--cdp-url` attaches to an existing browser and can share session/cookie state.

Session keepalive daemon (isolated profile):

```bash
npm exec -w @linkedin-assistant/cli -- linkedin keepalive start --profile default
npm exec -w @linkedin-assistant/cli -- linkedin keepalive status --profile default --verbose
npm exec -w @linkedin-assistant/cli -- linkedin keepalive status --profile default --json
npm exec -w @linkedin-assistant/cli -- linkedin keepalive stop --profile default
```

- `start` spawns a detached daemon and returns after it writes the profile PID file plus `*.state.json` and `*.events.jsonl` files under `~/.linkedin-assistant/linkedin-owa-agentools/keepalive/`.
- `status` reads the saved daemon state instead of attaching to the browser directly. On interactive terminals it defaults to a human summary with `Summary`, `Session`, `Action Needed`, and `Next Steps` sections. Outside a TTY it defaults to JSON. Use `--quiet` for a one-line summary or `--verbose` for recent event history and extra diagnostics.
- Health monitoring is persisted per profile: daemon status (`starting`, `running`, `degraded`, `stopped`), browser/session health, current LinkedIn URL and reason, last healthy tick, last error, and consecutive failure count all remain inspectable after the daemon stops.
- Failure handling is operator-visible. Failed checks are recorded in the saved state and retried on the next scheduled interval. Once failures reach `--max-consecutive-failures`, the saved state flips to `degraded` until a later healthy check resets the counter.
- Human-readable recovery guidance points operators to the right next step for login walls, checkpoints, rate limits, profile locks, and browser or `--cdp-url` connectivity issues. `start` and `stop` also clean up stale PID files automatically; `stop` escalates from `SIGTERM` to `SIGKILL` after 5 seconds if the daemon does not exit.
- CLI defaults: `--profile default`, `--interval-seconds 300`, `--jitter-seconds 30`, and `--max-consecutive-failures 5`. Omitting `--cdp-url` keeps keepalive on a tool-owned Playwright profile; providing it attaches keepalive to an existing browser session.
- See `docs/session-keepalive-hardening-architecture.md` for the hardening design and rollout plan.

Scheduled follow-up daemon:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin scheduler start --profile default
npm exec -w @linkedin-assistant/cli -- linkedin scheduler status --profile default --jobs 10
npm exec -w @linkedin-assistant/cli -- linkedin scheduler run-once --profile default
npm exec -w @linkedin-assistant/cli -- linkedin scheduler stop --profile default
```

- The scheduler is a local CLI daemon; there is no dedicated MCP scheduler tool.
- It detects newly accepted sent invitations, queues due follow-up preparation jobs, and never auto-confirms prepared actions.
- Default behavior is to poll every 5 minutes, wait 15 minutes after acceptance, and only prepare follow-ups during local 09:00-17:00 business hours.
- Scheduler state/log files are stored under `~/.linkedin-assistant/linkedin-owa-agentools/scheduler/`.
- See `docs/scheduler.md` for quickstart steps, config details, and subsystem architecture.

Activity webhook daemon:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add --profile default --kind notifications --interval-seconds 600
npm exec -w @linkedin-assistant/cli -- linkedin activity watch list --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook add --watch <watch-id> --url https://example.com/hooks/linkedin
npm exec -w @linkedin-assistant/cli -- linkedin activity run-once --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity events --profile default --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin activity deliveries --profile default --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin activity start --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity status --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity stop --profile default
```

- The activity daemon is a local CLI daemon backed by persistent watch, event, and delivery state in SQLite.
- `run-once` has a `tick` alias when you want an immediate poll without leaving the daemon running.
- MCP exposes watch/webhook CRUD plus `linkedin.activity_poller.run_once`, but daemon lifecycle stays in the CLI.
- Activity state/log files are stored under `~/.linkedin-assistant/linkedin-owa-agentools/activity/`, and durable rows live in `~/.linkedin-assistant/linkedin-owa-agentools/state.sqlite`.
- See `docs/activity-webhooks.md` for watch targets, event types, output diagnostics, and configuration, and `docs/activity-webhooks-architecture.md` for the polling-engine and schema details.

Delete local tool state:

```bash
# Preview the shared local runtime footprint (default dry-run)
npm exec -w @linkedin-assistant/cli -- linkedin data delete

# Delete shared local runtime data after interactive confirmation
npm exec -w @linkedin-assistant/cli -- linkedin data delete --confirm

# Preview the wider wipe that also includes tool-owned browser profiles
npm exec -w @linkedin-assistant/cli -- linkedin data delete --include-profile

# Delete shared data plus tool-owned browser profiles (second confirmation)
npm exec -w @linkedin-assistant/cli -- linkedin data delete --include-profile --confirm
```

- `linkedin data delete` is a dry-run preview by default.
- The default scope is the shared local runtime footprint: `state.sqlite` and its SQLite sidecars, `artifacts/`, `keepalive/`, and the auth cooldown file.
- Rerun with `--confirm` in an interactive terminal to perform the destructive deletion.
- Answering anything other than `yes` cancels the deletion and leaves all files untouched.
- Stop any running keepalive daemons before deleting local state.
- `config.json` is preserved by design, and data from external browsers attached with `--cdp-url` is never deleted.
- `--include-profile` prompts a second time before removing tool-owned browser profiles, saved sessions, and cookies.
- If that second prompt is declined, the command still deletes the shared runtime data and preserves `profiles/`.
- If some paths cannot be removed, the command exits non-zero after deleting the paths it can and reports `failed_paths` entries with `path`, `code`, `message`, and `recoveryHint`.

### Selector audit

Selector audit is a read-only diagnostic that checks the built-in selector
registry across the LinkedIn feed, inbox, profile, connections, and
notifications pages. It is designed for CI and maintenance work: it captures
failure artifacts, reports fallback-only matches before they become hard
failures, and exits non-zero only when a selector group fails across every
strategy.

See `docs/selector-audit.md` for the full guide.

```bash
# Interactive summary with per-page progress
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default

# Machine-readable report for CI or scripts
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default --json

# Expand the human summary with selector-by-selector detail
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default --verbose

# Audit an attached logged-in browser instead of the tool-owned profile
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default --cdp-url http://127.0.0.1:18800

# Force Danish selector fallbacks with English as a safety net
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default --selector-locale da

# Show command help and doc reference
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --help
```

Representative human-readable output:

```text
Starting selector audit for profile default (2 pages).
Checking page 1/2: feed (2 selector groups)...
Finished page 1/2: feed — 1 passed, 1 failed, 1 fallback.
Checking page 2/2: inbox (1 selector groups)...
Finished page 2/2: inbox — 1 passed, 0 failed, 0 fallback.
Selector audit finished. Report: /tmp/run_test/selector-audit/report.json

Selector Audit: FAIL
Profile: default
Checked At: 2026-03-08T12:00:00.000Z
Summary: Checked 3 selector groups across 2 pages. 2 passed. 1 failed. 1 used fallback selectors.
Report JSON: /tmp/run_test/selector-audit/report.json
Artifacts: /tmp/run_test/selector-audit

Pages
- FAIL feed: 1 passed, 1 failed, 1 fallback-only
- PASS inbox: 1 passed, 0 failed, 0 fallback-only

Failures
- feed/post_composer_trigger — Feed post composer trigger
  Error: No selector strategy matched for post_composer_trigger on feed. Review the failure artifacts, update the selector registry if LinkedIn's UI changed, and rerun the selector audit.
  Artifacts: screenshot=/tmp/run_test/selector-audit/feed/post_composer_trigger.png | dom=/tmp/run_test/selector-audit/feed/post_composer_trigger.html | a11y=/tmp/run_test/selector-audit/feed/post_composer_trigger.a11y.json
  Next: Open the captured failure artifacts for post_composer_trigger on feed, update that selector group in the registry, and rerun the selector audit.
```

- Interactive terminals show per-page progress plus a human-readable summary
  with failures, fallbacks, warnings, and next steps.
- Use `--json` for machine-readable output in CI, scripts, or agent workflows.
- Use `--verbose` to expand the human-readable summary with selector-by-selector
  detail.
- Use `--no-progress` to suppress live progress updates when you only want the
  final summary.
- Reports are written under the run artifact directory as
  `selector-audit/report.json`; screenshots, DOM snapshots, and accessibility
  snapshots are captured only for failures.
- Selector audit also supports `--selector-locale <locale>` for localized UI
  text fallbacks. Region tags such as `da-DK` normalize to `da`, and
  unsupported values fall back to `en` with a warning.
- Set `LINKEDIN_ASSISTANT_SELECTOR_LOCALE` to change the default selector
  locale for the current shell.

### Live read-only validation

Live read-only validation is the Tier 2 smoke test for the production
LinkedIn UI. It uses an encrypted stored browser session, verifies only
read-only surfaces, blocks non-GET traffic during the run, and records a local
report with selector matches, failures, timings, and regressions versus the
previous run.

Examples below use the `linkedin` binary; `owa` is an equivalent alias.
See `docs/live-validation.md` for the operator guide and
`docs/live-validation-architecture.md` for the pipeline internals.

```bash
# Capture or refresh an encrypted stored session from a manual login
npm exec -w @linkedin-assistant/cli -- linkedin auth session --session smoke

# Run the smoke test interactively with per-step prompts
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke

# Keep the human-readable summary and progress output, but skip prompts
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke --yes

# Emit structured JSON for CI or scripts
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke --yes --json

# Inspect one operation from the JSON output
npm exec -w @linkedin-assistant/cli -- linkedin test live --read-only --session smoke --yes --json | jq '.operations[] | select(.operation == "notifications")'
```

- `linkedin auth session` opens a dedicated browser window, waits for a manual
  LinkedIn login, and stores Playwright session state encrypted at rest under
  the tool-owned profile directory.
- `linkedin test live --read-only` validates the feed, profile, notifications,
  messaging, and connections surfaces only.
- `--session <name>` selects the encrypted stored session created by
  `linkedin auth session`.
- Interactive TTYs default to a human-readable report plus per-step progress;
  non-interactive terminals default to JSON. `--json` forces machine-readable
  output, while `--no-progress` hides progress lines in human mode.
- There is no separate `--verbose` flag for this command; human mode already
  prints the most detailed built-in view.
- `--yes` skips per-step confirmation prompts only; it does not relax any
  read-only guardrails.
- The live validator enforces a minimum 5-second gap between steps and a
  maximum of 20 steps per session.
- The CLI always runs the fixed five-step suite in order: `feed`, `profile`,
  `notifications`, `inbox`, and `connections`. To focus on one step, filter
  the JSON report or call the Core API from a custom harness.
- Any session expiry, challenge, captcha, or unexpected redirect stops the run.
- Reports live under `LINKEDIN_ASSISTANT_HOME`, including the run-scoped
  `artifacts/<run-id>/live-readonly/report.json`, the corresponding
  `artifacts/<run-id>/events.jsonl`, and the rolling
  `artifacts/live-readonly/latest-report.json` snapshot used for regression
  diffing.
- If the stored session is missing or expired in an interactive terminal, the
  CLI prompts to refresh it via `linkedin auth session` and retries once.
- Exit codes: `0` when all steps pass, `1` when one or more steps fail
  (including partial reports after a later blocking failure), and `2` when the
  run cannot complete because of preflight, session, or runtime errors.
- Set `PLAYWRIGHT_EXECUTABLE_PATH` if Playwright cannot find Chromium on the
  current machine.

### Live write validation

Live write validation is the Tier 3 human-in-the-loop harness for confirming
that real LinkedIn write operations still work against an approved secondary
account. It uses the same stored-session capture flow as Tier 2, but it never
runs unattended, never targets a primary account, and always requires typed
confirmation before each write.

Examples below use the `linkedin` binary; `owa` is an equivalent alias.
See `docs/write-validation.md` for the full operator guide.

```bash
# Capture a stored session for the dedicated secondary account
npm exec -w @linkedin-assistant/cli -- linkedin auth session --session secondary-session

# Register the secondary account and approved write-validation targets
npm exec -w @linkedin-assistant/cli -- linkedin accounts add secondary --designation secondary --session secondary-session --profile secondary --message-thread /messaging/thread/abc123/ --message-participant-pattern "Simon Miller" --invite-profile https://www.linkedin.com/in/test-target/ --invite-note "Quick validation hello" --followup-profile https://www.linkedin.com/in/test-target/ --reaction-post https://www.linkedin.com/feed/update/urn:li:activity:123/ --reaction like --post-visibility connections

# Run the real-action harness
npm exec -w @linkedin-assistant/cli -- linkedin test live --write-validation --account secondary

# Emit the final structured report as JSON while prompts stay interactive
npm exec -w @linkedin-assistant/cli -- linkedin test live --write-validation --account secondary --json | jq '.actions[] | {action_type, status}'
```

- The CLI prints `This will perform REAL actions on LinkedIn` at startup.
- Every action is previewed individually and requires typing `yes` to proceed.
- `--yes` is rejected for this workflow; there is no batch mode.
- There is no Tier 3 `--dry-run`; rehearse safely with
  `linkedin test live --read-only --session secondary-session --yes` first.
- The harness runs the fixed five-action suite: `post.create`,
  `connections.send_invitation`, `send_message`,
  `network.followup_after_accept`, and `feed.like_post`.
- Text-entry actions (`post.create`, `send_message`, and
  `network.followup_after_accept`) use the human-like typing simulation layer
  during composition and still verify the final text if they degrade to direct
  input.
- Registered accounts live in `LINKEDIN_ASSISTANT_HOME/config.json` under
  `writeValidation.accounts`; use `linkedin accounts add` or
  `linkedin accounts:add` to manage them.
- The selected account must be marked `secondary`; accounts marked `primary`
  are hard-blocked.
- `linkedin accounts add` also supports `--force`, `--invite-note`,
  `--message-participant-pattern`, `--reaction`, and `--post-visibility`.
- `--reaction` accepts `like`, `celebrate`, `support`, `love`, `insightful`,
  or `funny`; `--post-visibility` accepts `public` or `connections`
  (default `connections`).
- Tier 3 run-time flags are `--account <id>`, `--cooldown-seconds <n>`,
  `--timeout-seconds <n>`, `--json`, and `--no-progress`.
- Reports include per-action verification, audit-log paths, cleanup guidance,
  before/after screenshot paths, and a standalone HTML review artifact.
- Blocking auth, challenge, or rate-limit failures stop the run early and the
  remaining actions are marked `cancelled` in the partial report.
- Exit codes: `0` when every action passes, `1` when one or more actions fail
  or are cancelled, and `2` when preflight, session, or runtime errors prevent
  the run from completing.
- If the stored session is stale, refresh it with
  `linkedin auth session --session secondary-session` and rerun.
- Tier 3 is CLI-only; it is intentionally not exposed as an MCP tool because it
  requires typed confirmations and a visible browser window.

### Draft quality evaluation

Draft quality evaluation is a read-only, offline harness for scoring reply
drafts against case-specific expectations for relevance, tone, length, and
forbidden phrases. It works entirely from JSON files, defaults to a
human-readable summary in interactive terminals, and can emit structured JSON
for CI, scripts, or agent workflows.

See `docs/draft-quality-evaluation.md` for the full guide, including the input
format, output semantics, core API, and CI examples.

```bash
# Human-readable summary for a dataset with embedded candidates
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality --dataset eval/dataset.json

# Add an external candidates file and expand the summary with per-draft detail
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality --dataset eval/dataset.json --candidates eval/candidates.json --verbose

# Emit machine-readable JSON and save a copy to disk
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality --dataset eval/dataset.json --candidates eval/candidates.json --json --output reports/draft-quality.json

# Show command help and usage examples
npm exec -w @linkedin-assistant/cli -- linkedin audit draft-quality --help
```

- `--dataset <path>` is required; `--candidates <path>` is optional when the
  dataset already embeds `candidate_drafts`.
- Interactive terminals show per-case progress plus a human-readable summary;
  non-interactive terminals default to JSON.
- `--verbose` adds per-draft metric detail, and `--no-progress` suppresses the
  live progress lines in human-readable mode.
- The command exits with `1` when any evaluated draft fails or when input
  validation fails.

Inbox MVP commands:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin inbox list --profile default --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin inbox show --profile default --thread <thread_id_or_url> --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin inbox prepare-reply --profile default --thread <thread_id_or_url> --text "Hi there"
```

Prepared replies, follow-ups, and posts use the same human-like typing layer at
confirm time. `linkedin login` also uses it when entering credentials.

Follow-up flow after accepted invitations:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin followups list --profile default --since 7d
npm exec -w @linkedin-assistant/cli -- linkedin followups prepare --profile default --since 7d
npm exec -w @linkedin-assistant/cli -- linkedin scheduler run-once --profile default --json
```

- `followups prepare` is the manual, operator-invoked batch workflow.
- `scheduler run-once` and `scheduler start` reuse the same prepare-only safety model, but queue work near its due time instead of preparing everything immediately.
- Successful scheduler ticks still leave follow-up work in the prepared state; nothing is sent automatically.

Profile seeding commands:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin profile editable --profile default
npm exec -w @linkedin-assistant/cli -- linkedin profile apply-spec --profile default --spec docs/profile-seeds/sample-automation-profile.json --allow-partial --yes --delay-ms 4000
```

- `profile editable` mirrors the MCP editable-profile surface in the CLI.
- `profile apply-spec` reads a JSON profile spec, prepares the necessary profile edits, confirms them one by one, and inserts paced delays between actions.
- The bundled issue-210 example spec currently needs `--allow-partial` because skills (`#228`) plus industry/custom public URL (`#252`) are still tracked as follow-up gaps.
- See `docs/profile-seeding.md` for the full workflow, bundled spec, and current blockers.

Profile image generation commands:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin assets generate-profile-images --profile default --spec docs/profile-seeds/issue-210-signikant-test-profile.json --post-count 6 --upload-profile-media --upload-delay-ms 4500 --output reports/profile-images.json
```

- `assets generate-profile-images` uses OpenAI image generation to create a cohesive profile photo, banner, and reusable post-image bundle from the seeded persona.
- Generated files and the manifest are written under `artifacts/<run-id>/linkedin-ai-assets/<persona-slug>/<timestamp>/`.
- `--upload-profile-media` reuses the existing profile photo/banner upload flow and paces the two uploads to avoid back-to-back updates.
- See `docs/profile-image-generation.md` for the end-to-end workflow and the matching MCP tool.

Confirm prepared actions by token:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin actions confirm --profile default --token ct_...
```

- Confirmation prints preview details and prompts for explicit operator approval.
- Use `--yes` to skip prompt in automation/non-interactive runs.

## MCP Usage

Tier 3 live write validation is intentionally **not** exposed as an MCP tool.
Use the CLI for that workflow so the operator can review each preview, type
`yes`, and watch the visible browser window.

Start MCP server:

```bash
npm exec -w @linkedin-assistant/mcp -- linkedin-mcp
```

Exposed tools:

- `linkedin.session.status`
- `linkedin.session.open_login`
- `linkedin.session.health`
- `linkedin.profile.view`
- `linkedin.profile.view_editable`
- `linkedin.profile.prepare_update_intro`
- `linkedin.profile.prepare_upsert_section_item`
- `linkedin.profile.prepare_remove_section_item`
- `linkedin.profile.prepare_upload_photo`
- `linkedin.profile.prepare_upload_banner`
- `linkedin.profile.prepare_featured_add`
- `linkedin.profile.prepare_featured_remove`
- `linkedin.profile.prepare_featured_reorder`
- `linkedin.assets.generate_profile_images`
- `linkedin.search`
- `linkedin.inbox.list_threads`
- `linkedin.inbox.get_thread`
- `linkedin.inbox.prepare_reply`
- `linkedin.connections.list`
- `linkedin.connections.pending`
- `linkedin.connections.invite`
- `linkedin.connections.accept`
- `linkedin.connections.withdraw`
- `linkedin.connections.prepare_ignore`
- `linkedin.connections.prepare_remove`
- `linkedin.connections.prepare_follow`
- `linkedin.connections.prepare_unfollow`
- `linkedin.members.prepare_block`
- `linkedin.members.prepare_unblock`
- `linkedin.members.prepare_report`
- `linkedin.privacy.get_settings`
- `linkedin.privacy.prepare_update_setting`
- `linkedin.feed.list`
- `linkedin.feed.view_post`
- `linkedin.feed.like`
- `linkedin.feed.comment`
- `linkedin.feed.prepare_repost`
- `linkedin.feed.prepare_share`
- `linkedin.feed.save_post`
- `linkedin.feed.unsave_post`
- `linkedin.feed.prepare_remove_reaction`
- `linkedin.post.prepare_create`
- `linkedin.notifications.list`
- `linkedin.jobs.search`
- `linkedin.jobs.view`
- `linkedin.network.prepare_followup_after_accept`
- `linkedin.actions.confirm`

No locale-specific MCP tool names were added. Instead, all runtime-backed MCP
tool inputs also accept optional `cdpUrl` and `selectorLocale` properties.
Example tool arguments:

```json
{
  "profileName": "default",
  "selectorLocale": "da-DK"
}
```

See `docs/selector-locale.md` for the full locale configuration guide and
`docs/selector-audit.md` for the CLI-only selector audit workflow.

For anti-bot evasion, MCP surfaces the resolved snapshot through
`linkedin.session.status` (`status.evasion`) and `linkedin.session.health`
(`session.evasion`). There is no `linkedin.evasion.*` tool family yet, and the
server reads evasion defaults from env vars at startup. See `docs/evasion.md`
for the full integration and troubleshooting guide.

- explicit `selectorLocale` wins over `LINKEDIN_ASSISTANT_SELECTOR_LOCALE`
- supported values are `en`, `da`, and region tags like `da-DK`
- unsupported values fall back to English with a runtime warning

Selector audit is currently a CLI-only diagnostic. When an MCP read-only tool
starts failing because LinkedIn's UI changed, run
`linkedin audit selectors --profile <profile>` and follow `docs/selector-audit.md`.
The read-only MCP tool descriptions reference this diagnostic path.

## MVP Flow

1. Prepare send:
   - `linkedin inbox prepare-reply ...`
   - captures pre-send screenshot artifact
   - stores redacted preview JSON plus hashes; sensitive target/payload fields are sealed for confirm-time restore when needed
   - returns `preparedActionId` and `confirmToken`
2. Confirm send:
   - `linkedin actions confirm --token ct_...`
   - resolves action by `confirm_token_hash`
   - executes `send_message` with target validation and human-like composer typing
   - consumes send rate limit on confirm only
   - captures post-send screenshot + Playwright trace zip

## Core Notes

- Two-phase commit stores:
  - `target_json`, `payload_json`, `preview_json`
  - optional sealed target/payload blobs when storage redaction is enabled
  - `payload_hash` and `preview_hash` (`sha256` base64url)
  - confirmation and execution metadata (`confirmed_at`, `executed_at`, result/error fields)
- Errors use structured taxonomy:
  - `AUTH_REQUIRED`, `CAPTCHA_OR_CHALLENGE`, `RATE_LIMITED`, `UI_CHANGED_SELECTOR_FAILED`, `NETWORK_ERROR`, `TIMEOUT`, `TARGET_NOT_FOUND`, `ACTION_PRECONDITION_FAILED`, `UNKNOWN`
- CLI and MCP return structured JSON errors (`code`, `message`, `details`).
- `linkedin data delete` intentionally uses a filesystem-first helper instead of booting `createCoreRuntime()` so the command does not recreate directories, logs, or `state.sqlite` while wiping local state.

## Quality Gates

Run from repo root:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

## E2E Testing

Unit tests use mocks. The E2E suite validates the CLI, MCP tools, and selected
two-phase commit flows in two modes:

- a live-session lane for authenticated LinkedIn coverage via CDP
- a fixture-backed lane that replays recorded LinkedIn HTML/HTTP fixtures locally

### Commands

```bash
# Live authenticated lane
npm run test:e2e

# Deterministic headless replay lane used by CI
npm run test:e2e:fixtures

# Show live-runner help and overrides
npm run test:e2e -- --help
```

The live runner skips cleanly when no authenticated CDP session is available.
The replay runner does not need credentials and uses `test/fixtures/manifest.json`
plus the committed `ci` fixture set.

Set `LINKEDIN_E2E_FIXTURE_SET=<name>` when you want `npm run test:e2e:fixtures`
to replay a non-default recorded set.

### Replay configuration

- `LINKEDIN_E2E_FIXTURE_MANIFEST` overrides the replay manifest path (defaults to
  `test/fixtures/manifest.json`)
- `LINKEDIN_E2E_FIXTURE_SET` selects a non-default recorded set from that
  manifest
- `LINKEDIN_E2E_FIXTURE_SERVER_URL` points the replay lane at an already
  running replay server instead of starting the local one
- `LINKEDIN_E2E_FIXTURE_FILE` and the live runner's `--fixtures` flag are a
  different feature: they cache the lightweight CLI/MCP discovery target file
  used by live contract reruns

### Fixture workflow

Record or refresh replay fixtures manually:

```bash
linkedin fixtures record --page feed --page messaging
owa fixtures:record --set da-dk --page profile,notifications --no-har
```

Custom recording example with an alternate manifest, profile, and viewport:

```bash
linkedin fixtures record \
  --profile fixtures \
  --manifest .tmp/replay-manifest.json \
  --set narrow \
  --page feed,search \
  --width 1280 \
  --height 720 \
  --no-har
```

Check fixture freshness:

```bash
linkedin fixtures check
owa fixtures:check --set ci --max-age-days 14
```

Replay fixtures are stored under `test/fixtures/`. The manifest and committed
`ci` set stay in git for deterministic CI coverage; other local fixture sets,
HAR files, and bulky response captures stay ignored by default. Sanitization is
a manual review step before you promote anything into the committed `ci` set.
Keep promoted fixture sets minimal, review captured HTML/response bodies for
sensitive data, and prefer `--no-har` unless a HAR is truly needed.

The typical loop is:

```bash
linkedin fixtures record --set manual --page feed --page messaging
linkedin fixtures check --set manual
LINKEDIN_E2E_FIXTURE_SET=manual npm run test:e2e:fixtures -- packages/core/src/__tests__/e2e/inbox.e2e.test.ts
```

The live runner's `--fixtures` flag is separate: it stores the small CLI/MCP
discovery target file used for live contract reruns, not the replay manifest.

### Replay lifecycle

1. `linkedin fixtures record` opens a persistent Playwright browser and records
   only `linkedin.com` / `licdn.com` traffic for the requested page types.
2. The recorder updates `test/fixtures/manifest.json`, `<set>/routes.json`,
   `pages/*.html`, optional `session.har`, and any captured response bodies.
3. `linkedin fixtures check` warns when a set or page is stale (30 days by
   default) before you replay it locally or in CI.
4. `npm run test:e2e:fixtures` loads the manifest, validates fixture paths and
   metadata, starts the replay server, and fulfills LinkedIn requests from the
   recorded responses while aborting unrelated network traffic.

You can also point replay at an already running server instead of the built-in
one:

```bash
LINKEDIN_E2E_FIXTURE_SERVER_URL=http://127.0.0.1:45678 \
LINKEDIN_E2E_FIXTURE_SET=manual \
npm run test:e2e:fixtures -- packages/core/src/__tests__/e2e/feed.e2e.test.ts
```

### Common replay errors

- `fixture_not_found` means the selected set is missing a recorded route for a
  LinkedIn request; re-record the affected page or choose the correct set with
  `LINKEDIN_E2E_FIXTURE_SET`.
- `Fixture manifest ... does not define any sets.` means the replay manifest is
  empty; record a set first with `linkedin fixtures record --set <name> --page
  feed`.
- `Fixture route ... duplicates replay key ...` means two routes normalize to
  the same `METHOD + URL`; keep only one entry per normalized request.
- `fixture_replay_unavailable` means the browser could not reach the local or
  external replay server; verify `LINKEDIN_E2E_FIXTURE_SERVER_URL` or rerun the
  replay lane.

### Coverage lanes

- Live and replayed runtime coverage for auth, health, feed, inbox,
  connections, profile, search, jobs, and notifications
- CLI and MCP contract suites that verify output shape, exit codes, and confirm
  entrypoints end-to-end
- Opt-in write lanes for real message, connection, like, comment, and post
  confirms guarded behind explicit environment flags
- Non-live guard rails that cover runner parsing, fixture replay, skip
  semantics, and confirm contract hardening

### Live prerequisites

- Node.js 22+
- `npm install`
- `npx playwright install chromium`
- For the live lane only: an authenticated Chromium session exposed via CDP
  (default: `http://localhost:18800`)

### Safe defaults

By default, the E2E suite only performs read-only operations, prepare-only
two-phase commit steps, or safe `test.echo` confirmations for the generic
confirm entrypoints. Real outbound confirms remain opt-in.

See `docs/e2e-testing.md` for the full workflow, the replay manifest format,
safe targets, and opt-in write flags.
