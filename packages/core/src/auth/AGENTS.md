# packages/core/src/auth — Authentication & Session Management

## Files

| File | Purpose |
|------|---------|
| `session.ts` | Main auth service: `login()`, `status()`, `ensureAuthenticated()`, `openLogin()`, `headlessLogin()` |
| `sessionStore.ts` | Session persistence and encryption. Stores/loads session state from disk. |
| `sessionInspection.ts` | Session diagnostics and health probes |
| `loginSelectors.ts` | Login page selector strategies (email field, password field, submit button) |
| `rateLimitState.ts` | Rate limit cooldown state — persisted to `rate-limit-state.json`, checked before operations |
| `identityCache.ts` | Caches identity resolution results for sub-second identity checks |
| `whoami.ts` | Fast identity extraction from cookies/DOM using cached hints |
| `fingerprint.ts` | Browser fingerprinting utilities |
| `sessionHealthCheck.ts` | Additional checks for session validity |

## Auth Flow

```
openLogin()          → Opens browser, waits for manual login, polls for auth cookies
headlessLogin()      → Enters email/password programmatically, handles MFA, detects checkpoints
status()             → Navigates to LinkedIn, inspects cookies/DOM → returns SessionStatus
ensureAuthenticated()→ Calls status(), re-authenticates if session expired
```

## Session Status Fields

- `authenticated` — boolean
- `identity` — name, headline, profile URL (if authenticated)
- `rateLimitActive` / `rateLimitUntil` — cooldown state
- `checkpointDetected` — LinkedIn security challenge
- `loginWallDetected` — login wall blocking access
- `sessionCookiePresent` — JSESSIONID cookie exists

## Anti-Patterns

- NEVER skip `ensureAuthenticated()` before page operations
- NEVER ignore `rateLimitActive` — respect cooldown expiry in `rateLimitState.ts`
- NEVER hardcode login selectors — use `loginSelectors.ts` with SelectorCandidate pattern
- Headless login supports `retryOnRateLimit` with exponential backoff — use it

## Rate Limit Cooldown

When LinkedIn returns HTTP 429/999 or a checkpoint URL:
1. `rateLimitState.ts` records expiry timestamp
2. All subsequent operations check cooldown before proceeding
3. `keepAlive.ts` monitors and alerts on cooldown state


## Core Principle

**GitHub is our source of truth.** Always check issue history, commits, and comments before starting implementation.
