# LinkedIn activity webhooks implementation plan

Implementation plan for GitHub issue #165 (parent issue #86), based on the
research in `docs/activity-webhooks-architecture.md`.

## Intent

Add a first-class **poll-based LinkedIn activity webhook system** that fits the
repo’s existing shape:

- **Core** owns typed contracts, DB state, polling, diffing, and delivery.
- **CLI** owns the local daemon lifecycle and operator-facing management flows.
- **MCP** exposes management and inspection tools, not a second daemon.
- **LinkedIn reads stay read-only**; this feature must not use the existing
  two-phase commit executors.

The architecture decision that should remain fixed throughout implementation is:

- poll **activity watches** once
- persist normalized **entity state** and append-only **activity events**
- fan those events out to **webhook subscriptions**
- deliver with signatures, retries, and durable attempt history

## Phase boundaries

Phase 1 should intentionally stay narrower than the full architecture document.

### Phase 1 watch kinds to ship

1. `notifications`
2. `inbox_threads`
3. `pending_invitations`
4. `profile_watch`

### Phase 1.5 watch kind to add after the base eventing lane is stable

5. `accepted_invitations`

### Deferred until the rest is proven stable

6. `feed`

Rationale:

- `notifications` and `inbox_threads` have the clearest operator value and the
  strongest identifiers.
- `pending_invitations` is useful and lower-noise than feed polling.
- `profile_watch` is tractable when the target is explicit and narrow.
- `accepted_invitations` depends on `sent_invitation_state` semantics and is
  strongest only for invitations already tracked locally.
- `feed` has the highest false-positive risk because ordering is personalized.

The type system and DB schema can reserve all research-backed watch kinds from
day one, but the CLI and MCP creation surfaces should only expose the watch
kinds that are actually implemented and tested.

## File-level implementation map

### `packages/core`

#### New files

- `packages/core/src/activityWatches.ts`
  - watch CRUD
  - webhook subscription CRUD
  - recent event and delivery inspection queries
- `packages/core/src/activityDiff.ts`
  - normalized entity builders
  - stable key + fingerprint helpers
  - semantic diffing and event generation
- `packages/core/src/activityPoller.ts`
  - one tick of due-watch polling
  - watch ordering, backoff, result classification
  - event creation + delivery enqueueing
- `packages/core/src/webhookDelivery.ts`
  - payload signing
  - HTTP delivery
  - retry classification and backoff scheduling

#### Modified files

- `packages/core/src/config.ts`
  - add `ActivityWebhookConfig`
  - add `resolveActivityWebhookConfig()`
  - validate daemon, polling, and delivery env vars
- `packages/core/src/errors.ts`
  - add activity-specific structured error codes for watch config, delivery,
    and secret resolution failures
- `packages/core/src/db/migrations.ts`
  - add the first activity-webhooks migration
- `packages/core/src/db/database.ts`
  - add row/input types and methods for the activity-webhooks tables
- `packages/core/src/runtime.ts`
  - wire the new services into `createCoreRuntime()`
- `packages/core/src/index.ts`
  - re-export the new services and public types

#### New tests

- `packages/core/src/__tests__/activityWatches.test.ts`
- `packages/core/src/__tests__/activityDiff.test.ts`
- `packages/core/src/__tests__/activityPoller.test.ts`
- `packages/core/src/__tests__/webhookDelivery.test.ts`
- `packages/core/src/__tests__/activityConfig.test.ts`
- `packages/core/src/__tests__/activityDatabase.test.ts`

### `packages/cli`

#### New files

- `packages/cli/src/activityOutput.ts`
  - human-readable summaries and JSON pass-through for activity daemon,
    watches, subscriptions, events, and delivery attempts

#### Modified files

- `packages/cli/src/bin/linkedin.ts`
  - add `linkedin activity ...` command tree
  - add local daemon state/PID/event-log handling
  - add `watch`, `webhook`, `events`, and `deliveries` subcommands

#### New tests

- `packages/cli/src/__tests__/activityOutput.test.ts`
  - only if the formatter grows beyond trivial inline coverage in CLI tests

### `packages/mcp`

