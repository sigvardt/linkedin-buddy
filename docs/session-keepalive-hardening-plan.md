# Session keep-alive hardening implementation plan

Implementation plan for GitHub issue #164 (parent issue #133), based on the
research in `docs/session-keepalive-hardening-architecture.md` and the current
session/keepalive implementation in `packages/core` and `packages/cli`.

## Intent

Implement session keep-alive hardening without introducing automatic login,
cookie replay into attached browsers, or write-side background activity.

The plan should preserve the repository’s current operator model:

- `packages/core` becomes the single source of truth for keep-alive behavior.
- `packages/cli` remains a thin daemon wrapper that persists local state and
  events.
- persistent Chromium profiles remain the primary session source of truth.
- encrypted session snapshots become a first-class observability and recovery
  layer.
- read-only keep-alive activity stays low-risk and operator-visible.

## Constraints and compatibility rules

These constraints should shape every implementation step:

- no automatic credentialed login, MFA bypass, or silent re-auth flows
- no automatic cookie restore for `--cdp-url` attached browsers
- no mutation surfaces in the background keep-alive lane
- no secret cookie values in logs, state files, event streams, or snapshot
  metadata
- keep `linkedin keepalive start|status|stop` behavior stable for operators
- keep the existing `runtime.healthCheck()` surface working until all callers
  have migrated to the richer session-health report

## Ordered implementation steps

### 1) Establish shared session-health and cookie models

Start by introducing the shared types and classifiers that every later phase
depends on.

#### Goals

- replace the current binary session result with a richer multi-state model
- classify cookie state without ever logging cookie values
- preserve a compatibility adapter for existing callers of `healthCheck.ts`

#### File-level changes

- new `packages/core/src/sessionHealth.ts`
  - owns the new session-health service, cookie helpers, and report types
- modify `packages/core/src/auth/sessionInspection.ts`
  - expand from `authenticated: boolean` into structured state classification
  - preserve URL/DOM checks already used for login wall and checkpoint flows
- modify `packages/core/src/healthCheck.ts`
  - delegate to the richer session-health service
  - keep `FullHealthStatus` as a compatibility projection during migration
- modify `packages/core/src/index.ts`
  - re-export the new health module

#### Planned API surface

Recommended new public types and exports:

```ts
export type SessionState =
  | "healthy"
  | "degraded"
  | "login_wall"
  | "challenge"
  | "logged_out"
  | "browser_disconnected"
  | "page_unresponsive"
  | "unknown";

export type CookieClass =
  | "auth"
  | "csrf"
  | "routing"
  | "browser_identity"
  | "consent"
  | "other";

export type AuthCookieExpiryBucket =
  | "missing"
  | "lt_24h"
  | "lt_72h"
  | "lt_14d"
  | "ok";

export type CookieDriftClass =
  | "none"
  | "routing_only"
  | "session_only"
  | "auth_related";

export interface SessionCookieObservation {
  name: string;
  class: CookieClass;
  present: boolean;
  expiresAt: string | null;
  expiresInHours: number | null;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

export interface SessionHealthReport {
  checkedAt: string;
  browser: {
    connected: boolean;
    pageResponsive: boolean;
    reconnectRecommended: boolean;
  };
  session: {
    state: SessionState;
    currentUrl: string;
    reason: string;
  };
  cookies: {
    authCookiePresent: boolean;
    authCookieExpiresAt: string | null;
    authCookieExpiryBucket: AuthCookieExpiryBucket;
    driftClass: CookieDriftClass;
    observations: SessionCookieObservation[];
  };
}

export interface SessionHealthCheckOptions {
  selectorLocale?: LinkedInSelectorLocale;
  previousCookies?: SessionCookieObservation[];
  skipNavigation?: boolean;
}

export class SessionHealthService {
  inspectContext(
    context: BrowserContext,
    options?: SessionHealthCheckOptions
  ): Promise<SessionHealthReport>;
}

export function classifyAuthCookieExpiry(
  expiresAt: string | null,
  now?: Date
): AuthCookieExpiryBucket;

export function classifyCookieDrift(
  previousCookies: SessionCookieObservation[] | undefined,
  nextCookies: SessionCookieObservation[]
): CookieDriftClass;
```

