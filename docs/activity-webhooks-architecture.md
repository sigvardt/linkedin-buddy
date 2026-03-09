# LinkedIn activity webhooks architecture

This document describes the **implemented** activity polling and webhook
subscription system.

Use `docs/activity-webhooks.md` for the operator guide. Use this document when
you need the actual module map, tick lifecycle, storage model, or integration
boundaries.

## Module map

The shipped implementation is split across these files:

- `packages/core/src/activityTypes.ts`: watch kinds, event types, statuses, and
  default schedules
- `packages/core/src/activityWatches.ts`: watch CRUD, subscription CRUD, target
  normalization, cron parsing, active-watch capacity checks, and history views
- `packages/core/src/activityDiff.ts`: stable JSON normalization plus entity
  fingerprint diffing
- `packages/core/src/activityPoller.ts`: one-tick orchestration for due
  deliveries, due watches, event emission, and retry scheduling
- `packages/core/src/webhookDelivery.ts`: HTTP POST delivery, HMAC signing,
  timeout handling, response classification, and backoff helpers
- `packages/core/src/db/migrations.ts`: SQLite schema for watches, entity
  state, events, subscriptions, and delivery attempts
- `packages/core/src/runtime.ts`: wires `runtime.activityWatches` and
  `runtime.activityPoller` into the core service graph
- `packages/cli/src/bin/linkedin.ts`: CLI command wiring plus daemon start,
  status, stop, and `run-once`
- `packages/cli/src/activityOutput.ts`: human-readable activity summaries and
  structured error rendering
- `packages/mcp/src/bin/linkedin-mcp.ts`: activity watch, webhook, history, and
  `run_once` MCP tools

## Runtime shape

`createCoreRuntime()` exposes two new activity surfaces:

- `runtime.activityWatches`
- `runtime.activityPoller`

The poller intentionally reuses existing read-only services instead of building
parallel selector logic:

- `runtime.notifications.listNotifications()`
- `runtime.connections.listPendingInvitations()`
- `runtime.connections.listConnections()`
- `runtime.followups.listAcceptedConnections()`
- `runtime.profile.viewProfile()`
- `runtime.feed.viewFeed()`
- `runtime.inbox.listThreads()`
- `runtime.inbox.getThread()`

That reuse keeps selector behavior, auth requirements, and browser/session
handling consistent with the rest of the product.

## One tick from start to finish

One `ActivityPollerService.runTick()` call follows this order:

```text
runTick(profile)
  -> claim due webhook deliveries
  -> attempt delivery / retry / fail / dead-letter
  -> promote deferred deliveries if queue space opened
  -> if queued deliveries are below the queue cap, claim due watches
  -> fetch current LinkedIn snapshots for each claimed watch
  -> normalize entities and diff against activity_entity_state
  -> append activity_event rows for semantic changes
  -> enqueue webhook_delivery_attempt rows for active matching subscriptions
  -> mark each watch succeeded or failed and compute the next schedule
```

Important details:

- the poller processes **deliveries before watch polling** so backlogged webhook
  traffic drains before new events are generated
- an in-process per-profile lock prevents concurrent ticks from one process,
  while SQLite leases protect watch and delivery claims across processes
- if queued `pending` + `leased` deliveries have already reached
  `LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH`, the tick skips watch
  claiming and only works on delivery drain

## Watch execution model

### Schedule resolution

Watches are persisted with either:

- `schedule_kind = 'interval'` and `poll_interval_ms`, or
- `schedule_kind = 'cron'` and `cron_expression`

The `activity_watch` table has a `CHECK` constraint that enforces this XOR.

`activityWatches.ts` validates interval schedules against the effective minimum
for the selected watch kind. Cron parsing supports five fields with numbers,
ranges, lists, and step expressions.

### Initial baseline behavior

The first successful poll for one watch is treated as a **baseline**:

