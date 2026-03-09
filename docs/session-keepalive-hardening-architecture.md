# Session keep-alive hardening architecture

Issue #160 is the research and design phase for parent issue #133. The goal is
not to add automatic re-login. The goal is to make the existing LinkedIn
session model more durable, easier to diagnose, and less likely to fall off a
cliff into a login wall or challenge.

This document focuses on five areas:

- proactive cookie refresh
- cookie persistence and restore strategy
- activity simulation improvements
- CDP/session resilience
- monitoring, alerting, and test strategy

## Goals

- Minimize re-login frequency for tool-owned profiles without hiding hard auth
  failures from the operator.
- Detect session degradation before the browser is fully logged out.
- Keep the keep-alive lane read-only and low risk.
- Reuse current runtime primitives where possible instead of inventing a second
  browser orchestration stack.
- Make session health observable enough that operators and future automation can
  distinguish cookie expiry, login walls, pool disconnects, and normal drift.

## Non-goals

- Automatic credentialed login or MFA bypass.
- Writing cookies into third-party browsers attached via `--cdp-url`.
- Expanding keep-alive into a mutation runner.
- Treating every cookie change as a failure.

## Current state in the codebase

### Keep-alive runtime shape today

The repo currently has two keep-alive implementations:

- `packages/core/src/keepAlive.ts` contains `SessionKeepAliveService`, which can
  run periodic health checks, attempt reconnects, refresh the session by
  navigating to `/feed`, and occasionally simulate light activity.
- `packages/cli/src/bin/linkedin.ts` owns the production keepalive daemon loop,
  persists JSON state under `keepalive/*.state.json`, and appends event logs
  under `keepalive/*.events.jsonl`.

The important architectural gap is that the CLI daemon does **not** currently
reuse `SessionKeepAliveService`. The daemon performs its own `runtime.healthCheck()`
loop and state transitions, while the core service is effectively test-only.
That duplication makes it harder to evolve refresh logic, resilience behavior,
telemetry, and future session hardening in one place.

### Health checks are reactive and navigation-heavy

`packages/core/src/healthCheck.ts` and `packages/core/src/auth/session.ts` both
rely on navigating to `https://www.linkedin.com/feed/` and then calling
`inspectLinkedInSession()`.

That has a few drawbacks:

- every health probe mutates navigation state
- every probe depends on feed availability, not just session validity
- the system mostly reacts **after** auth is already degraded
- there is no first-class notion of “session is still authenticated, but key
  cookies are aging out or rotating unusually fast”

### Session persistence exists, but it is isolated

`packages/core/src/auth/sessionStore.ts` already provides a strong encrypted
storage model for Playwright `storageState` snapshots:

- state is encrypted with AES-GCM at rest
- metadata captures whether `li_at` exists and when it expires
- live validation and write validation already know how to restore a fresh
  browser context from the snapshot

However, that stored-session system is not part of the keepalive path for normal
profile-based usage:

- isolated profiles rely on the Chromium user-data directory managed by
  `ProfileManager`
- keepalive does not persist post-refresh cookie snapshots
- only `li_at` expiry is tracked in metadata today
- there is no snapshot lineage, drift report, or restore policy for recovery

### Login-wall detection is useful but still too binary

`packages/core/src/auth/sessionInspection.ts` detects several important states:

- login pages such as `/login`, `/authwall`, and `signup/cold-join`
- checkpoint/challenge routes such as `/checkpoint`, `/challenge`, and the
  `challenge_global_internal_error` rate-limit path
- login and checkpoint forms in the DOM
- authenticated affordances such as `nav.global-nav`, the “Me” profile menu,
  or the presence of the `li_at` cookie

This is a good baseline, but it is still binary: authenticated or not. For
keep-alive hardening we need a richer state model that can distinguish:

- authenticated and healthy
- authenticated but degraded
- login wall likely
- challenge/checkpoint likely
- browser connected but page unresponsive
- browser disconnected

### CDP pooling is intentionally small

`packages/core/src/connectionPool.ts` keeps one CDP browser per URL with a ref
count and idle timeout. That is good for simplicity, but it currently does not
model:

- per-connection health history
- reconnect backoff or circuit breaking
- context/page viability beyond `browser.isConnected()`
- stale page replacement
- structured disconnect reasons

For issue #133, the pool should stay small, but it needs to become more
health-aware.