#### Test strategy for this step

- modify `packages/core/src/__tests__/sessionInspection.test.ts`
  - add precedence coverage for `challenge` and `login_wall` over cookie
    presence
  - add cases for authenticated UI plus stale/partial cookie states
- add `packages/core/src/__tests__/sessionHealth.test.ts`
  - cover expiry bucketing, drift classification, and report assembly
- modify `packages/core/src/__tests__/healthCheck.test.ts`
  - verify the compatibility adapter still returns the existing
    `FullHealthStatus` shape

#### Dependencies

- no upstream dependencies
- unlocks every later phase

### 2) Expand encrypted session snapshots into a keep-alive-ready metadata store

Once the new cookie/session model exists, extend the stored-session layer so it
can track sanitized cookie lineage and rolling snapshot history.

#### Goals

- keep encrypted snapshot blobs as the durable secondary source of truth
- expose metadata-only inspection for daemon status and diagnostics
- add rolling retention instead of a single latest snapshot

#### File-level changes

- modify `packages/core/src/auth/sessionStore.ts`
  - extend metadata beyond `liAtCookieExpiresAt`
  - retain the encrypted payload format for the full storage state
  - support a rolling window of snapshots per logical profile/session
  - add last-healthy and last-degraded metadata pointers
- optionally add `packages/core/src/__tests__/fixtures/session-store/`
  - fixture metadata payloads for retention and drift cases if inline test data
    becomes noisy

#### Planned API surface

This phase should keep the existing `LinkedInSessionStore` class name to avoid
unnecessary churn, but expand its methods and metadata types.

```ts
export type SessionSnapshotSource =
  | "persistent_profile"
  | "stored_snapshot"
  | "cdp_observation";

export interface StoredLinkedInSessionMetadata {
  capturedAt: string;
  cookieCount: number;
  filePath: string;
  hasLinkedInAuthCookie: boolean;
  liAtCookieExpiresAt: string | null;
  originCount: number;
  sessionName: string;
  snapshotId: string;
  snapshotSource: SessionSnapshotSource;
  sessionState: SessionState;
  driftClass?: CookieDriftClass;
  cookies: SessionCookieObservation[];
}

export interface SaveLinkedInSessionSnapshotOptions {
  source: SessionSnapshotSource;
  sessionState: SessionState;
  maxSnapshots?: number;
}

export interface ListLinkedInSessionSnapshotsOptions {
  limit?: number;
  metadataOnly?: boolean;
}

export class LinkedInSessionStore {
  saveSnapshot(
    sessionName: string,
    storageState: LinkedInBrowserStorageState,
    options: SaveLinkedInSessionSnapshotOptions
  ): Promise<StoredLinkedInSessionMetadata>;

  listSnapshots(
    sessionName?: string,
    options?: ListLinkedInSessionSnapshotsOptions
  ): Promise<StoredLinkedInSessionMetadata[]>;

  loadLatestMetadata(
    sessionName?: string
  ): Promise<StoredLinkedInSessionMetadata | null>;

  loadLastHealthyMetadata(
    sessionName?: string
  ): Promise<StoredLinkedInSessionMetadata | null>;

  pruneSnapshots(sessionName?: string, maxSnapshots?: number): Promise<void>;
}
```

Implementation note:

- keep the existing `save()` and `load()` methods during migration
- implement `save()` on top of `saveSnapshot()` once the new path is stable
- never expose cookie values through the metadata-only methods

#### Test strategy for this step

- modify `packages/core/src/__tests__/sessionStore.test.ts`
  - cover rolling retention and metadata-only reads
  - verify no stored metadata or envelope content leaks cookie values
  - verify `lastHealthy` and `lastDegraded` pointers update correctly