#### Modified files

- `packages/mcp/src/index.ts`
  - add tool-name constants for activity watch/subscription/event/delivery
    operations
- `packages/mcp/src/bin/linkedin-buddy-mcp.ts`
  - add schemas, handlers, and dispatcher entries for the new tools

### `docs`

#### New or updated files during implementation

- `docs/activity-webhooks-plan.md`
  - this implementation plan
- `README.md`
  - add operator-facing activity webhook usage once the feature exists

## Ordered implementation slices

### 1) Add the durable schema and config contracts first

This slice should lock the storage and config model before CLI or MCP wiring.

#### Files

- `packages/core/src/db/migrations.ts`
- `packages/core/src/db/database.ts`
- `packages/core/src/config.ts`
- `packages/core/src/errors.ts`

#### Schema to add

Add the research-backed tables:

- `activity_watch`
- `activity_entity_state`
- `activity_event`
- `webhook_subscription`
- `webhook_delivery_attempt`

Add the indexes needed for the first shipping workflows, at minimum:

- `(profile_name, status, next_poll_at)` on `activity_watch`
- `(watch_id, entity_key)` primary key on `activity_entity_state`
- `(watch_id, created_at)` on `activity_event`
- `(watch_id, status)` on `webhook_subscription`
- `(status, next_attempt_at)` on `webhook_delivery_attempt`
- `(subscription_id, event_id, attempt_number)` uniqueness or equivalent
  dedupe guard on `webhook_delivery_attempt`

#### Config contract

Add a new config surface alongside the existing scheduler config:

```ts
export interface ActivityWebhookConfig {
  enabled: boolean;
  daemonPollIntervalMs: number;
  maxWatchesPerTick: number;
  jitterPercent: number;
  delivery: {
    enabled: boolean;
    timeoutMs: number;
    maxAttempts: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
    maxResponseBodyBytes: number;
  };
  limits: {
    inboxThreadsPerPoll: number;
    notificationsPerPoll: number;
    pendingInvitationsPerPoll: number;
    feedPostsPerPoll: number;
  };
}

export function resolveActivityWebhookConfig(): ActivityWebhookConfig;
```

Recommended phase-1 env vars:

- `LINKEDIN_BUDDY_ACTIVITY_ENABLED`
- `LINKEDIN_BUDDY_ACTIVITY_DAEMON_POLL_INTERVAL_SECONDS`
- `LINKEDIN_BUDDY_ACTIVITY_MAX_WATCHES_PER_TICK`
- `LINKEDIN_BUDDY_ACTIVITY_JITTER_PERCENT`
- `LINKEDIN_BUDDY_ACTIVITY_HTTP_TIMEOUT_SECONDS`
- `LINKEDIN_BUDDY_ACTIVITY_MAX_ATTEMPTS`
- `LINKEDIN_BUDDY_ACTIVITY_INITIAL_BACKOFF_SECONDS`
- `LINKEDIN_BUDDY_ACTIVITY_MAX_BACKOFF_SECONDS`
- `LINKEDIN_BUDDY_ACTIVITY_MAX_THREADS_PER_POLL`
- `LINKEDIN_BUDDY_ACTIVITY_MAX_NOTIFICATIONS_PER_POLL`
- `LINKEDIN_BUDDY_ACTIVITY_MAX_INVITATIONS_PER_POLL`
- `LINKEDIN_BUDDY_ACTIVITY_MAX_FEED_POSTS_PER_POLL`

Phase 1 should **not** add business-hours gating yet. The scheduler already has
that complexity; the activity webhooks feature should first prove correctness,
noise suppression, and safe default intervals.

#### Tests

- migration test proving the new tables are created idempotently
- DB test covering inserts, queries, and retry-state transitions
- config tests for defaults, invalid values, and retry bounds
- error-code tests only where new codes are surfaced through public helpers

#### Depends on

- nothing

### 2) Add the watch and subscription registry service

This slice should make the durable objects manageable before polling begins.

#### Files

- `packages/core/src/activityWatches.ts`
- `packages/core/src/db/database.ts`
- `packages/core/src/runtime.ts`
- `packages/core/src/index.ts`