## Cookie lifecycle analysis

The current codebase already treats `li_at` as the key authenticated-session
cookie, which is correct. LinkedIn’s official cookie table also gives enough
information to separate long-lived identity cookies from short-lived routing and
session cookies.

### Cookie classes that matter most

| Cookie | Current role in this repo | Official lifetime | Hardening interpretation |
| --- | --- | --- | --- |
| `li_at` | Primary authenticated session signal. `sessionInspection` and `sessionStore` both key off it. | 1 year | Treat as the primary auth cookie. Missing value, sudden expiry collapse, or repeated invalidation should drive operator-visible warnings and refresh attempts. |
| `JSESSIONID` | Not explicitly modeled today, but important for CSRF/session request flows. | Session | Treat as volatile. Capture and restore it, but never use it as the sole authenticated signal. |
| `lidc` | Not modeled today. | 24 hours | Treat as routing-only churn. Useful for drift visibility, not for auth success/failure. |
| `liap` | Not modeled today. | 1 year | Treat as a secondary logged-in-status hint for non-`www` surfaces. Presence matters more than value stability. |
| `bcookie` | Not modeled today. | 1 year | Treat as browser identity continuity. Missing or rotating values can correlate with re-verification risk, but should not be a hard auth failure. |
| `bscookie` | Not modeled today. | 2 years | Treat as a long-lived secure browser/security cookie. Preserve and observe, but do not block on routine churn alone. |
| `li_gc` | Not modeled today. | 6 months | Treat as low-risk consent state. Preserve in snapshots, but do not use for health decisions. |

### What this means in practice

1. **Only `li_at` should be a hard auth cookie.** The current code is directionally
   right to look for it first.
2. **Session-scoped cookies should be expected to churn.** `JSESSIONID` can change
   without meaning the account is logged out.
3. **Routing cookies should not trigger recovery on their own.** A new `lidc`
   value is normal.
4. **Long-lived browser identity cookies matter for continuity, not immediate
   auth truth.** `bcookie`, `bscookie`, and `liap` should be included in
   snapshots and telemetry.
5. **Cookie value churn should be classified, not treated as failure.** The
   system should compare cookie presence, expiry bucket, and class, not raw
   cookie values in logs.

### Proposed cookie metadata model

Extend session metadata beyond the current `liAtCookieExpiresAt` field to record
sanitized, non-secret facts for key cookies:

```ts
interface SessionCookieSnapshotMetadata {
  capturedAt: string;
  source: "persistent_profile" | "stored_snapshot" | "cdp_observation";
  authenticatedCookiePresent: boolean;
  loginWallDetected: boolean;
  challengeDetected: boolean;
  cookies: Array<{
    name: string;
    class: "auth" | "csrf" | "routing" | "browser_identity" | "consent" | "other";
    present: boolean;
    expiresAt: string | null;
    expiresInHours: number | null;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
  }>;
}
```

This keeps secrets out of logs while giving the keepalive layer enough context
to answer:

- is the auth cookie still present?
- is expiry approaching?
- are only routing cookies churning?
- did the session disappear after a disconnect, or after a normal page refresh?

## Proposed target architecture

The hardened design should make `packages/core` the source of truth for session
health and keepalive orchestration, with the CLI remaining a thin daemon and
reporting layer.

### Core components

#### 1) `SessionHealthService`

Create a core session-health service that combines:

- browser connectivity status
- page responsiveness
- session inspection result
- cookie snapshot classification
- recent failure history

This service should replace the current “health = navigate to feed and check one
boolean” approach with a richer result:

```ts
interface SessionHealthReport {
  checkedAt: string;
  browser: {
    connected: boolean;
    pageResponsive: boolean;
    reconnectRecommended: boolean;
  };
  session: {
    state:
      | "healthy"
      | "degraded"
      | "login_wall"
      | "challenge"
      | "logged_out"
      | "unknown";
    currentUrl: string;
    reason: string;
  };
  cookies: {
    authCookiePresent: boolean;
    authCookieExpiresAt: string | null;
    authCookieExpiryBucket: "missing" | "lt_24h" | "lt_72h" | "lt_14d" | "ok";
    driftClass: "none" | "routing_only" | "session_only" | "auth_related";
  };
}
```

#### 2) `SessionSnapshotStore`

Evolve the existing encrypted `LinkedInSessionStore` into a reusable snapshot
layer for keepalive and diagnostics.