- add integration-style tests for snapshot capture from a synthetic
  `storageState` containing auth, routing, and browser-identity cookies

#### Dependencies

- depends on Step 1 cookie classes, session states, and drift classification
- consumed by Steps 5 and 6

### 3) Add a safe read-only activity planner

The planner decides what low-risk refresh action to take when the session is
healthy but aging or after a reconnect.

#### Goals

- stop hard-coding `/feed/` as the only refresh path
- rotate across safe authenticated routes
- prefer passive scroll/idle when the current page is already trustworthy

#### File-level changes

- new `packages/core/src/sessionActivityPlanner.ts`
  - route catalog, selection rules, time-of-day policy, and rotation logic
- modify `packages/core/src/keepAlive.ts`
  - consume planner results instead of directly navigating to `/feed/`
- modify `packages/core/src/config.ts`
  - add resolved keep-alive cadence and refresh settings used by the planner

#### Planned API surface

```ts
export type KeepAliveActionType =
  | "scroll_idle"
  | "feed_ping"
  | "notifications_ping"
  | "messaging_ping"
  | "network_ping"
  | "profile_ping";

export interface KeepAliveActionPlan {
  action: KeepAliveActionType;
  requiresNavigation: boolean;
  targetUrl?: string;
  reason: string;
}

export interface SessionActivityPlannerContext {
  now: Date;
  currentUrl: string;
  sessionState: SessionState;
  authCookieExpiryBucket: AuthCookieExpiryBucket;
  lastSuccessfulAction?: KeepAliveActionType;
  consecutiveSameRouteCount: number;
  recentChallengeAt?: string;
  browserRecentlyReconnected: boolean;
}

export class SessionActivityPlanner {
  planNextAction(
    context: SessionActivityPlannerContext
  ): KeepAliveActionPlan | null;
}
```

#### Test strategy for this step

- add `packages/core/src/__tests__/sessionActivityPlanner.test.ts`
  - route rotation rules
  - `scroll_idle` preference on already-healthy authenticated pages
  - reduced overnight activity
  - challenge cooldown behavior
  - no route repeated more than twice consecutively

#### Dependencies

- depends on Step 1 session-health types
- can be implemented in parallel with Step 2 once Step 1 is complete

### 4) Harden CDP lease and reconnect behavior

Strengthen the connection pool before placing richer keep-alive logic on top of
it.

#### Goals

- separate transport failures from LinkedIn session failures
- reject stale, page-less, or disconnected leases before reuse
- add reconnect backoff and structured disconnect history

#### File-level changes

- modify `packages/core/src/connectionPool.ts`
  - track health timestamps and disconnect counters per connection
  - add lease validation and reconnect backoff
  - close stale or page-less connections before reuse
- modify `packages/core/src/runtime.ts`
  - reuse one pool instance for keep-alive coordinator creation instead of each
    caller managing its own pool ad hoc

#### Planned API surface

```ts
export type ConnectionFailureClass =
  | "transport_disconnect"
  | "page_crash_or_unresponsive"
  | "no_context"
  | "no_page"
  | "connect_failed";

export interface ConnectionHealthSnapshot {
  cdpUrl: string;
  lastConnectedAt?: string;
  lastHealthyAt?: string;
  lastFailureAt?: string;
  lastDisconnectReason?: ConnectionFailureClass | string;
  disconnectCount: number;
  consecutiveConnectFailures: number;
  reconnectBackoffUntil?: string;
}

export interface LeaseValidationResult {
  valid: boolean;
  pageResponsive: boolean;
  failureClass?: ConnectionFailureClass;
}

export interface ConnectionLease {
  context: BrowserContext;
  release: () => void;
  validate: () => Promise<LeaseValidationResult>;
}

export class CDPConnectionPool {
  acquire(cdpUrl: string): Promise<ConnectionLease>;
  getConnectionHealth(cdpUrl: string): ConnectionHealthSnapshot | null;
}
```

#### Test strategy for this step

