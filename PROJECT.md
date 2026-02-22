# PROJECT.md — LinkedIn Assistant

## Vision

A safety-first LinkedIn Assistant for a single personal account that automates repetitive LinkedIn tasks while keeping a human in the loop for every outbound action.

## Goals

- **Reliable browser automation** — Playwright with a dedicated persistent browser profile (manual login; no credential storage)
- **Operator CLI** — Human-facing CLI for inbox triage, drafting replies, connection management, feed engagement, and posting
- **MCP server** — High-level LinkedIn-specific tools for LLM agents (no raw click/type primitives)
- **Two-phase commit safety** — Every outbound/mutating action follows prepare → confirm. No action is sent without explicit human approval
- **Observability** — Structured JSON logs, screenshots, Playwright traces, per-run artifacts

## Non-Goals

- Multi-account or team inbox features
- CAPTCHA bypass or anti-bot stealth techniques
- Full LinkedIn feature coverage (groups, newsletters, InMail credits, ads)
- Unattended autonomous outbound activity

## Architecture

### Components

1. **Automation Core** (`packages/core`) — Playwright-based library: browser management, LinkedIn page extraction, two-phase commit, rate limiting, artifacts, SQLite state store
2. **Operator CLI** (`packages/cli`) — Commander-based CLI wrapping the core library. Binary: `linkedin`
3. **MCP Server** (`packages/mcp`) — STDIO MCP server exposing 22 LinkedIn tools. Binary: `linkedin-mcp`

### Process Model

- Single browser session per profile, enforced via file lock
- CLI and MCP share the same core library
- Browser context is persistent (`launchPersistentContext` or CDP connection)
- Can connect to existing browser via `--cdp-url` (e.g., `http://localhost:18800`)

### Tech Stack

- TypeScript (Node.js 22+), ES modules
- Playwright-core for browser automation
- SQLite (better-sqlite3) for local state
- Vitest for testing
- MCP SDK (`@modelcontextprotocol/sdk`)

## Key Decisions

### Two-Phase Commit for All Mutations
Every outbound action (send message, connect, like, comment, post) uses prepare → confirm with a `confirm_token`. Tokens expire after 30 minutes. This prevents accidental sends and gives the operator full review capability.

### Dedicated Browser Profile
The project creates and owns its own Playwright persistent context. Never attaches to the user's existing Chrome profile. Profile stored at `~/.linkedin-assistant/profiles/default/`.

### Selector Resilience Strategy
Multi-strategy selectors: primary (role-based), secondary (attribute-based), tertiary (text-based). On failure, captures screenshot + DOM snapshot + accessibility snapshot for debugging.

### Rate Limiting
Per-action token buckets persisted daily. Conservative defaults: 10 messages/day, 5 connection requests/day, 5 comments/day, 20 likes/day, 1 post/day.

### Structured Error Taxonomy
All errors use machine-readable codes: `AUTH_REQUIRED`, `CAPTCHA_OR_CHALLENGE`, `RATE_LIMITED`, `UI_CHANGED_SELECTOR_FAILED`, `NETWORK_ERROR`, `TIMEOUT`, `TARGET_NOT_FOUND`, `ACTION_PRECONDITION_FAILED`.

## Current State

### Implemented (MVP + V1)
- Auth: login, status, health check, ensureAuthenticated
- Inbox: list threads, get thread, prepare reply, confirm send message
- Connections: list, pending invitations, prepare/confirm send/accept/withdraw invitation
- Feed: list posts, view post, prepare/confirm like, prepare/confirm comment
- Profile: view (own or others)
- Search: people, companies, jobs
- Notifications: list
- Jobs: search, view
- Two-phase commit framework with token generation, expiry, and DB persistence
- Rate limiter with per-action token buckets
- Full CLI with all commands
- Full MCP server with 22 tools
- Artifacts: screenshots, traces, structured event logs
- 72 unit tests passing

### Not Yet Implemented (V2+)
See [TODO.md](./TODO.md) for the ordered roadmap.

## Constraints

- LinkedIn ToS and enforcement risk — system must be conservative
- Operator completes manual login and security challenges
- Browser profile is persistent and stored locally
- Emulate human behavior through pacing, low volume, and predictable navigation
