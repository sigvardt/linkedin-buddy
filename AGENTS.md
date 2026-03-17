# AGENTS.md — Sub-Agent Instructions

## Core Working Principle: GitHub Source of Truth

**GitHub is our source of truth.** You have all history here. Use it when you're tackling a problem:
- Search through previous issues.
- Check commits and comments to understand what was tried before.
- Maybe you've tried to fix this bug before.

Always check the repository history before starting implementation.



## Repo Overview

LinkedIn Buddy — Playwright-based browser automation for LinkedIn with CLI and MCP server.
Three surfaces (CLI, MCP, TypeScript API) share one core runtime. All write operations go through two-phase commit (prepare/confirm). Local-first: SQLite state, persistent browser profiles, structured logs, screenshots.

## Monorepo Structure

```
packages/
  core/       @linkedin-buddy/core    — automation library, DB, rate limiter, two-phase commit
  cli/        @linkedin-buddy/cli     — operator CLI (binaries: linkedin, lbud, linkedin-buddy)
  mcp/        @linkedin-buddy/mcp     — MCP stdio server (binary: linkedin-mcp)
scripts/      build, release, e2e runner, security audit, keep-alive
docs/         feature docs, architecture notes, research briefs
```

### Key Files — Core Infrastructure

| File | Purpose |
|------|---------|
| `packages/core/src/runtime.ts` | Service graph factory — wires all 25+ services via `createCoreRuntime()` |
| `packages/core/src/index.ts` | Barrel export — 54 re-exports for external consumption |
| `packages/core/src/twoPhaseCommit.ts` | Two-phase commit framework (prepare/confirm, tokens, executors, DB) |
| `packages/core/src/errors.ts` | Error taxonomy — `LinkedInBuddyError` with 9 structured codes |
| `packages/core/src/config.ts` | Configuration resolution (paths, evasion, locale, privacy, webhooks) |
| `packages/core/src/db/database.ts` | SQLite (better-sqlite3) — prepared actions, logs, artifacts, rate limits, activity |
| `packages/core/src/db/migrations.ts` | Schema migrations (6 versions) |
| `packages/core/src/rateLimiter.ts` | Per-action token bucket rate limiting |
| `packages/core/src/logging.ts` | Structured JSON event logger (`domain.operation.stage` naming) |
| `packages/core/src/artifacts.ts` | Screenshot/trace artifact management |
| `packages/core/src/profileManager.ts` | Playwright persistent context / CDP management |
| `packages/core/src/connectionPool.ts` | Browser connection pooling |
| `packages/core/src/humanize.ts` | Human-like typing simulation (typos, pauses, profiles) |
| `packages/core/src/evasion.ts` | Anti-bot evasion config and profile resolution |
| `packages/core/src/privacy.ts` | Privacy config, log redaction, JSON sealing |

### Key Files — LinkedIn Feature Services

| File | Purpose |
|------|---------|
| `packages/core/src/linkedinInbox.ts` | Inbox — list threads, view messages, send/react/archive/mute |
| `packages/core/src/linkedinFeed.ts` | Feed — list, view, like/comment/repost/share/save |
| `packages/core/src/linkedinConnections.ts` | Connections — list, send/accept/withdraw/remove/follow/unfollow |
| `packages/core/src/linkedinProfile.ts` | Profile — view + 14 edit actions (intro, sections, photos, skills) |
| `packages/core/src/linkedinSearch.ts` | Search — people, companies, jobs, posts, groups, events |
| `packages/core/src/linkedinJobs.ts` | Jobs — search, view, save/unsave, alerts, Easy Apply |
| `packages/core/src/linkedinNotifications.ts` | Notifications — list, dismiss, preference updates |
| `packages/core/src/linkedinPosts.ts` | Posts — create, edit, delete (text, media, polls) |
| `packages/core/src/linkedinPublishing.ts` | Articles and newsletters |
| `packages/core/src/linkedinFollowups.ts` | Follow-up message scheduling |
| `packages/core/src/linkedinGroups.ts` | Groups — search, view, join/leave/post |
| `packages/core/src/linkedinEvents.ts` | Events — search, view, RSVP |
| `packages/core/src/linkedinCompanyPages.ts` | Company pages — view, follow/unfollow |
| `packages/core/src/linkedinMembers.ts` | Member safety — block/unblock/report |
| `packages/core/src/linkedinPrivacySettings.ts` | Privacy settings management |
| `packages/core/src/linkedinAnalytics.ts` | Analytics — profile views, search appearances, post metrics |
| `packages/core/src/linkedinImageAssets.ts` | Persona image generation (OpenAI) |
| `packages/core/src/linkedinPage.ts` | Page navigation, waiting, selector helpers |