Recommended behavior:

- capture a sanitized metadata snapshot on daemon startup
- capture again after successful refresh activity
- capture before shutdown when possible
- retain a small rolling history, for example the latest 5 snapshots per
  profile/session
- keep the existing encrypted storage model
- support **read-only** inspection of snapshot metadata without decrypting full
  cookie values in normal status paths

Important boundary:

- tool-owned isolated profiles may save snapshots automatically
- `--cdp-url` attached browsers should only be observed by default, not
  rewritten or repaired automatically

#### 3) `SessionActivityPlanner`

Replace “always go to `/feed`” with a small planner that rotates through safe,
read-only surfaces.

Candidate read-only actions:

- open `/feed/`
- open `/notifications/`
- open `/messaging/`
- open `/mynetwork/`
- open `/in/<me>/`
- light scroll and idle on an already-open authenticated page

The planner should choose the next action based on:

- last successful action type
- current page URL
- time of day
- recent LinkedIn challenge history
- whether a full navigation is actually necessary

Rules:

- never use public-write surfaces
- avoid repeating the same route every tick
- prefer in-page scroll/idle when the current page is already healthy
- use a full navigation only when session freshness is aging or the current page
  is not trustworthy

#### 4) `ConnectionHealthManager`

Keep `CDPConnectionPool` small, but add health metadata and reconnect policy.

Recommended additions:

- per-connection timestamps: `lastConnectedAt`, `lastHealthyAt`, `lastFailureAt`
- disconnect counter and last disconnect reason
- lightweight `validateLease()` that checks browser connectivity, context
  existence, and first-page viability
- reconnect backoff after repeated `connectOverCDP()` failures
- force-close stale or page-less connections before reusing them

This is especially important because a pool reconnect and a LinkedIn login wall
are different failure classes and should not be conflated.

#### 5) `SessionKeepAliveCoordinator`

Move the production daemon logic behind one core coordinator that owns:

- scheduling and jitter
- health checks
- proactive refresh decisions
- reconnect decisions
- snapshot capture
- state transitions and event emission

The existing CLI daemon should call this coordinator and continue to persist the
JSON state/event files. That keeps the operator UX stable while removing the
current duplication between `keepAlive.ts` and the CLI loop.

## Proactive cookie refresh design

### Trigger conditions

Refresh should be proactive, not just reactive. The coordinator should trigger a
low-risk refresh when any of these are true:

- `li_at` expiry is below a warning threshold such as 14 days, then 72 hours,
  then 24 hours
- no successful authenticated activity has been observed for a long interval
  such as 12–24 hours
- only routing/session cookies have churned and the session still looks valid
- the browser reconnected after a disconnect and the session should be
  re-confirmed

Refresh should **not** blindly run when:

- a challenge/login wall is already visible
- the session is in a rate-limit cooldown state
- the profile lock is held by an active operator flow

### Refresh workflow

1. Acquire or validate the browser lease.
2. Run a non-destructive health inspection.
3. If the session is healthy but aging, choose one low-risk activity from the
   planner.
4. Re-inspect the session and record cookie metadata drift.
5. If the session remains healthy, persist a new snapshot metadata record.
6. If the refresh causes a login wall/challenge, stop refreshing and surface a
   hard operator-visible alert.

### Why not auto-restore cookies into a live profile?

Blindly replaying a stored cookie jar into an already-running profile can do
more harm than good:

- it can overwrite newer server-issued cookies with stale data
- it can interact badly with challenge flows or partial logout states
- it is especially risky for externally attached CDP browsers

So the recommended order is:

1. **observe first**
2. **refresh with safe activity second**
3. **only restore into a fresh controlled context** when the operator explicitly
   asks for repair or when a separate recovery flow is introduced later

## Cookie persistence and restore strategy

### Primary source of truth

Keep the existing persistent Chromium profile as the primary source of truth for
normal isolated-profile automation. That is the least surprising and already
matches the current CLI model.

### Secondary source of truth

Use encrypted session snapshots as the secondary source of truth for:

- diagnostics
- recovery planning
- live validation
- future explicit “repair session” tooling
- comparing current browser state with the last known healthy authenticated
  state

### Snapshot cadence

Recommended snapshot events:

- successful login completion
- daemon start after a healthy auth check
- successful proactive refresh
- daemon stop when the session is still authenticated
- explicit operator request such as `linkedin auth session`