#### Core API surface

```ts
export type ActivityWatchKind =
  | "inbox_threads"
  | "notifications"
  | "pending_invitations"
  | "accepted_invitations"
  | "profile_watch"
  | "feed";

export type ActivityWatchStatus = "active" | "paused" | "disabled";

export type WebhookSubscriptionStatus = "active" | "paused" | "disabled";

export interface ActivityWatch {
  id: string;
  profileName: string;
  kind: ActivityWatchKind;
  target: Record<string, unknown>;
  status: ActivityWatchStatus;
  pollIntervalMs: number;
  nextPollAt: string | null;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSubscription {
  id: string;
  watchId: string;
  status: WebhookSubscriptionStatus;
  eventTypes: string[];
  deliveryUrl: string;
  secretRef: string;
  maxBatchSize: number | null;
  lastDeliveredAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export class LinkedInActivityWatchesService {
  createWatch(...): ActivityWatch;
  listWatches(...): ActivityWatch[];
  getWatch(...): ActivityWatch | null;
  pauseWatch(...): ActivityWatch;
  resumeWatch(...): ActivityWatch;
  removeWatch(...): void;
  createWebhookSubscription(...): WebhookSubscription;
  listWebhookSubscriptions(...): WebhookSubscription[];
  pauseWebhookSubscription(...): WebhookSubscription;
  resumeWebhookSubscription(...): WebhookSubscription;
  removeWebhookSubscription(...): void;
  listRecentEvents(...): ActivityEvent[];
  listDeliveryAttempts(...): WebhookDeliveryAttempt[];
}
```

Phase-1 recommendation: support `secretRef` values of the form `env:NAME`
only. Keep the field generic in the DB, but do not delay the whole feature for
keychain integration.

#### Tests

- watch creation/list/pause/resume/remove
- webhook creation/list/pause/resume/remove
- validation for unsupported watch kinds on create
- validation for invalid `secretRef`, invalid delivery URL, and empty event
  allowlists where applicable
- list filters for profile, watch, status, and recent history windows

#### Depends on

- slice 1

### 3) Build the normalization and diff engine as a pure core layer

This slice is the heart of correctness. Keep it deterministic and heavily unit
tested before adding daemon behavior.

#### Files

- `packages/core/src/activityDiff.ts`
- `packages/core/src/__tests__/activityDiff.test.ts`

#### Responsibilities

- normalize raw service outputs into stable entity snapshots
- derive deterministic `entity_key` values
- derive semantic fingerprints from only meaningful fields
- compare the new normalized state with `activity_entity_state`
- emit semantic events without over-emitting noise

#### Exported surface

```ts
export interface ActivityEntitySnapshot {
  entityKey: string;
  entityType: string;
  fingerprint: string;
  snapshot: Record<string, unknown>;
  url?: string;
}

export interface ActivityEventEnvelope {
  id: string;
  version: "2026-03-activity-v1";
  type: string;
  occurredAt: string;
  profileName: string;
  watch: {
    id: string;
    kind: ActivityWatchKind;
  };
  entity: {
    key: string;
    url?: string;
  };
  change: {
    kind: "created" | "updated" | "read_changed" | "accepted";
    previous: Record<string, unknown> | null;
    current: Record<string, unknown> | null;
  };
  meta: {
    pollStartedAt: string;
    pollFinishedAt: string;
  };
}

export function diffActivityEntities(...): {
  nextState: ActivityEntitySnapshot[];
  emittedEvents: ActivityEventEnvelope[];
};
```

#### Source adapters to implement in order

1. `notifications`
   - new item events
   - `is_read` change events
   - no delete events for disappearance
2. `inbox_threads`
   - thread create/update events
   - `message.received` events from changed/new thread detail
   - fetch thread detail only when the summary changed or the thread is new
3. `pending_invitations`
   - state transitions keyed by normalized profile URL + direction
4. `profile_watch`
   - conservative snapshot change events
   - ignore whitespace-only and order-only changes
5. `accepted_invitations`
   - reuse `sent_invitation_state` semantics
   - never emit duplicate acceptance events for already-accepted rows

