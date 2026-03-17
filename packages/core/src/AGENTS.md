# packages/core/src — Core Automation Library

## Module Categories

### Feature Services (`linkedin*.ts`)
Each follows the same pattern: TypeScript interfaces + service class + `prepare*()` for writes + `ActionExecutor` classes + factory function.

| Module | Lines | Executors | Key Complexity |
|--------|-------|-----------|----------------|
| `linkedinProfile.ts` | 9,564 | 14 (intro, sections, photos, skills, etc.) | Largest service; multi-step profile editing |
| `linkedinPosts.ts` | 5,905 | 3 (create, edit, delete) | Media handling, safety linting, async generators |
| `linkedinInbox.ts` | 4,287 | 5 (send, react, archive, mute, add recipients) | Thread state management, SelectorCandidate pattern |
| `linkedinFeed.ts` | 4,190 | 7 (like, comment, repost, share, save, unsave, remove) | Heavy selector fallback strategy |
| `linkedinJobs.ts` | 3,821 | 4 (save, unsave, apply, alert) | Complex form filling for Easy Apply |
| `linkedinPublishing.ts` | 2,977 | 2 (create article, publish newsletter) | Rich text composition |
| `linkedinConnections.ts` | 2,780 | 8 (send, accept, withdraw, ignore, remove, follow, unfollow) | Full relationship lifecycle |

### Infrastructure
- `runtime.ts` — Service graph factory (546 lines). **Central wiring point** — modify here to add services.
- `twoPhaseCommit.ts` — Prepare/confirm framework (685 lines). Security-critical: token sealing, expiry, DB persistence.
- `config.ts` — Config resolution (1,297 lines, 53 exports). Paths, evasion, locale, privacy, webhooks.
- `db/database.ts` — SQLite abstraction (2,615 lines, 50 exports). All persistent state lives here.
- `rateLimiter.ts` — Token bucket. `peek()` for preview, `consume()` for enforcement.
- `logging.ts` — JSON event logger. Events: `domain.operation.stage` (e.g., `inbox.send_message.start`).

### Browser Management
- `profileManager.ts` — Playwright persistent context + CDP attachment. Profile locking prevents concurrent access.
- `connectionPool.ts` — Browser connection pooling and lifecycle.
- `linkedinPage.ts` — Page navigation, waiting strategies, selector helpers. Uses async generators.

### Humanization & Evasion
- `humanize.ts` — Typing simulation (277 lines). Grapheme-level control, Intl.Segmenter for Unicode.
- `evasion/` — Anti-bot subsystem (see `evasion/AGENTS.md`).

### Activity & Scheduling
- `activityPoller.ts` — Polling tick execution, entity diffing, webhook fan-out (1,696 lines).
- `activityWatches.ts` — Watch CRUD, subscription management.
- `webhookDelivery.ts` — HTTP POST with HMAC signing, retry with backoff.
- `scheduler.ts` — Job queue with lanes, leasing, and deferred execution.

## Where to Look

| Task | Start Here |
|------|------------|
| Add new LinkedIn feature | `runtime.ts` → existing `linkedin*.ts` for pattern |
| Add new write action | `twoPhaseCommit.ts` → existing executor in any `linkedin*.ts` |
| Change DB schema | `db/migrations.ts` → `db/database.ts` |
| Fix selector failure | Failing `linkedin*.ts` → `selectorLocale.ts` for locale phrases |
| Debug auth issues | `auth/session.ts` → `auth/rateLimitState.ts` |
| Modify rate limits | `rateLimiter.ts` → rate limit configs in the relevant `linkedin*.ts` |
| Change typing behavior | `humanize.ts` (profiles at top of file) |
| Adjust evasion | `evasion/profiles.ts` → `evasion/browser.ts` or `evasion/session.ts` |

## Conventions (this directory only)

- Every `linkedin*.ts` must export: interfaces, service class, executor classes, factory function
- Service constructors take a runtime-like object — never import services directly from each other
- `SelectorCandidate[]` arrays: define in priority order (role → attribute → text → xpath)
- All page interactions go through `humanize()` wrapper for typing, or `evasion` for mouse/scroll
- DB queries use prepared statements — never raw string interpolation


## Core Principle

**GitHub is our source of truth.** Always check issue history, commits, and comments before starting implementation.