### Snapshot retention

Store a small rolling window rather than a single latest blob:

- `latest.json` metadata pointer
- last 5 encrypted snapshots per logical profile/session
- last healthy snapshot pointer
- last degraded snapshot pointer

This enables drift analysis without retaining unlimited sensitive state.

## Activity simulation pattern catalog

The current activity simulation is intentionally tiny: light scroll and idle on
every third healthy tick. For hardening, keep the principle but expand the
catalog modestly.

### Pattern set

| Pattern | Risk | When to use | Notes |
| --- | --- | --- | --- |
| `scroll_idle` | Lowest | Current page is already authenticated and stable | First choice when possible |
| `feed_ping` | Low | Need a full authenticated navigation | Use sparingly |
| `notifications_ping` | Low | Need route rotation | Good alternative to `/feed/` |
| `messaging_ping` | Low | Need authenticated route rotation | Read-only if no compose/send occurs |
| `network_ping` | Low | Need another authenticated shell route | Helps avoid one-route repetition |
| `profile_ping` | Low | Need a stable authenticated page | Prefer `/in/<me>/` only |

### Rotation strategy

Recommended policy:

- never repeat the same full navigation more than twice in a row
- prefer `scroll_idle` for healthy intra-day ticks
- use route rotation when the auth cookie is aging or after reconnects
- reduce frequency overnight based on local timezone
- add extra jitter during business hours to avoid mechanical cadence

### Time-of-day awareness

Reuse the scheduler’s business-hours pattern rather than inventing a new timing
model.

Suggested defaults:

- business hours: check every 4–6 hours with jitter and occasional route
  rotation
- evening: check every 6–8 hours, mostly passive
- overnight: check at a much lower frequency or optionally pause if the last
  healthy snapshot is recent

This reduces unnecessary page loads while still keeping the profile warm.

## Login-wall and challenge detection design

### Current detection signals to preserve

Keep the current URL and DOM checks for:

- `/login`
- `/authwall`
- `signup/cold-join`
- `/checkpoint`
- `/challenge`
- `challenge_global_internal_error`
- visible login forms
- visible checkpoint forms

### Proposed additional signals

Promote detection into a structured classifier that can use:

- current URL pattern
- DOM markers for guest/auth walls
- presence of auth nav and authenticated profile menu
- cookie-class state
- redirect history within the current probe
- optional page title and visible alert/banner text

### Recommended states

```ts
type SessionState =
  | "healthy"
  | "degraded"
  | "login_wall"
  | "challenge"
  | "logged_out"
  | "browser_disconnected"
  | "page_unresponsive"
  | "unknown";
```

### Important behavior change

Do **not** treat “`li_at` exists” as a complete substitute for a healthy UI
state. It should remain a strong signal, but challenge/login-wall UI should win
if both are present.

That matters because a stale auth cookie can coexist briefly with a redirect or
checkpoint page.

## Connection resilience design

### Current gap

Today the pool knows whether the browser transport is connected, but not whether
that lease is still a good basis for session preservation.

### Recommended approach

1. Add lightweight lease validation before every keepalive action.
2. Track consecutive connection failures separately from session failures.
3. Add reconnect backoff with jitter for repeated CDP errors.
4. If a connection is restored, immediately re-run session inspection before
   declaring success.
5. Treat profile-lock contention as a skipped tick, not a degraded session.

### Failure classes

Model these separately in state and logs:

- `transport_disconnect`
- `page_crash_or_unresponsive`
- `login_wall_detected`
- `challenge_detected`
- `auth_cookie_missing`
- `auth_cookie_expiring`
- `profile_lock_held`
- `refresh_activity_failed`

This is the minimum needed for actionable operator output.

## Monitoring and alerting design

The repo already persists daemon state and events to local JSON files. Hardened
keep-alive should enrich that data model first before introducing any heavier
storage.

### State file additions

Extend keepalive state with fields such as:

```ts
interface KeepAliveStateV2 {
  sessionState: SessionState;
  lastSnapshotAt?: string;
  lastSnapshotSource?: "persistent_profile" | "stored_snapshot" | "cdp_observation";
  authCookieExpiresAt?: string | null;
  authCookieExpiryBucket?: "missing" | "lt_24h" | "lt_72h" | "lt_14d" | "ok";
  lastRefreshAction?: string;
  lastRefreshAt?: string;
  transportFailureCount?: number;
  sessionFailureCount?: number;
  lastDisconnectReason?: string;
  lastChallengeAt?: string;
  lastLoginWallAt?: string;
  lastDriftClass?: "none" | "routing_only" | "session_only" | "auth_related";
}
```

