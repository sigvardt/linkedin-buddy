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
- Selector locale for UI-text fallbacks: `LINKEDIN_ASSISTANT_SELECTOR_LOCALE` (defaults to `en`; supports `en`, `da`)

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

## CLI Usage

Run commands via workspace binaries:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin status --profile default
npm exec -w @linkedin-assistant/cli -- linkedin login --profile default --timeout-minutes 10
```

Isolation note:

- Omitting `--cdp-url` uses a dedicated Playwright persistent profile owned by this tool.
- Passing `--cdp-url` attaches to an existing browser and can share session/cookie state.

Session keepalive daemon (isolated profile):

```bash
npm exec -w @linkedin-assistant/cli -- linkedin keepalive start --profile default
npm exec -w @linkedin-assistant/cli -- linkedin keepalive status --profile default
npm exec -w @linkedin-assistant/cli -- linkedin keepalive stop --profile default
```

- Keepalive state/log files are stored under `~/.linkedin-assistant/linkedin-owa-agentools/keepalive/`.

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
Checking page 2/2: inbox (1 selector group)...
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
  details.
- Use `--no-progress` to suppress live progress updates when you only want the
  final summary.
- Reports are written under the run artifact directory as
  `selector-audit/report.json`; screenshots, DOM snapshots, and accessibility
  snapshots are captured only for failures.
- Selector audit also supports `--selector-locale <locale>` for localized UI
  text fallbacks, and the default can be set with
  `LINKEDIN_ASSISTANT_SELECTOR_LOCALE`.

Inbox MVP commands:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin inbox list --profile default --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin inbox show --profile default --thread <thread_id_or_url> --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin inbox prepare-reply --profile default --thread <thread_id_or_url> --text "Hi there"
```

Follow-up flow after accepted invitations:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin followups list --profile default --since 7d
npm exec -w @linkedin-assistant/cli -- linkedin followups prepare --profile default --since 7d
```

Confirm prepared actions by token:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin actions confirm --profile default --token ct_...
```

- Confirmation prints preview details and prompts for explicit operator approval.
- Use `--yes` to skip prompt in automation/non-interactive runs.

## MCP Usage

Start MCP server:

```bash
npm exec -w @linkedin-assistant/mcp -- linkedin-mcp
```

Exposed tools:

- `linkedin.session.status`
- `linkedin.session.open_login`
- `linkedin.profile.view`
- `linkedin.search`
- `linkedin.inbox.list_threads`
- `linkedin.inbox.get_thread`
- `linkedin.inbox.prepare_reply`
- `linkedin.connections.list`
- `linkedin.connections.pending`
- `linkedin.connections.invite`
- `linkedin.connections.accept`
- `linkedin.connections.withdraw`
- `linkedin.feed.list`
- `linkedin.feed.view_post`
- `linkedin.feed.like`
- `linkedin.feed.comment`
- `linkedin.post.prepare_create`
- `linkedin.notifications.list`
- `linkedin.jobs.search`
- `linkedin.jobs.view`
- `linkedin.network.prepare_followup_after_accept`
- `linkedin.actions.confirm`

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
   - executes `send_message` with target validation
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

## Quality Gates

Run from repo root:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

## E2E Testing (Real Browser)

Unit tests use mocks. After all features are implemented, run E2E tests against a real authenticated LinkedIn session in a headless browser.

### Prerequisites

- Authenticated LinkedIn session in the openclaw browser profile (CDP port 18800)
- Or: any Chromium instance with an active LinkedIn session exposed via CDP

### E2E Test Plan

Connect the CLI to a live CDP session and exercise every feature against real LinkedIn:

```bash
# Status check (verify session is authenticated)
npm exec -w @linkedin-assistant/cli -- linkedin status --profile default --cdp-url http://localhost:18800

# Profile viewing
npm exec -w @linkedin-assistant/cli -- linkedin profile view --profile default --cdp-url http://localhost:18800
npm exec -w @linkedin-assistant/cli -- linkedin profile view --profile default --cdp-url http://localhost:18800 --user "realsimonmiller"

# Search (people, companies, jobs)
npm exec -w @linkedin-assistant/cli -- linkedin search --profile default --cdp-url http://localhost:18800 --type people --query "Simon Miller"
npm exec -w @linkedin-assistant/cli -- linkedin search --profile default --cdp-url http://localhost:18800 --type companies --query "Power International"
npm exec -w @linkedin-assistant/cli -- linkedin search --profile default --cdp-url http://localhost:18800 --type jobs --query "engineering manager"

# Connections
npm exec -w @linkedin-assistant/cli -- linkedin connections list --profile default --cdp-url http://localhost:18800 --limit 10

# Feed
npm exec -w @linkedin-assistant/cli -- linkedin feed view --profile default --cdp-url http://localhost:18800 --limit 5

# Inbox
npm exec -w @linkedin-assistant/cli -- linkedin inbox list --profile default --cdp-url http://localhost:18800 --limit 10

# Notifications (when implemented)
npm exec -w @linkedin-assistant/cli -- linkedin notifications list --profile default --cdp-url http://localhost:18800 --limit 10
```

### E2E Acceptance Criteria

- Each command returns structured JSON (not errors)
- Profile view returns real profile data (name, headline, etc.)
- Search returns real results matching the query
- Connections list returns actual connections
- Feed returns real posts
- Inbox returns real message threads
- No `AUTH_REQUIRED` or `UI_CHANGED_SELECTOR_FAILED` errors
- Screenshots/trace artifacts are captured where applicable

### Test Account

- LinkedIn account: joakim@sigvardt.eu (authenticated in openclaw browser profile)
- Safe interaction target: Simon Miller (linkedin.com/in/realsimonmiller)
- **Do not** send unsolicited messages or connection requests during E2E testing without explicit approval