#### Tests

- one unit-test group per source adapter
- explicit false-positive suppression tests
- fallback-id tests for notification rows without a stable LinkedIn id
- inbox tests verifying that message events come from detail diffs, not just a
  snippet change
- profile diff tests covering reordered sections and whitespace-only edits

#### Depends on

- slice 1

### 4) Add the poll tick orchestrator after the pure diff layer is trusted

This slice should follow the scheduler operational model: one core-owned tick,
with the CLI owning daemon lifecycle around it.

#### Files

- `packages/core/src/activityPoller.ts`
- `packages/core/src/runtime.ts`
- `packages/core/src/index.ts`

#### Core API surface

```ts
export interface ActivityWatchTickResult {
  watchId: string;
  watchKind: ActivityWatchKind;
  status: "polled" | "skipped" | "backoff" | "failed";
  polledAt: string;
  entityCount: number;
  emittedEventCount: number;
  queuedDeliveryCount: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ActivityPollTickResult {
  profileName: string;
  runId: string;
  polledWatchCount: number;
  emittedEventCount: number;
  queuedDeliveryCount: number;
  watchResults: ActivityWatchTickResult[];
}

export class LinkedInActivityPollerService {
  runTick(input: {
    profileName: string;
    workerId?: string;
    watchIds?: string[];
  }): Promise<ActivityPollTickResult>;
}
```

#### Tick behavior

Each tick should:

1. load due active watches for one profile
2. order them conservatively: inbox → notifications → pending invitations →
   accepted invitations → profile watches → feed
3. call the existing read-only service methods
4. normalize + diff the current state
5. update `activity_entity_state`
6. insert `activity_event` rows
7. insert `pending` delivery attempts for matching active subscriptions
8. update watch health metadata and `next_poll_at`

The event insert and delivery-attempt insert must happen in the same DB
transaction so a crash cannot drop deliveries after an event has been emitted.

#### Runtime wiring

Add these fields to `CoreRuntime`:

- `activityConfig`
- `activityWatches`
- `activityPoller`
- `webhooks`

#### Tests

- ordering of due watches
- `maxWatchesPerTick` behavior
- auth redirects, lock contention, and challenge pages treated as retryable
  backoff signals
- event + attempt rows created atomically
- hard failures record logs and artifact links without corrupting state
- no outbound LinkedIn mutation calls are made during polling

#### Depends on

- slice 1
- slice 2
- slice 3

### 5) Add the webhook delivery worker as an independent lane

The delivery worker should be separate from LinkedIn reads even if phase 1 runs
both inside one CLI-owned daemon loop.

#### Files

- `packages/core/src/webhookDelivery.ts`
- `packages/core/src/errors.ts`
- `packages/core/src/runtime.ts`

#### Core API surface

```ts
export interface WebhookDeliveryAttempt {
  id: string;
  subscriptionId: string;
  eventId: string;
  attemptNumber: number;
  status: "pending" | "delivered" | "retrying" | "failed" | "dead_letter";
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryTickResult {
  attemptedCount: number;
  deliveredCount: number;
  retryingCount: number;
  failedCount: number;
  disabledSubscriptionCount: number;
}

export class LinkedInWebhookDeliveryService {
  deliverPending(input: {
    profileName?: string;
    limit?: number;
  }): Promise<WebhookDeliveryTickResult>;
  retryAttempt(input: { attemptId: string }): Promise<WebhookDeliveryAttempt>;
  signPayload(input: {
    timestamp: string;
    body: string;
    secretRef: string;
  }): Promise<string>;
}
```

#### Delivery contract to freeze in phase 1

- method: `POST`
- success: any `2xx`
- retryable: network errors, timeouts, `429`, `5xx`, and the architecture’s
  retryable `4xx` exceptions
- permanent failure: most other `4xx`
- special handling: `410 Gone` disables the subscription
- timeout: 10 seconds by default
- signature input: `<timestamp>.<raw-body>`
- headers:
  - `X-LinkedIn-Assistant-Timestamp`
  - `X-LinkedIn-Assistant-Signature-256`
  - `X-LinkedIn-Assistant-Event`
  - `X-LinkedIn-Assistant-Delivery`
  - `X-LinkedIn-Assistant-Retry-Count`