- modify `packages/core/src/__tests__/connectionPool.test.ts`
  - disconnected browser replacement
  - `validate()` behavior for missing context/page
  - reconnect backoff after repeated `connectOverCDP()` failures
  - force-close of stale idle connections

#### Dependencies

- independent from Step 2 and Step 3
- consumed directly by Step 5

### 5) Replace the current core keep-alive loop with a coordinator

After the health, snapshot, planner, and connection pieces exist, unify the
daemon logic behind one core coordinator.

#### Goals

- make `packages/core` the source of truth for keep-alive decisions
- eliminate duplicated health/retry logic between `keepAlive.ts` and the CLI
- centralize state transitions, event emission, and snapshot capture

#### File-level changes

- modify `packages/core/src/keepAlive.ts`
  - evolve from `SessionKeepAliveService` into a coordinator-driven service
  - own scheduling, jitter, health inspection, refresh decisions, reconnects,
    and event emission
- modify `packages/core/src/runtime.ts`
  - expose `sessionHealth`, `sessionStore`, `keepAliveConfig`, and a
    coordinator factory
- modify `packages/core/src/index.ts`
  - export the new keep-alive types and coordinator APIs

#### Planned API surface

Recommended shape:

```ts
export type KeepAliveFailureClass =
  | "transport_disconnect"
  | "page_crash_or_unresponsive"
  | "login_wall_detected"
  | "challenge_detected"
  | "auth_cookie_missing"
  | "auth_cookie_expiring"
  | "profile_lock_held"
  | "refresh_activity_failed";

export interface KeepAliveStateSnapshot {
  profileName: string;
  status: "starting" | "running" | "degraded" | "stopped";
  sessionState: SessionState;
  consecutiveFailures: number;
  transportFailureCount: number;
  sessionFailureCount: number;
  lastTickAt?: string;
  lastHealthyAt?: string;
  lastRefreshAt?: string;
  lastRefreshAction?: KeepAliveActionType;
  lastSnapshotAt?: string;
  lastSnapshotSource?: SessionSnapshotSource;
  authCookieExpiresAt?: string | null;
  authCookieExpiryBucket?: AuthCookieExpiryBucket;
  lastDriftClass?: CookieDriftClass;
  lastDisconnectReason?: string;
  lastChallengeAt?: string;
  lastLoginWallAt?: string;
  lastError?: string;
}

export interface KeepAliveEvent {
  type:
    | "tick_started"
    | "tick_skipped"
    | "health_checked"
    | "snapshot_captured"
    | "refresh_planned"
    | "refresh_succeeded"
    | "refresh_skipped"
    | "reconnect_attempted"
    | "reconnect_succeeded"
    | "reconnect_failed"
    | "login_wall_detected"
    | "challenge_detected"
    | "operator_action_required";
  timestamp: string;
  profileName: string;
  reason?: string;
  state: KeepAliveStateSnapshot;
}

export interface SessionKeepAliveCoordinatorOptions {
  profileName: string;
  cdpUrl?: string;
  intervalMs: number;
  jitterMs: number;
  maxConsecutiveFailures: number;
}

export class SessionKeepAliveCoordinator extends EventEmitter {
  start(): void;
  stop(): Promise<void>;
  getState(): KeepAliveStateSnapshot;
  runTick(): Promise<KeepAliveStateSnapshot>;
}
```

Compatibility guidance:

- keep exporting `SessionKeepAliveService` during the migration window
- make it a thin wrapper or alias over the coordinator-backed implementation
- deprecate event names only after the CLI no longer depends on legacy naming

#### Test strategy for this step

- modify `packages/core/src/__tests__/keepAlive.test.ts`
  - cover state transitions and counter updates
  - cover refresh planning and skip reasons
  - cover reconnect followed by revalidation
  - cover profile-lock skip behavior
- add integration-style coordinator tests with fake health reports and fake
  snapshot store responses
- extend `packages/core/src/__tests__/runtimeClose.test.ts`
  - ensure runtime-owned keep-alive resources clean up correctly

#### Dependencies

- depends on Steps 1 through 4
- blocks Step 6

