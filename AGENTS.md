# AGENTS.md — Sub-Agent Instructions

## Repo Overview

LinkedIn Assistant — Playwright-based browser automation for LinkedIn with CLI and MCP server.

## Monorepo Structure

```
packages/
  core/       @linkedin-assistant/core    — automation library, DB, rate limiter, two-phase commit
  cli/        @linkedin-assistant/cli     — operator CLI (binary: linkedin)
  mcp/        @linkedin-assistant/mcp     — MCP stdio server (binary: linkedin-mcp)
scripts/      integration test scripts
```

### Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/runtime.ts` | Creates the core service graph (all services wired together) |
| `packages/core/src/twoPhaseCommit.ts` | Two-phase commit framework (prepare/confirm, tokens, DB) |
| `packages/core/src/linkedinInbox.ts` | Inbox extraction + send_message executor |
| `packages/core/src/linkedinConnections.ts` | Connection management + send/accept/withdraw executors |
| `packages/core/src/linkedinFeed.ts` | Feed extraction + like/comment executors |
| `packages/core/src/linkedinProfile.ts` | Profile viewing |
| `packages/core/src/linkedinSearch.ts` | Search (people, companies, jobs) |
| `packages/core/src/linkedinJobs.ts` | Job search and view |
| `packages/core/src/linkedinNotifications.ts` | Notifications listing |
| `packages/core/src/auth/session.ts` | Auth service (login, status, ensureAuthenticated) |
| `packages/core/src/profileManager.ts` | Playwright persistent context / CDP management |
| `packages/core/src/connectionPool.ts` | Browser connection pooling |
| `packages/core/src/rateLimiter.ts` | Per-action token bucket rate limiting |
| `packages/core/src/artifacts.ts` | Screenshot/trace artifact management |
| `packages/core/src/db/database.ts` | SQLite database (better-sqlite3) |
| `packages/core/src/db/migrations.ts` | DB schema migrations |
| `packages/core/src/errors.ts` | Structured error taxonomy |
| `packages/core/src/humanize.ts` | Human-like delays and pacing |
| `packages/core/src/logging.ts` | Structured JSON event logger |
| `packages/core/src/config.ts` | Configuration |
| `packages/cli/src/bin/linkedin.ts` | CLI entry point (Commander-based) |
| `packages/mcp/src/bin/linkedin-mcp.ts` | MCP server entry point |
| `packages/mcp/src/index.ts` | MCP tool name constants |

## Build & Test

```bash
# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Build (TypeScript → dist/)
npm run build

# Run unit tests (72 tests)
npm test

# Type check
npm run typecheck

# Lint
npm run lint

# E2E tests (requires authenticated LinkedIn session on CDP port 18800)
npm run test:e2e
```

## Quality Gates

Before submitting any PR, ensure all pass:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Code Conventions

- **Language:** TypeScript, ES modules (`"type": "module"`)
- **Node version:** 22+
- **Imports:** Use `.js` extension in import paths (TypeScript ESM convention)
- **Exports:** All core modules re-exported via `packages/core/src/index.ts`
- **Error handling:** Use `LinkedInAssistantError` with structured error codes
- **Two-phase commit pattern:** Every outbound action must:
  1. Have a `prepare*` method that stores action in DB and returns confirm token
  2. Have an `ActionExecutor` class that implements the `execute` method
  3. Register the executor in the runtime (`packages/core/src/runtime.ts`)
- **Selector strategy:** Use multi-strategy selectors (role → attribute → text). See `SelectorCandidate` pattern in `linkedinInbox.ts`
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/classes, `SCREAMING_SNAKE` for constants
- **Tests:** Vitest. Unit tests in `packages/core/src/__tests__/`. E2E tests in `packages/core/src/__tests__/e2e/`
- **Logging:** Use `runtime.logger.log(level, event, details)` — structured JSON events
- **Artifacts:** Use `runtime.artifacts` for screenshots and traces. Relative paths under run directory.
- **Feed comment tone for testing:** When testing comment flows, use short, subtle, kind comments that relate directly to the post content. Avoid mentioning tests, bots, automation, or synthetic language.

## Architecture Patterns

### Adding a New LinkedIn Feature

1. Create `packages/core/src/linkedinFeature.ts` with:
   - TypeScript interfaces for inputs/outputs
   - Service class with read-only methods and `prepare*` methods for mutations
   - `ActionExecutor` class(es) for confirm flows
   - `createFeatureActionExecutors()` factory function
2. Export from `packages/core/src/index.ts`
3. Wire into `packages/core/src/runtime.ts`:
   - Create service instance
   - Register executors
   - Expose on runtime object
4. Add CLI commands in `packages/cli/src/bin/linkedin.ts`
5. Add MCP tools in `packages/mcp/src/bin/linkedin-mcp.ts` + constants in `packages/mcp/src/index.ts`
6. Add unit tests and E2E tests

### Two-Phase Commit Flow

```
prepare*() → stores PreparedAction in DB → returns { preparedActionId, confirmToken, preview }
           ↓
confirm(token) → validates token + expiry → calls ActionExecutor.execute() → records result
```

## E2E Testing Safety Rules

**Outbound actions against real LinkedIn are restricted:**

- **Messages:** Only send to Simon Miller (`linkedin.com/in/realsimonmiller`). No other recipients without explicit approval from Joakim.
- **Connection requests:** Only to Simon Miller unless explicitly approved.
- **Comments, likes, posts, and other public actions:** Ask Joakim for approval before executing. Describe what you plan to test and on which target, and wait for confirmation.
- **Read-only operations** (profile view, search, inbox list, feed view, notifications) are unrestricted.

Violating these rules risks real social interactions on Joakim's LinkedIn account.

## Branch Naming

`issue-<number>-<short-description>` (e.g., `issue-2-post-composer`)

## Commit Messages

- `feat #N: description` for new features
- `fix #N: description` for bug fixes
- `chore: description` for maintenance
