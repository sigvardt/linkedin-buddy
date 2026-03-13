# packages/core/src/__tests__/e2e — E2E Tests (SAFETY-CRITICAL)

## SAFETY RULES (READ BEFORE RUNNING)

**These tests run against REAL LinkedIn on Joakim's account.**

| Action | Rule |
|--------|------|
| **Messages** | ONLY to Simon Miller (`linkedin.com/in/realsimonmiller`) |
| **Connection requests** | ONLY to Simon Miller |
| **Comments, likes, posts** | Ask Joakim for approval FIRST — describe target + action |
| **Read-only** (profile, search, inbox list, feed, notifications) | Unrestricted |

**Violating these rules risks real social interactions on Joakim's LinkedIn account.**

## Prerequisites

1. Authenticated LinkedIn session on CDP port 18800
2. `npm run build` completed
3. CDP endpoint accessible: `http://localhost:18800`

## Running

```bash
npm run test:e2e                  # Full suite via runner (CDP check + auth verify)
npm run test:e2e:fixtures         # Fixture replay lane (deterministic, no live LinkedIn)
npm run test:e2e:raw              # Direct Vitest without runner checks
```

## Test Structure

| File | Type | Safety |
|------|------|--------|
| `auth.e2e.test.ts` | Read | Unrestricted |
| `profile.e2e.test.ts` | Read | Unrestricted |
| `search.e2e.test.ts` | Read | Unrestricted |
| `jobs.e2e.test.ts` | Read | Unrestricted |
| `inbox.e2e.test.ts` | Read | Unrestricted |
| `feed.e2e.test.ts` | Read | Unrestricted |
| `connections.e2e.test.ts` | Read | Unrestricted |
| `notifications.e2e.test.ts` | Read | Unrestricted |
| `health.e2e.test.ts` | Read | Unrestricted |
| `analytics.e2e.test.ts` | Read | Unrestricted |
| `inbox-write.e2e.test.ts` | Write | Simon Miller ONLY |
| `connections-write.e2e.test.ts` | Write | Simon Miller ONLY |
| `feed-like.e2e.test.ts` | Write | Requires approval |
| `feed-engagement.e2e.test.ts` | Write | Requires approval |
| `feed-write.e2e.test.ts` | Write | Requires approval |
| `post-write.e2e.test.ts` | Write | Requires approval |

## Write Confirm Opt-In

Write E2E tests only execute confirms when explicitly enabled via environment variables:

```bash
LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM=true     # inbox-write
LINKEDIN_E2E_ENABLE_CONNECTION_CONFIRM=true   # connections-write
LINKEDIN_E2E_ENABLE_LIKE_CONFIRM=true         # feed-like
LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM=true      # feed-engagement
LINKEDIN_ENABLE_POST_WRITE_E2E=true           # post-write
```

Without these flags, write tests only execute prepare (no confirm).

## Fixture Replay

- `fixtureReplay.ts` intercepts HTTP responses for deterministic replay
- Manifest: `test/fixtures/manifest.json`
- Set `LINKEDIN_E2E_FIXTURE_FILE` to a fixture path for cached discovery
- Set `LINKEDIN_E2E_REFRESH_FIXTURES=true` to re-discover live targets

## Adding E2E Tests

1. Create `<feature>.e2e.test.ts` in this directory
2. Use `setup.ts` helpers for runtime creation and CDP connection
3. For read tests: call service methods, assert response structure
4. For write tests: ONLY call `prepare*()` unless confirm opt-in flag is set
5. Always clean up: close runtime in `afterAll()`