- entity snapshots are written into `activity_entity_state`
- `last_success_at` is recorded on the watch
- no create-style events are emitted for items that already existed before the
  watch was configured

This avoids surprise webhook floods the first time a watch runs.

### Success and failure handling

On success:

- `last_success_at` is updated
- `consecutive_failures` resets to `0`
- `last_error_code` and `last_error_message` are cleared
- `next_poll_at` is computed from the interval or next cron occurrence

On failure:

- `consecutive_failures` increments
- `last_error_code` and `last_error_message` are recorded
- `next_poll_at` is pushed forward using exponential backoff
- watch polling backoff reuses the same retry config used for deliveries:
  `INITIAL_BACKOFF_SECONDS` and `MAX_BACKOFF_SECONDS`

There is no watch-level max-attempt ceiling. Failed watches remain active and
continue retrying with backoff until paused, removed, or successfully polled.

## Entity normalization and event emission

The poller converts each upstream LinkedIn payload into a normalized
`ActivityEntityRecord` with:

- `entityKey`: stable per-watch entity identifier
- `entityType`: one of `thread`, `message`, `notification`, `invitation`,
  `connection`, `profile`, or `post`
- `fingerprint`: stable SHA-256 hash of the normalized snapshot
- `snapshot`: canonical object stored in SQLite and reused in event payloads
- `url`: optional operator-facing deep link

### Watch-kind behavior

| Watch kind | Source service | Stored entity types | Event behavior |
| --- | --- | --- | --- |
| `notifications` | `notifications.listNotifications()` | `notification` | emits `item.created` for new notifications and `read_changed` when `is_read` flips |
| `pending_invitations` | `connections.listPendingInvitations()` | `invitation` | emits `invitation.received` for new received invites and `invitation.sent_changed` for new or updated sent invites |
| `accepted_invitations` | `followups.listAcceptedConnections()` | `invitation` | emits `invitation.accepted` when a newly seen accepted connection enters the lookback window |
| `connections` | `connections.listConnections()` | `connection` | emits `connections.connected` for newly seen connections |
| `profile_watch` | `profile.viewProfile()` | `profile` | emits `profile.snapshot.changed` on any fingerprint change after baseline |
| `feed` | `feed.viewFeed()` | `post` | emits `post.appeared` for new posts and `post.engagement_changed` when reactions, comments, or repost counts change |
| `inbox_threads` | `inbox.listThreads()` plus `inbox.getThread()` | `thread`, `message` | emits `thread.created`, `thread.updated`, and `message.received`; after baseline it only fetches thread details for newly created or updated threads |

### Diffing model

`diffActivityEntities()` compares the current entity set against
`activity_entity_state` rows by `entity_key` and `fingerprint`.

This produces three buckets:

- `created`
- `updated`
- `unchanged`

The poller does **not** currently emit delete events when an entity disappears.
That keeps the first production version conservative for noisy sources like feed
or notifications.

### Event payloads

Inserted `activity_event` rows use the envelope shape documented in
`docs/activity-webhooks.md`, including:

- `id`
- `version` (`2026-03-activity-v1`)
- `type`
- `occurred_at`
- `profile_name`
- `watch.id` and `watch.kind`
- `entity.key`, `entity.type`, and optional `entity.url`
- `change.kind`, `change.previous`, and `change.current`
- `meta.correlation_id`, `meta.poll_started_at`, and `meta.poll_finished_at`

Each event also gets a stable fingerprint derived from the watch id, event type,
entity key, change kind, and the previous/current snapshots. That fingerprint is
uniquely indexed in SQLite to suppress duplicate event inserts.

## Delivery model

### Subscription behavior

Each `webhook_subscription` row is bound to one watch and contains:

- an event allowlist in `event_types_json`
- the destination `delivery_url`
- the raw `signing_secret`
- a per-subscription `max_attempts`
- last-success and last-error summary fields for operator diagnostics