Do **not** batch events in phase 1, even if the DB keeps `max_batch_size` for
future use.

#### Tests

- HMAC signature correctness
- header shape and payload versioning
- retry classification matrix
- backoff schedule matches the architecture defaults
- response excerpt truncation and privacy-safe diagnostics
- `410 Gone` disables the subscription
- redelivery uses the persisted event payload rather than rebuilding from
  current state

#### Depends on

- slice 1
- slice 2
- slice 4 for queue population

### 6) Add the CLI operator workflow after the core contracts exist

The CLI should look like the scheduler: thin command parsing, local daemon
ownership, and structured JSON output.

#### Files

- `packages/cli/src/bin/linkedin.ts`
- `packages/cli/src/activityOutput.ts`

#### CLI surface

Recommended command tree:

- `linkedin activity start --profile <profile>`
- `linkedin activity status --profile <profile>`
- `linkedin activity run-once --profile <profile>`
- `linkedin activity stop --profile <profile>`
- `linkedin activity watch add|list|pause|resume|remove`
- `linkedin activity webhook add|list|pause|resume|remove`
- `linkedin activity events list`
- `linkedin activity deliveries list|retry`

The daemon loop should:

- create a fresh core runtime each tick
- run `activityPoller.runTick()`
- run `webhooks.deliverPending()`
- persist daemon state and recent summaries under the assistant home
- stop on repeated internal failures using the same style as scheduler and
  keepalive

Phase 1 should keep all daemon state local and operator-visible, for example:

- `~/.linkedin-buddy/linkedin-buddy/activity/*.pid`
- `~/.linkedin-buddy/linkedin-buddy/activity/*.state.json`
- `~/.linkedin-buddy/linkedin-buddy/activity/*.events.jsonl`

#### Tests

- command parsing for all subcommands
- JSON output shape for daemon and management commands
- human-readable summaries in `activityOutput.ts`
- start/status/stop stale-PID handling
- `run-once` invoking both polling and delivery summary paths
- safe failure behavior when config resolution fails before daemon startup

#### Depends on

- slices 1 through 5

### 7) Add MCP management and diagnostics last

MCP should expose safe management and inspection flows, not a second daemon.

#### Files

- `packages/mcp/src/index.ts`
- `packages/mcp/src/bin/linkedin-buddy-mcp.ts`

#### MCP tool surface

Recommended phase-1 tools:

- `linkedin.activity.watch.create`
- `linkedin.activity.watch.list`
- `linkedin.activity.watch.pause`
- `linkedin.activity.watch.resume`
- `linkedin.activity.watch.remove`
- `linkedin.activity.webhook.create`
- `linkedin.activity.webhook.list`
- `linkedin.activity.webhook.pause`
- `linkedin.activity.webhook.resume`
- `linkedin.activity.webhook.remove`
- `linkedin.activity.events.list`
- `linkedin.activity.deliveries.list`
- `linkedin.activity.deliveries.retry`
- `linkedin.activity.run_once`

#### Tests

- tool inventory includes the full phase-1 activity set
- input validation and error payloads for all mutating tools
- list tools return structured output consistent with CLI JSON mode
- `run_once` remains read-only against LinkedIn and does not start a daemon

#### Depends on

- slices 1 through 6

### 8) Add source-specific expansion only after the base loop is working

Once the infrastructure above is stable, add the higher-risk sources in this
order:

1. `accepted_invitations`
   - use `runtime.followups.listAcceptedConnections()` and
     `sent_invitation_state`
   - surface clear operator messaging that this watch only covers invitations
     already tracked by the tool
2. `feed`
   - keep behind explicit CLI/MCP opt-in and experimental labeling
   - ship only if the diff engine already suppresses reordering noise

These expansions should be separate PRs unless the core infrastructure lands
with unusually low complexity.

## Dependency summary

The implementation order should remain:

1. schema + config
2. DB methods
3. watch/subscription registry
4. diff engine
5. poller
6. delivery worker
7. runtime exports
8. CLI
9. MCP
10. source expansions