### Event stream additions

Add structured events for:

- snapshot captured
- auth cookie entering a warning bucket
- refresh planned
- refresh succeeded
- refresh skipped with explicit reason
- connection reconnect attempted / succeeded / failed
- login wall detected
- challenge detected
- recovery requires operator action

### Dashboard-oriented fields

Even if the first dashboard is just `jq` over JSON files, expose stable fields
for:

- profile name
- session state
- last healthy timestamp
- last refresh timestamp and action
- auth cookie expiry bucket
- transport vs session failure counts
- last challenge / login wall timestamps
- snapshot age

## Test strategy

### Unit tests

Add focused tests around:

- cookie classification and expiry bucketing
- session-state classification precedence
- refresh planner route rotation
- connection failure backoff decisions
- state-transition logic in the coordinator

### Integration tests

Build deterministic tests around:

- snapshot metadata capture without logging secrets
- challenge/login-wall dominance over cookie presence
- reconnect followed by successful session revalidation
- profile-lock skip behavior

### E2E tests

Safe live E2E coverage should stay read-only and follow the repo’s existing
safety rules:

- healthy isolated profile keepalive start/status/stop
- degraded session reporting when LinkedIn redirects to login or challenge
- attached CDP browser observation mode without automatic cookie restore

### Fixture-replay tests

Add fixture states for:

- authenticated feed shell
- login wall (`/authwall`)
- checkpoint/challenge page
- rate-limit challenge URL
- authenticated cookie present but UI redirected

This is important because the core classifier should not rely on live LinkedIn
for every edge case.

## Recommended phased rollout

### Phase 1: unify core orchestration

- Move the daemon decision logic into a core coordinator.
- Keep the CLI state/event persistence format stable.
- Introduce richer session-state and failure-class reporting.

### Phase 2: add cookie metadata and proactive refresh

- Extend session snapshots beyond `li_at` expiry only.
- Add warning buckets and route-rotation refresh planning.
- Persist rolling snapshot metadata for keepalive runs.

### Phase 3: add connection resilience and operator diagnostics

- Extend `CDPConnectionPool` with health metadata and reconnect backoff.
- Surface transport/session failure separation in status output.
- Add more actionable daemon event types.

### Phase 4: optional explicit repair tooling

- Add an operator-invoked repair flow that can restore a known-good encrypted
  snapshot into a fresh controlled context.
- Keep this out of the background daemon by default.

## Recommended file-level implementation map

A minimal implementation path for parent issue #133 would likely touch:

- `packages/core/src/keepAlive.ts`
  - evolve into the shared coordinator
- `packages/core/src/healthCheck.ts`
  - return richer session state instead of one boolean
- `packages/core/src/auth/sessionInspection.ts`
  - add structured login-wall/challenge classification
- `packages/core/src/auth/sessionStore.ts`
  - support richer snapshot metadata and rolling retention
- `packages/core/src/connectionPool.ts`
  - add health metadata and reconnect policy
- `packages/core/src/runtime.ts`
  - expose the coordinator/services cleanly
- `packages/cli/src/bin/linkedin.ts`
  - keep daemon UX thin and persist richer coordinator state/events
- `packages/core/src/__tests__/keepAlive.test.ts`
- `packages/core/src/__tests__/healthCheck.test.ts`
- `packages/core/src/__tests__/sessionStore.test.ts`
- new targeted tests for cookie/session classification

## Decision summary

The safest architecture is:

- persistent profile remains primary
- encrypted session snapshots become a first-class secondary recovery and
  observability layer
- keepalive becomes a core coordinator instead of duplicated CLI logic
- refresh becomes proactive and route-rotated
- login/challenge detection becomes multi-state and cookie-aware
- CDP resilience is separated from auth resilience

That gives issue #133 a clear implementation path that should materially reduce
surprise logouts without introducing risky automatic re-login behavior.

## References

- LinkedIn cookie table: <https://www.linkedin.com/legal/cookie-table>
- Playwright authentication guide: <https://playwright.dev/docs/auth>