### 6) Rewire the CLI daemon to the core coordinator

Once the coordinator is stable, remove the hand-rolled daemon decision loop in
`packages/cli` and make the CLI a persistence/reporting adapter.

#### Goals

- keep the operator UX stable while eliminating duplicated logic
- persist richer state and events without changing the user-facing command
  structure
- make `status` clearly distinguish transport, auth, and operator-action
  conditions

#### File-level changes

- modify `packages/cli/src/bin/linkedin.ts`
  - replace the current `while (!stopRequested)` keepalive decision logic with
    coordinator lifecycle wiring
  - persist `KeepAliveStateSnapshot` plus CLI-specific daemon metadata
  - persist enriched structured event records
- optionally add `packages/cli/src/keepAliveOutput.ts`
  - if status/event formatting becomes large enough to justify extraction from
    `linkedin.ts`

#### Planned state/event schema

The persisted state should move to a versioned schema while keeping existing top
level fields that current tooling may already consume.

```ts
interface KeepAliveStateV2 {
  schemaVersion: 2;
  pid: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  status: "starting" | "running" | "degraded" | "stopped";
  intervalMs: number;
  jitterMs: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  sessionState: SessionState;
  lastTickAt?: string;
  lastHealthyAt?: string;
  lastSnapshotAt?: string;
  lastSnapshotSource?: SessionSnapshotSource;
  authCookieExpiresAt?: string | null;
  authCookieExpiryBucket?: AuthCookieExpiryBucket;
  lastRefreshAction?: KeepAliveActionType;
  lastRefreshAt?: string;
  transportFailureCount?: number;
  sessionFailureCount?: number;
  lastDisconnectReason?: string;
  lastChallengeAt?: string;
  lastLoginWallAt?: string;
  lastDriftClass?: CookieDriftClass;
  currentUrl?: string;
  reason?: string;
  lastError?: string;
  cdpUrl?: string;
  stoppedAt?: string;
}
```

Recommended event additions:

- `keepalive.snapshot.captured`
- `keepalive.auth_cookie.warning`
- `keepalive.refresh.planned`
- `keepalive.refresh.succeeded`
- `keepalive.refresh.skipped`
- `keepalive.reconnect.attempted`
- `keepalive.reconnect.succeeded`
- `keepalive.reconnect.failed`
- `keepalive.login_wall.detected`
- `keepalive.challenge.detected`
- `keepalive.operator_action_required`

#### Test strategy for this step

- add or expand CLI tests for:
  - daemon start/status/stop with coordinator-backed state
  - versioned state-file parsing
  - JSON output for degraded transport vs degraded auth cases
  - event log persistence for refresh, reconnect, and operator-action events
- extend `packages/core/src/__tests__/e2e/cli.e2e.test.ts`
  - keep read-only coverage for keepalive start/status/stop
  - verify attached CDP mode stays observation-only

#### Dependencies

- depends on Step 5
- should land before any operator-facing docs updates

### 7) Finish fixture coverage, live read-only E2Es, and docs

The last step hardens the implementation against regression and ensures the
operator-facing docs match the shipped behavior.

#### Goals

- add deterministic coverage for auth-wall and challenge edge cases
- keep the live E2E lane read-only
- document the new state/event fields and operator expectations

#### File-level changes

- modify `test/fixtures/manifest.json`
  - register any new keep-alive/session-classification fixture set
- add fixture pages and routes under `test/fixtures/ci/`
  - authenticated shell
  - auth wall
  - checkpoint/challenge
  - rate-limit challenge URL
  - auth cookie present but redirected UI
- modify `docs/e2e-testing.md`
  - document read-only keepalive coverage and attached-browser expectations
- modify `README.md`
  - update keepalive command behavior and status interpretation if the CLI
    output changes materially

#### Test strategy for this step

- add fixture-replay tests for the classifier precedence matrix
- add live read-only E2Es for:
  - healthy isolated-profile keepalive start/status/stop
  - degraded session reporting when redirected to login or challenge
  - attached CDP observation mode without cookie restore