The most important non-obvious dependencies are:

- `accepted_invitations` depends on the existing `sent_invitation_state`
  lifecycle and follow-up detection semantics
- delivery retries depend on persisted `activity_event.payload_json`, not just
  current entity state
- CLI and MCP management surfaces should not be exposed for a watch kind until
  the diff adapter and tests for that kind exist

## Test strategy by component

### Database and config

- temp-SQLite tests for migrations and row transitions
- env parsing tests for invalid bounds and unsupported values
- one regression test for idempotent migration re-runs

### Watch registry

- CRUD tests for watches and subscriptions
- filtering tests for profile, status, watch, and event type allowlists
- validation tests for unsupported kind/target combinations

### Diff engine

- pure unit tests with deterministic fixtures
- one fixture group per watch kind
- explicit no-noise tests for disappearance, whitespace-only changes, and list
  reordering

### Poller

- stub runtime service tests using fake inbox/notification/profile outputs
- transactionality tests around event creation + delivery enqueueing
- retry/backoff tests for auth challenges and profile-lock contention

### Delivery worker

- fake HTTP server or mocked `fetch` tests for status-code classification
- signature tests with frozen timestamps and bodies
- retry/resume tests using persisted attempts

### CLI

- parser and output tests
- daemon state file tests
- integration tests for `run-once` JSON output using a temp DB and fake delivery
  endpoint

### MCP

- handler unit tests for schemas and validation
- stdio integration coverage extending the existing MCP E2E suite

### Replay and live validation

- use the existing fixture/replay infrastructure for deterministic source tests
  wherever possible
- add one optional live read-only smoke path later: `activity run-once` against
  a local webhook receiver, with LinkedIn reads only and no public actions

## Risks and open questions

### 1) Secret resolution format

The architecture recommends `secret_ref`, not raw secrets, but the storage
backend is still open.

Recommended phase-1 answer:

- support `env:NAME` only
- reject unknown schemes early
- revisit keychain support later

### 2) Idempotency and dedupe boundaries

The exact uniqueness contract between `activity_entity_state`, `activity_event`,
and `webhook_delivery_attempt` must be explicit.

Recommended answer:

- dedupe semantic events at the event-ledger boundary using a deterministic
  fingerprint
- enqueue one initial delivery attempt per `(subscription_id, event_id)` pair
- always redeliver from persisted event payloads

### 3) Accepted-invitation semantics

The repo’s current acceptance tracking is strongest only for invitations the
tool already knows about.

Recommended answer:

- keep `accepted_invitations` out of the first shipping slice
- document the tracked-invitation limitation in CLI, MCP, and README copy

### 4) False positives from weak identifiers or presentation churn

Notifications without stable ids, thread snippet changes, and profile section
reordering can all create noisy events.

Recommended answer:

- keep normalization source-specific
- add suppression tests before enabling each watch kind in CLI/MCP
- keep `feed` experimental until the first four watch kinds are quiet

### 5) DB growth and operator UX

Event and delivery tables will grow without retention rules.

Recommended phase-1 answer:

- ship inspection commands first
- defer automated pruning to a follow-up issue once real usage volume is known
- design indexes so the first retention pass can be added without reshaping the
  core tables

### 6) CLI file growth

`packages/cli/src/bin/linkedin.ts` is already large.

Recommended answer:

- add only `activityOutput.ts` in phase 1
- keep the rest in `linkedin.ts` while matching the scheduler structure
- extract helper modules only if the activity subtree becomes difficult to test

## Final recommendation

The safest implementation path for issue #165 is:

1. land the durable schema, config, and registry contracts
2. build a pure, heavily tested normalization + diff layer
3. add one core-owned poll tick and one independent delivery worker
4. wire those through a scheduler-style local CLI daemon
5. expose only management and diagnostics through MCP
6. ship `notifications`, `inbox_threads`, `pending_invitations`, and
   `profile_watch` before expanding to `accepted_invitations` and `feed`

That order preserves the architecture document’s main safety goals: shared
polling, low LinkedIn traffic, durable state, signed delivery, and operator
visibility.
