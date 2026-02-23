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

Inbox MVP commands:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin inbox list --profile default --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin inbox show --profile default --thread <thread_id_or_url> --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin inbox prepare-reply --profile default --thread <thread_id_or_url> --text "Hi there"
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
- `linkedin.inbox.list_threads`
- `linkedin.inbox.get_thread`
- `linkedin.inbox.prepare_reply`
- `linkedin.actions.confirm`

## MVP Flow

1. Prepare send:
   - `linkedin inbox prepare-reply ...`
   - captures pre-send screenshot artifact
   - stores prepared action with preview JSON + payload/preview hashes
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