### Key Files — Auth, Activity & Scheduling

| File | Purpose |
|------|---------|
| `packages/core/src/auth/session.ts` | Auth service — login, status, ensureAuthenticated |
| `packages/core/src/auth/sessionStore.ts` | Session persistence and encryption |
| `packages/core/src/auth/loginSelectors.ts` | Login page selector strategies |
| `packages/core/src/auth/rateLimitState.ts` | Rate limit cooldown state management |
| `packages/core/src/activityWatches.ts` | Activity watch CRUD + webhook subscriptions |
| `packages/core/src/activityPoller.ts` | Polling engine — tick execution, event diffing, delivery |
| `packages/core/src/webhookDelivery.ts` | Webhook delivery with signing and retry |
| `packages/core/src/scheduler.ts` | Deferred job scheduling with lanes and leasing |
| `packages/core/src/keepAlive.ts` | Session keep-alive daemon |
| `packages/core/src/healthCheck.ts` | Full system health diagnostics |

### Key Files — Testing & Validation

| File | Purpose |
|------|---------|
| `packages/core/src/writeValidation.ts` | Tier 3 live write validation harness |
| `packages/core/src/liveValidation.ts` | Live read-only validation workflows |
| `packages/core/src/selectorAudit.ts` | Selector resilience auditing |
| `packages/core/src/selectorLocale.ts` | Locale-aware selectors (en/da) |
| `packages/core/src/fixtureReplay.ts` | HTTP fixture replay for deterministic testing |
| `packages/core/src/draftQualityEval.ts` | Draft content quality scoring |

### Key Files — Interface Layer

| File | Purpose |
|------|---------|
| `packages/cli/src/bin/linkedin.ts` | CLI entry point — 127+ Commander commands |
| `packages/mcp/src/bin/linkedin-mcp.ts` | MCP server — 100+ tool handlers |
| `packages/mcp/src/index.ts` | MCP tool name constants (157 exports) |

## Service Graph

`createCoreRuntime()` in `runtime.ts` wires all services:

```
Infrastructure: db → logger → artifacts → profileManager → auth → rateLimiter → twoPhaseCommit
                                                                        ↓
LinkedIn Services: inbox, feed, connections, profile, search, jobs, notifications,
                   posts, publishing, followups, groups, events, companyPages,
                   members, privacySettings, analytics, imageAssets
                                                                        ↓
Activity Layer:    activityWatches → activityPoller → webhookDelivery → scheduler
```

All services receive dependencies via constructor injection. No circular dependencies.

## Build & Test

```bash
npm install                        # Install dependencies
npx playwright install chromium    # Install browser
npm run build                      # TypeScript → dist/ (tsc -b)
npm test                           # Unit tests (Vitest, 120+ test files)
npm run typecheck                  # Type check (tsc -b --force)
npm run lint                       # ESLint (flat config, strict TypeScript)
npm run test:e2e                   # E2E tests (requires CDP + auth session)
npm run test:e2e:fixtures          # E2E with fixture replay
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

- **Language:** TypeScript strict mode, ES modules (`"type": "module"`), Node 22+
- **Imports:** Use `.js` extension in import paths (TypeScript ESM convention)
- **Exports:** All core modules re-exported via `packages/core/src/index.ts`
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/classes, `SCREAMING_SNAKE` for constants
- **Error handling:** Use `LinkedInBuddyError` with structured error codes — never raw `throw new Error()`
- **Logging:** `runtime.logger.log(level, "domain.operation.stage", details)` — structured JSON events
- **Artifacts:** `runtime.artifacts` for screenshots and traces — relative paths under run directory
- **Tests:** Vitest. Unit tests in `__tests__/`. E2E tests in `__tests__/e2e/`
- **Linting:** ESLint flat config — `no-explicit-any` is an error. No Prettier.
- **Feed comment tone for testing:** Short, subtle, kind comments relating to post content. Never mention tests, bots, automation.

### Two-Phase Commit Pattern (MANDATORY for all write operations)

Every outbound action must:
1. Have a `prepare*` method that stores action in DB and returns confirm token
2. Have an `ActionExecutor` class implementing `execute()`
3. Create a `create*ActionExecutors()` factory function
4. Register the executor in `runtime.ts`

```
prepare*() → PreparedAction in DB → { preparedActionId, confirmToken, preview }
           ↓