#### Dependencies

- depends on Step 6
- final release-readiness step

## File-level implementation map

### New files

- `packages/core/src/sessionHealth.ts`
  - rich health reports, cookie classification, compatibility helpers
- `packages/core/src/sessionActivityPlanner.ts`
  - read-only action planning and route rotation
- `packages/core/src/__tests__/sessionHealth.test.ts`
  - health/cookie classification tests
- `packages/core/src/__tests__/sessionActivityPlanner.test.ts`
  - action-planner tests

### Modified files

- `packages/core/src/auth/sessionInspection.ts`
  - structured auth/login/challenge classification
- `packages/core/src/healthCheck.ts`
  - compatibility adapter over richer health reports
- `packages/core/src/auth/sessionStore.ts`
  - snapshot metadata, retention, and metadata-only inspection
- `packages/core/src/connectionPool.ts`
  - lease validation, health metadata, reconnect backoff
- `packages/core/src/keepAlive.ts`
  - coordinator-owned scheduling, refresh, and state transitions
- `packages/core/src/runtime.ts`
  - wire new services and expose coordinator factory
- `packages/core/src/config.ts`
  - resolved keep-alive config and parsing helpers
- `packages/core/src/index.ts`
  - re-export new public APIs
- `packages/core/src/__tests__/sessionInspection.test.ts`
  - state precedence tests
- `packages/core/src/__tests__/healthCheck.test.ts`
  - adapter compatibility tests
- `packages/core/src/__tests__/sessionStore.test.ts`
  - rolling retention and metadata-only tests
- `packages/core/src/__tests__/connectionPool.test.ts`
  - reconnect/lease validation tests
- `packages/core/src/__tests__/keepAlive.test.ts`
  - coordinator state machine tests
- `packages/core/src/__tests__/runtimeClose.test.ts`
  - runtime cleanup expectations
- `packages/cli/src/bin/linkedin.ts`
  - thin daemon wiring plus richer state/event persistence
- `packages/core/src/__tests__/e2e/cli.e2e.test.ts`
  - read-only keepalive CLI coverage
- `test/fixtures/manifest.json`
  - fixture registration for session hardening edge cases
- `docs/e2e-testing.md`
  - operator guidance for the new read-only keepalive coverage
- `README.md`
  - status/event interpretation if user-visible output changes

## Planned API surface and config schema

### Runtime additions

The runtime should expose richer keep-alive entrypoints without breaking current
callers.

Recommended additions to `CoreRuntime`:

```ts
interface CoreRuntime {
  sessionHealth: SessionHealthService;
  sessionStore: LinkedInSessionStore;
  keepAliveConfig: KeepAliveConfig;
  createKeepAliveCoordinator(
    options: SessionKeepAliveCoordinatorOptions
  ): SessionKeepAliveCoordinator;

  healthCheck(options?: { profileName?: string }): Promise<FullHealthStatus>;
}
```

Rationale:

- `healthCheck()` stays stable for existing commands and tests
- new code uses `sessionHealth` plus the coordinator directly
- the runtime owns shared dependencies such as the connection pool and session
  store

### Keep-alive config schema

The keep-alive lane now has enough policy that it should move into
`packages/core/src/config.ts`, following the existing scheduler pattern.

Recommended resolved config shape:

```ts
export interface KeepAliveCadenceConfig {
  timeZone: string;
  businessHoursIntervalMs: number;
  eveningIntervalMs: number;
  overnightIntervalMs: number;
  jitterMs: number;
}

export interface KeepAliveRefreshConfig {
  enabled: boolean;
  inactivityRefreshMs: number;
  authCookieWarningHours: {
    lt14d: number;
    lt72h: number;
    lt24h: number;
  };
  challengeCooldownMs: number;
}

export interface KeepAliveSnapshotConfig {
  enabled: boolean;
  maxSnapshotsPerProfile: number;
  captureOnStart: boolean;
  captureOnRefresh: boolean;
  captureOnStop: boolean;
  attachedBrowserMode: "observe_only";
}

export interface KeepAliveConnectionConfig {
  idleTimeoutMs: number;
  reconnectInitialBackoffMs: number;
  reconnectMaxBackoffMs: number;
}

export interface KeepAliveConfig {
  enabled: boolean;
  maxConsecutiveFailures: number;
  cadence: KeepAliveCadenceConfig;
  refresh: KeepAliveRefreshConfig;
  snapshots: KeepAliveSnapshotConfig;
  connection: KeepAliveConnectionConfig;
}

export function resolveKeepAliveConfig(baseDir?: string): KeepAliveConfig;
```

CLI flags should keep overriding the resolved config where the CLI already
accepts explicit per-run values.

## Dependency summary

The dependency order should be enforced explicitly so the implementation lands
cleanly:

1. Step 1 first, because session state, cookie classes, and the richer report
   are foundational.
2. Step 2 depends on Step 1 for cookie metadata and snapshot state labelling.
3. Step 3 depends on Step 1 for session-state and expiry-bucket inputs.
4. Step 4 can proceed after Step 1, but before the coordinator migration.
5. Step 5 depends on Steps 1 through 4.
6. Step 6 depends on Step 5 because the CLI should only switch once the
   coordinator contract is stable.
7. Step 7 depends on Step 6 so fixture, E2E, and docs match the shipped CLI
   behavior.

Parallelizable work after Step 1:

- snapshot-store expansion (Step 2)
- activity planner (Step 3)
- connection-pool hardening (Step 4)

## Risks and open questions

### 1) Backward compatibility of exported health/keepalive APIs

Risk:

- external callers or tests may rely on `FullHealthStatus` and current
  keepalive event names

Recommendation:

- preserve the old shapes as adapters for the first implementation pass
- migrate the CLI and tests before considering any public cleanup

### 2) Snapshot file layout and pointer format

Risk:

- adding rolling retention can create churn if the on-disk naming scheme is not
  chosen early

Recommendation:

- keep the existing encrypted store directory
- add stable metadata pointers such as `latest`, `lastHealthy`, and
  `lastDegraded`
- avoid changing the master-key location or encryption format in this issue

### 3) `profile_ping` target resolution

Risk:

- `/in/<me>/` is a desirable stable page, but the runtime may not know the
  profile slug cheaply on every tick

Recommendation:

- support `profile_ping` only when the current authenticated page already
  exposes a trustworthy `in/me` or profile URL
- otherwise fall back to another safe route

### 4) Default overnight cadence

Risk:

- overly frequent overnight activity creates unnecessary traffic
- full overnight pauses can allow sessions to age out without refresh

Recommendation:

- ship a conservative low-frequency overnight cadence first
- avoid introducing a full pause policy until there is data from the new event
  stream

### 5) State-file compatibility for existing local tooling

Risk:

- operators may already parse `keepalive/*.state.json` directly

Recommendation:

- add `schemaVersion: 2`
- preserve existing top-level fields where feasible
- only add fields; avoid renaming or removing the existing basics in the first
  pass

### 6) Attached-browser safety boundary

Risk:

- once snapshot restore exists, background flows could drift into mutating
  external browser state

Recommendation:

- enforce `attachedBrowserMode: "observe_only"` in config and code
- block any future restore path in the background daemon for `--cdp-url`

## Recommended PR slicing

To keep review focused, the work should land in a small number of ordered PRs:

1. **Session models + health service**
   - Step 1 and its tests
2. **Snapshot store + planner + connection pool**
   - Steps 2 through 4 and their tests
3. **Coordinator + runtime wiring**
   - Step 5 and core integration tests
4. **CLI daemon migration + state/event schema**
   - Step 6 plus CLI tests
5. **Fixture replay, read-only E2Es, and docs**
   - Step 7 and any final operator-facing documentation updates

This sequencing keeps the riskiest contract changes inside `packages/core`
before switching the CLI daemon over to the new implementation.