When one event is emitted, the poller enqueues one `webhook_delivery_attempt`
row per active subscription whose allowlist contains that event type.

### Queue states

Delivery attempts move through these statuses:

- `deferred`: stored, but held back because queued pending work already hit the
  queue-depth cap
- `pending`: ready to be claimed and sent
- `leased`: currently claimed by a worker
- `retrying`: prior attempt failed retryably and a later retry row has been
  inserted
- `delivered`: final success
- `failed`: final non-retryable failure
- `dead_letter`: retry budget exhausted after a retryable failure

### Delivery result handling

`deliverWebhook()` sends a signed JSON `POST` request and classifies the result:

- `2xx` -> `delivered`
- network failure or timeout -> `retry`
- `408`, `409`, `425`, `429`, `5xx` -> `retry`
- other `4xx` -> `failed`
- `410 Gone` -> `failed` and subscription is set to `disabled`

When a retryable failure occurs and the current `attempt_number` is still below
the subscription's `max_attempts`:

1. the current attempt row is marked `retrying`
2. a new `pending` attempt row is inserted with `attempt_number + 1`
3. `next_attempt_at` is scheduled with exponential backoff

If the retry budget is exhausted, the current leased row is finalized as
`dead_letter`.

### Backpressure

`LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH` applies to queued
`pending` + `leased` attempts.

When an event is emitted and no queue slot remains:

- the delivery row is still inserted
- it is inserted as `deferred`
- a later tick promotes deferred rows back to `pending` once queue slots open

When the queue is already full at the start of a tick, no watches are claimed
that tick.

## Local daemon model

The background daemon is implemented in `packages/cli/src/bin/linkedin.ts`.

### Process model

- `linkedin activity start` spawns a detached `activity __run` process
- the daemon writes a profile-scoped pid file, state file, and JSONL event log
- each loop iteration creates a **fresh core runtime**, runs one tick, then
  closes the runtime again
- sleep between iterations uses `LINKEDIN_ASSISTANT_ACTIVITY_DAEMON_POLL_INTERVAL_SECONDS`

Creating a fresh runtime on every loop keeps browser/session/resource cleanup
behavior aligned with the rest of the CLI and avoids holding one long-lived
runtime graph open indefinitely.

### State model

The daemon writes an `ActivityDaemonState` object containing:

- pid and profile name
- daemon status (`starting`, `running`, `idle`, `degraded`, `stopped`)
- resolved daemon poll interval, per-tick watch cap, and per-tick delivery cap
- consecutive failure counters
- last tick timestamps and last summary
- last error message when relevant
- optional `cdpUrl` when attached to an external browser session

The daemon becomes `degraded` when:

- the last successful tick contained failed watches, failed deliveries, or dead
  letters, or
- the daemon loop hit the consecutive-failure threshold (`5`)

`status` and `stop` also handle stale pid recovery. `stop` escalates to
`SIGKILL` after 5 seconds if the daemon ignores `SIGTERM`.

### Diagnostics and redaction

Persisted daemon state and JSONL event-log entries are sanitized before they are
written to disk. Secret-bearing CDP URLs have credentials, query tokens, and
fragments removed so daemon diagnostics do not leak those secrets.

## SQLite schema

The activity system is stored in `state.sqlite` by default.

### `activity_watch`

Durable definition of one polling source.

Key columns:

- `id`
- `profile_name`
- `kind`
- `target_json`
- `schedule_kind`
- `poll_interval_ms`
- `cron_expression`
- `status`
- `next_poll_at`
- `last_polled_at`
- `last_success_at`
- `consecutive_failures`
- `last_error_code`
- `last_error_message`
- `lease_owner`, `leased_at`, `lease_expires_at`
- `created_at`, `updated_at`

Indexes:

- `(profile_name, status, next_poll_at)`
- `(status, next_poll_at)`

### `activity_entity_state`

Last-known normalized snapshot per watch entity.

Key columns:

- `watch_id`
- `entity_key`
- `entity_type`
- `fingerprint`
- `snapshot_json`
- `first_seen_at`
- `last_seen_at`
- `last_emitted_event_id`
- `updated_at`

Constraints and indexes:

- primary key: `(watch_id, entity_key)`
- foreign key to `activity_watch(id)` with `ON DELETE CASCADE`
- index: `(watch_id, entity_type)`

### `activity_event`

Append-only internal event ledger.

Key columns:

- `id`
- `watch_id`
- `profile_name`
- `event_type`
- `entity_key`
- `payload_json`
- `fingerprint`
- `occurred_at`
- `created_at`

Constraints and indexes:

- foreign key to `activity_watch(id)` with `ON DELETE CASCADE`
- unique index on `fingerprint`
- index: `(watch_id, created_at)`
- index: `(profile_name, created_at)`

### `webhook_subscription`

One destination bound to one watch.

Key columns:

- `id`
- `watch_id`
- `status`
- `event_types_json`
- `delivery_url`
- `signing_secret`
- `max_attempts`
- `last_delivered_at`
- `last_error_code`
- `last_error_message`
- `created_at`, `updated_at`

Constraints and indexes:

- foreign key to `activity_watch(id)` with `ON DELETE CASCADE`
- index: `(watch_id, status)`

### `webhook_delivery_attempt`

Durable per-attempt delivery history and retry queue.

Key columns:

- `id`
- `watch_id`
- `profile_name`
- `subscription_id`
- `event_id`
- `event_type`
- `delivery_url`
- `payload_json`
- `attempt_number`
- `status`
- `response_status`
- `response_body_excerpt`
- `next_attempt_at`
- `lease_owner`, `leased_at`, `lease_expires_at`
- `last_attempt_at`
- `last_error_code`
- `last_error_message`
- `created_at`, `updated_at`

Constraints and indexes:

- unique key: `(subscription_id, event_id, attempt_number)`
- foreign key to `activity_watch(id)` with `ON DELETE CASCADE`
- foreign key to `webhook_subscription(id)` with `ON DELETE CASCADE`
- foreign key to `activity_event(id)` with `ON DELETE CASCADE`
- index: `(profile_name, status, next_attempt_at)`
- index: `(subscription_id, created_at)`
- index: `(event_id, attempt_number)`

### Cascade implications

Because the activity tables use foreign-key cascades:

- removing one watch removes its entity-state rows, event rows, subscriptions,
  and delivery attempts
- removing one subscription removes its delivery attempts
- deleting an event also deletes any delivery-attempt rows still referencing it

## Public surfaces

### CLI

The CLI owns:

- watch CRUD
- webhook CRUD
- event and delivery history
- one-off polling with `run-once` / `tick`
- daemon start, status, and stop
- human-readable operator output

### MCP

The MCP server exposes management and inspection tools, plus a one-off poll:

- `linkedin.activity_watch.create`
- `linkedin.activity_watch.list`
- `linkedin.activity_watch.pause`
- `linkedin.activity_watch.resume`
- `linkedin.activity_watch.remove`
- `linkedin.activity_webhook.create`
- `linkedin.activity_webhook.list`
- `linkedin.activity_webhook.pause`
- `linkedin.activity_webhook.resume`
- `linkedin.activity_webhook.remove`
- `linkedin.activity_events.list`
- `linkedin.activity_deliveries.list`
- `linkedin.activity_poller.run_once`

Daemon lifecycle is intentionally **not** exposed over MCP.

### Core API

Programmatic callers can use:

- `runtime.activityWatches.createWatch()`
- `runtime.activityWatches.listWatches()`
- `runtime.activityWatches.createWebhookSubscription()`
- `runtime.activityWatches.listEvents()`
- `runtime.activityWatches.listDeliveries()`
- `runtime.activityPoller.runTick()`

See `packages/core/README.md` for a compact usage example.