confirm(token) → validate token + expiry → ActionExecutor.execute() → record result
```

Token TTL: 30 minutes. Tokens are HMAC-SHA256 sealed JSON with entropy.

### Error Codes

| Code | Meaning |
|------|---------|
| `AUTH_REQUIRED` | Session expired or not authenticated |
| `CAPTCHA_OR_CHALLENGE` | LinkedIn challenge/checkpoint detected |
| `RATE_LIMITED` | Action rate-limited in current window |
| `UI_CHANGED_SELECTOR_FAILED` | Selector no longer matches LinkedIn UI |
| `NETWORK_ERROR` | Network/connectivity failure |
| `TIMEOUT` | Operation exceeded timeout |
| `TARGET_NOT_FOUND` | Target entity not found |
| `ACTION_PRECONDITION_FAILED` | Precondition check failed |
| `UNKNOWN` | Fallback for unmapped errors |

### Selector Strategy

Use multi-strategy selectors with `SelectorCandidate` pattern:
1. **role** (most stable) → 2. **attribute** → 3. **text** (fragile) → 4. **xpath** (last resort)

Locale support: `selectorLocale.ts` maps UI phrases for `en` and `da`.

### Rate Limiting

Token bucket per action. `rateLimiter.consume()` before writes; `rateLimiter.peek()` for previews.
State persisted in SQLite `rate_limit_counter` table.

## Database Schema

| Table | Purpose |
|-------|---------|
| `prepared_action` | Two-phase commit state (action, token, status, result) |
| `rate_limit_counter` | Token bucket counters per action |
| `run_log` | Structured event logs |
| `artifact_index` | Screenshot/trace metadata |
| `scheduler_job` | Deferred job queue with lanes |
| `activity_watch` | Watch definitions (kind, schedule, polling interval) |
| `activity_entity_state` | Entity snapshots for diff detection |
| `activity_event` | Emitted activity events |
| `webhook_subscription` | Webhook targets (URL, signing secret) |
| `webhook_delivery_attempt` | Delivery history and retry state |

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
   - Register executors via `twoPhaseCommit.registerExecutors()`
   - Expose on runtime object
4. Add CLI commands in `packages/cli/src/bin/linkedin.ts`
5. Add MCP tools in `packages/mcp/src/bin/linkedin-mcp.ts` + constants in `packages/mcp/src/index.ts`
6. Add unit tests and E2E tests

### Evasion & Humanization

Anti-bot evasion levels: `off` → `light` → `moderate` (default) → `aggressive`
Humanize typing profiles: `careful` (slow, realistic) → `casual` (balanced) → `fast` (testing)
Config via `--evasion-level` flag, `LINKEDIN_BUDDY_EVASION_LEVEL` env, or runtime options.
See `packages/core/src/evasion/` for Bezier mouse paths, Poisson intervals, fingerprint hardening.

### Activity Polling & Webhooks

Watches poll LinkedIn at configurable intervals. Events detected via entity snapshot diffing.
Webhook subscriptions receive signed HTTP POST with retry logic.
`activity run-once` executes one polling tick; `scheduler start` runs continuous daemon.

## E2E Testing Safety Rules

**Outbound actions against real LinkedIn are restricted:**

- **Messages:** Only send to Simon Miller (`linkedin.com/in/realsimonmiller`). No other recipients without explicit approval from Joakim.
- **Connection requests:** Only to Simon Miller unless explicitly approved.
- **Comments, likes, posts, and other public actions:** Ask Joakim for approval before executing. Describe what you plan to test and on which target, and wait for confirmation.
- **Read-only operations** (profile view, search, inbox list, feed view, notifications) are unrestricted.

Violating these rules risks real social interactions on Joakim's LinkedIn account.

## CI/CD

**GitHub Actions:**
- `ci.yml` — Lint, typecheck, unit tests, fixture E2E, build (on push/PR)
- `release.yml` — Calver versioning, npm publish, GitHub release (daily/manual)
- `secret-scan.yml` — Gitleaks history + tracked-file audit
- `ai-auto-rebase.yml` — Auto-rebase conflicting AI PRs
- `ai-ci-recovery.yml` — Re-label failed AI branches for retry

## Branch Naming

`issue-<number>-<short-description>` (e.g., `issue-2-post-composer`)

## Commit Messages

- `feat #N: description` for new features
- `fix #N: description` for bug fixes
- `chore: description` for maintenance

## Agent Orchestrator (ao) Session

You are running inside an Agent Orchestrator managed workspace.
Session metadata is updated automatically via shell wrappers.

If automatic updates fail, you can manually update metadata:
```bash
~/.ao/bin/ao-metadata-helper.sh  # sourced automatically
# Then call: update_ao_metadata <key> <value>
```
