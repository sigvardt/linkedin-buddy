# linkedin-owa-agentools

LinkedIn automation scaffold with a shared TypeScript core, a local CLI, and an MCP stdio server.

## Monorepo Layout

- `packages/core`: runtime foundation (paths/config, run IDs, JSONL event logs, artifacts, SQLite, two-phase commit, rate limiting, Playwright profile/auth helpers).
- `packages/cli`: `linkedin` binary (`login`, `status`) using the core package.
- `packages/mcp`: `linkedin-mcp` stdio server exposing MCP tools:
  - `linkedin.session.status`
  - `linkedin.session.open_login`

## Architecture Rationale

- Shared stateful behavior lives in `@linkedin-assistant/core` so CLI and MCP stay thin and consistent.
- Runtime writes deterministic run artifacts under `~/.linkedin-assistant/artifacts/<run_id>/` including `events.jsonl`.
- SQLite (`better-sqlite3`) centralizes durable state and migrations in one place.
- Browser profile access is protected by `proper-lockfile` to avoid concurrent profile corruption.
- `playwright-core` is used intentionally to keep browser binaries decoupled from package install size.

## Requirements

- Node.js 22+
- npm 10+

## Setup

```bash
npm install
```

`playwright-core` does **not** download browsers automatically. Install Chromium separately:

```bash
npx playwright install chromium
```

If needed, set a custom executable path:

```bash
export PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome-or-chromium
```

## Usage

### CLI

Build first:

```bash
npm run build
```

Check authentication status:

```bash
npx linkedin status
```

Open login flow with persistent profile:

```bash
npx linkedin login --profile default --timeout-minutes 10
```

### MCP Stdio Server

```bash
npx linkedin-mcp
```

Available tools:

- `linkedin.session.status`
- `linkedin.session.open_login`

Example tool arguments:

- `linkedin.session.status`: `{ "profileName": "default" }`
- `linkedin.session.open_login`: `{ "profileName": "default", "timeoutMs": 600000 }`

## Core Behavior Summary

- Config base directory: `~/.linkedin-assistant`
- Run IDs: generated per runtime/session
- JSON event logs: `artifacts/<run_id>/events.jsonl`
- Artifact helpers: safe per-run file writing + optional `artifact_index` DB indexing
- SQLite migrations + schema tables:
  - `account`
  - `prepared_action`
  - `run_log`
  - `artifact_index`
  - `rate_limit_counter`
- Two-phase commit framework:
  - confirm token format: `ct_<base64url>`
  - only token hash is persisted
  - default expiry: 30 minutes
  - prepare + confirm execution stub
- Profile manager:
  - lock-protected profile directories
  - persistent Playwright `userDataDir`
- Auth helpers:
  - `status` / `ensureAuthenticated`
  - `openLogin`
  - minimal practical LinkedIn page heuristics

## Quality Gates

Run locally:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI (`.github/workflows/ci.yml`) runs lint + typecheck + test with:

- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
