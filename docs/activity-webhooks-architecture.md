# LinkedIn activity webhooks architecture

Research for GitHub issue #158 (parent issue #86).

## Executive summary

The repository already has most of the read-side primitives needed for a
poll-based webhook system:

- read-only LinkedIn services for inbox, notifications, connections, feed,
  profile, search, and jobs
- a local SQLite state store with migration support
- a local daemon pattern for scheduler and keepalive workflows
- structured logs, per-run artifacts, retry/backoff helpers, and profile-lock
  safety

The main gap is not browser automation. The main gap is a durable eventing
layer between **LinkedIn reads** and **outbound webhook delivery**.

The recommended design is a local, operator-visible daemon that:

1. polls one or more durable **activity watches** using the existing read-only
   service methods
2. compares the current normalized state with the last-known persisted state
3. records internal **activity events** in SQLite
4. fans those events out to one or more **webhook subscriptions**
5. delivers them over HTTP with signatures, retries, and delivery history

This should stay separate from the existing two-phase commit system. Webhooks
are read-side notifications only; they must not prepare or confirm outbound
LinkedIn actions.

## Current codebase findings

### Existing read capabilities

The current core runtime already exposes the read surfaces needed for phase 1:

| Source | Current service | Returned identity/state | Poll suitability | Notes |
| --- | --- | --- | --- | --- |
| Inbox | `linkedinInbox.ts` → `listThreads()` and `getThread()` | `thread_id`, `unread_count`, `snippet`, thread URL, per-message author/time/text | High | Best source for new-message and thread-updated events |
| Notifications | `linkedinNotifications.ts` → `listNotifications()` | `id`, `type`, `message`, `timestamp`, `link`, `is_read` | High | Good source for new-notification and read-state changes |
| Pending invitations | `linkedinConnections.ts` → `listPendingInvitations()` | profile URL, vanity name, direction (`sent`/`received`) | Medium-high | Good source for invitation received/sent/withdrawn state changes |
| Accepted invitations | `linkedinFollowups.ts` + `sent_invitation_state` | `profile_url_key`, `accepted_at_ms`, `accepted_detection`, follow-up status | Medium | Strongest current acceptance-tracking path, but only for invitations originally sent through the tool |
| Connections list | `linkedinConnections.ts` → `listConnections()` | profile URL, name, headline, connected-since | Medium | Good fallback for connection-added diffs |
| Profile watch | `linkedinProfile.ts` → `viewProfile()` | headline, location, about, experience, education | Medium | Good for targeted profile watches, not global account activity |
| Feed | `linkedinFeed.ts` → `viewFeed()` and `viewPost()` | `post_id`, author, text, counts, post URL | Low-medium | Personalized ordering makes generic feed webhooks noisy |

Other read features exist (`linkedinSearch.ts`, `linkedinJobs.ts`), but they are
better treated as explicit queries than always-on activity sources.

### Important constraints already visible in the codebase

- The runtime is keyed primarily by `profileName`, not by a canonical
  cross-surface account id.
- Background work already follows a local-daemon pattern in the scheduler and
  keepalive flows.
- `ProfileManager` enforces a profile lock for persistent contexts, so any new
  poller must treat lock contention as a normal retryable condition.
- The existing scheduler already has durable leasing/retry concepts in
  `scheduler_job`, but its current service implementation is intentionally
  narrow and follow-up-specific.
- There is already a diff-and-snapshot precedent in the read-only live
  validation workflow, which persists a rolling report and computes diffs
  against the previous snapshot.

### What the repo does **not** have yet

- no general event model for read-side changes
- no durable subscription/watch registry for LinkedIn activity
- no webhook signer or delivery queue
- no persistent last-known state for inbox, notifications, feed, or watched
  profiles
- no reusable HTTP retry history for outbound webhook attempts
- no current support for LinkedIn's separate “who viewed your profile” product;
  the existing profile capability is page viewing, not viewer notifications

## Recommended architecture

### Design principles

1. **Stay local and operator-visible.** Match the scheduler model: one local
   daemon per profile, with `start`, `status`, `stop`, and `run-once` CLI
   workflows.
2. **Separate polling from delivery.** LinkedIn reads and webhook POSTs have
   different failure modes and should not share the same in-memory transaction.
3. **Poll once, fan out many.** LinkedIn polling is the expensive/risky part.
   Multiple webhook endpoints should share the same polled watch state.
4. **Persist normalized state, not just raw snapshots.** Fine-grained diffs need
   stable entity keys and stable fingerprints.
5. **Treat read-side false positives as a product risk.** Especially for feed
   and profile watches, the change detector must be conservative.
6. **Keep LinkedIn traffic read-only.** No webhook feature should rely on
   prepare/confirm executors or any outbound LinkedIn mutation.

### Recommended component model

```text
LinkedIn read services
  -> activity watch poller
  -> normalized entity snapshots
  -> internal activity events
  -> delivery fanout
  -> webhook delivery worker
```

Concretely:

- **Activity watch registry** defines *what* to poll on LinkedIn.
- **Poll daemon** decides *when* to poll each watch.
- **Change detector** compares current normalized entities with persisted prior
  entities.
- **Activity event store** records the internal events emitted by the diff.
- **Webhook subscription registry** defines *where* matching events go.
- **Delivery worker** signs, retries, and records outbound deliveries.

## Subscription model

### Why split watches from webhook subscriptions

If three webhook consumers all want inbox events for the same profile, the tool
should poll LinkedIn **once**, not three times. That strongly suggests a split
between:

- **activity watch**: the durable definition of one LinkedIn polling target
- **webhook subscription**: one delivery destination interested in one or more
  event types produced by that watch

### Recommended watch kinds

Phase 1 should support a small, conservative set:

| Watch kind | Source | Scope |
| --- | --- | --- |
| `inbox_threads` | inbox thread list + thread detail | all threads on one profile |
| `notifications` | notification list | all notifications on one profile |
| `pending_invitations` | pending invites | sent, received, or both |
| `accepted_invitations` | accepted sent invitations | invitations already tracked by the local DB |
| `profile_watch` | one profile page | one explicit target profile URL |

The feed should be opt-in and explicitly marked experimental until the eventing
layer proves stable.

### Recommended event types

Phase 1 event types should be semantic, not page-specific:

- `linkedin.inbox.thread.created`
- `linkedin.inbox.thread.updated`
- `linkedin.inbox.message.received`
- `linkedin.notifications.item.created`
- `linkedin.notifications.item.read_changed`
- `linkedin.connections.invitation.received`
- `linkedin.connections.invitation.sent_changed`
- `linkedin.connections.invitation.accepted`
- `linkedin.profile.snapshot.changed`

Optional later event types:

- `linkedin.feed.post.appeared`
- `linkedin.feed.post.engagement_changed`
- `linkedin.connections.connected`

### Watch filters

Each watch should support narrow filters so the poller can stay conservative:

- inbox: unread-only vs all threads, max threads inspected
- notifications: type allowlist, max items inspected
- invitations: `sent`, `received`, or `all`
- profile watch: one exact profile URL
- feed: top-N only, optional author allowlist

## Polling engine

### Runtime model

Use the same operational model as `docs/scheduler.md`:

- CLI owns the daemon loop
- each tick creates a fresh core runtime with `createCoreRuntime()`
- each tick closes the runtime after work completes
- profile-lock contention becomes a normal retryable poll result

This avoids long-lived Playwright contexts and matches the codebase’s existing
local-daemon expectations.

### Polling cadence recommendations

The safest default is **not** “as fast as possible”. The safest default is a
small number of targeted reads with jitter, low page limits, and automatic
backoff when LinkedIn looks slow or challenged.

| Watch kind | Recommended default | Suggested floor | Notes |
| --- | --- | --- | --- |
| `inbox_threads` | 5 minutes | 2 minutes | Highest value source; use small thread limits and only fetch thread detail when the summary changed |
| `notifications` | 10 minutes | 5 minutes | Strong phase-1 candidate; stable list surface and compact payload |
| `pending_invitations` | 15 minutes | 10 minutes | Good signal with lower urgency than inbox |
| `accepted_invitations` | 30 minutes | 15 minutes | More intrusive today because acceptance detection may require profile probing |
| `profile_watch` | 6 hours | 1 hour | Best for explicit tracked profiles, not generic broad polling |
| `feed` (experimental) | 20 minutes | 15 minutes | Personalized ordering makes aggressive polling hard to justify |

Global polling guidance:

- add **±20% jitter** to every watch interval
- cap one tick to a **small number of due watches** per profile
- keep top-level page limits small: for example 10 feed posts, 20 threads,
  20 notifications
- treat auth redirects, challenges, and profile-lock contention as backoff
  signals
- optionally restrict polling to local business hours for low-urgency watches

### Recommended execution order inside one tick

For a single profile, process due watches in this order:

1. inbox
2. notifications
3. pending invitations
4. accepted invitations
5. profile watches
6. feed watches

That order aligns the most time-sensitive but lower-volume sources first.

## Change detection

### Recommended detection strategy

For each watch:

1. call the existing read-only core service
2. normalize the result into stable entity records
3. derive a deterministic `entity_key`
4. derive a deterministic `fingerprint` from only the fields that matter for
   webhook semantics
5. compare against the persisted prior state
6. emit semantic events only when the normalized meaning changed

### Stable entity keys and fingerprints

| Watch kind | Entity key | Fingerprint inputs | Detection notes |
| --- | --- | --- | --- |
| Inbox thread summary | `thread_id` | unread count, snippet, newest message hash | Only fetch full thread detail when summary fingerprint changes or when thread is new |
| Inbox message | `thread_id` + message hash | author, sent_at, normalized text hash | Best event for `message.received` |
| Notification | LinkedIn notification `id`, else fallback hash of link + message + timestamp | type, message, timestamp, link, read state | Prefer new-item and read-changed events; ignore disappearance |
| Pending invitation | normalized `profile_url` + direction | headline + direction + pending state | Use state transitions instead of list position |
| Accepted invitation | `profile_url_key` | accepted flag + accepted_at + detection path | Reuse `sent_invitation_state` whenever possible |
| Profile watch | normalized target URL | headline, location, about, experience hash, education hash | Ignore trivial whitespace/order-only changes |
| Feed post | `post_id`, else canonical post URL | author, text hash, counts bucket | Treat count-only changes as optional low-priority events |

### Event suppression rules

To keep webhook noise low:

- do not emit delete events for disappearing feed or notification items
- do not emit profile events for whitespace-only or section-order-only changes
- do not emit inbox thread updates when only non-semantic UI metadata changed
- do not emit repeated identical acceptance events for already-accepted invites
- optionally bucket feed engagement counters instead of emitting on every raw
  count change

### State persistence options

There are three realistic persistence strategies:

| Option | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| One full snapshot blob per watch | Simple reads/writes | Expensive diffs, weak per-entity history, hard fanout dedupe | Not recommended |
| Per-entity normalized state rows | Precise diffing, selective updates, stable keys | More schema work | **Recommended** |
| Append-only raw poll history only | Great audit trail | Hard to compute current state efficiently | Useful only as a secondary audit layer |

Recommended hybrid:

- keep **current per-entity normalized state** in SQLite for diffing
- keep **append-only activity events** for fanout and observability
- optionally keep **run-scoped artifacts** when a poll or diff fails in a hard
  way

## Webhook delivery

### Delivery contract

Each emitted activity event should produce one delivery attempt per matching
active webhook subscription.

Recommended request shape:

- method: `POST`
- content type: `application/json`
- timeout: short and bounded, for example 10 seconds
- success: any `2xx`
- permanent failure: most `4xx` except `408`, `409`, `425`, and `429`
- retryable failure: network errors, timeouts, `429`, and `5xx`

### Signature scheme

Use an HMAC header similar to common webhook providers:

- `X-LinkedIn-Assistant-Timestamp: <unix-seconds>`
- `X-LinkedIn-Assistant-Signature-256: sha256=<hex>`
- signature input: `<timestamp>.<raw-body>`

This protects against tampering and supports replay-window checks on the
receiver side.

### Suggested headers

- `User-Agent: linkedin-assistant-webhooks/1`
- `X-LinkedIn-Assistant-Event: <event-type>`
- `X-LinkedIn-Assistant-Delivery: <delivery-id>`
- `X-LinkedIn-Assistant-Retry-Count: <n>`

### Payload format

```json
{
  "id": "evt_01J...",
  "version": "2026-03-activity-v1",
  "type": "linkedin.inbox.message.received",
  "occurred_at": "2026-03-09T12:34:56.000Z",
  "profile_name": "default",
  "watch": {
    "id": "watch_01J...",
    "kind": "inbox_threads"
  },
  "entity": {
    "key": "thread:abc123",
    "url": "https://www.linkedin.com/messaging/thread/abc123/"
  },
  "change": {
    "kind": "created",
    "previous": null,
    "current": {
      "thread_id": "abc123",
      "unread_count": 1,
      "snippet": "Thanks — sounds good",
      "messages": [
        {
          "author": "Simon Miller",
          "sent_at": "2026-03-09T12:33:00Z",
          "text": "Thanks — sounds good"
        }
      ]
    }
  },
  "meta": {
    "poll_started_at": "2026-03-09T12:34:00.000Z",
    "poll_finished_at": "2026-03-09T12:34:08.000Z"
  }
}
```

### Retry policy

Recommended defaults:

- max attempts: 6
- backoff: 1 minute → 5 minutes → 15 minutes → 1 hour → 6 hours → 24 hours
- disable subscription automatically only after repeated permanent failures or
  an explicit `410 Gone`
- keep a durable attempt history for operator inspection

## Data model

### Recommended durable tables

#### `activity_watch`

The polling source definition.

| Column | Purpose |
| --- | --- |
| `id` | Stable watch id |
| `profile_name` | Current runtime/account anchor |
| `kind` | `inbox_threads`, `notifications`, `pending_invitations`, `accepted_invitations`, `profile_watch`, `feed` |
| `target_json` | Watch-specific target/filter config |
| `status` | `active`, `paused`, `disabled` |
| `poll_interval_ms` | Watch cadence |
| `next_poll_at` | Next due time |
| `last_polled_at` | Last attempted poll |
| `last_success_at` | Last successful poll |
| `consecutive_failures` | Poll health signal |
| `last_error_code` / `last_error_message` | Recent failure summary |
| `created_at` / `updated_at` | Audit timestamps |

#### `activity_entity_state`

The last-known normalized state per watch entity.

| Column | Purpose |
| --- | --- |
| `watch_id` | Owning watch |
| `entity_key` | Stable normalized key |
| `entity_type` | `thread`, `message`, `notification`, `invitation`, `profile`, `post` |
| `fingerprint` | Stable semantic hash |
| `snapshot_json` | Canonical normalized entity payload |
| `first_seen_at` / `last_seen_at` | State tracking |
| `last_emitted_event_id` | Deduplication help |
| `miss_count` | Optional disappearance suppression |

Primary key should be `(watch_id, entity_key)`.

#### `activity_event`

Append-only internal event ledger.

| Column | Purpose |
| --- | --- |
| `id` | Stable event id |
| `watch_id` | Source watch |
| `profile_name` | Denormalized for querying |
| `event_type` | Semantic event type |
| `entity_key` | Stable entity id |
| `payload_json` | Full event envelope |
| `fingerprint` | Event-level dedupe hash |
| `occurred_at` | Semantic event time |
| `created_at` | Insert time |

#### `webhook_subscription`

One delivery destination.

| Column | Purpose |
| --- | --- |
| `id` | Stable subscription id |
| `watch_id` | Source watch |
| `status` | `active`, `paused`, `disabled` |
| `event_types_json` | Allowlist of event types |
| `delivery_url` | Destination URL |
| `secret_ref` | Reference to env/config/keychain secret, not the raw secret |
| `max_batch_size` | Future batching support |
| `last_delivered_at` | Delivery health |
| `last_error_code` / `last_error_message` | Recent failure summary |
| `created_at` / `updated_at` | Audit timestamps |

#### `webhook_delivery_attempt`

Delivery history and retry state.

| Column | Purpose |
| --- | --- |
| `id` | Delivery attempt id |
| `subscription_id` | Destination |
| `event_id` | Event being delivered |
| `attempt_number` | Retry count |
| `status` | `pending`, `delivered`, `retrying`, `failed`, `dead_letter` |
| `response_status` | HTTP status if present |
| `response_body_excerpt` | Short bounded diagnostic |
| `next_attempt_at` | Retry schedule |
| `last_attempt_at` | Most recent try |
| `created_at` / `updated_at` | Audit timestamps |

### Relationship to existing tables

- `prepared_action` remains unchanged; webhook delivery is not a two-phase
  commit action.
- `sent_invitation_state` should remain the source of truth for accepted sent
  invitation tracking until a broader event store exists.
- `scheduler_job` is a reusable design reference for leasing and retry logic,
  but phase 1 does **not** need to force the entire poller into the current
  scheduler implementation.
- `run_log` and `artifact_index` remain useful for per-run observability.

## Integration points with the existing automation layer

### Core

Recommended new core modules:

- `packages/core/src/activityWatches.ts`
- `packages/core/src/activityPoller.ts`
- `packages/core/src/activityDiff.ts`
- `packages/core/src/webhookDelivery.ts`

And a new runtime surface in `packages/core/src/runtime.ts`, for example:

- `runtime.activityWatches`
- `runtime.activityPoller`
- `runtime.webhooks`

### Existing services to reuse directly

- `runtime.inbox.listThreads()`
- `runtime.inbox.getThread()`
- `runtime.notifications.listNotifications()`
- `runtime.connections.listPendingInvitations()`
- `runtime.connections.listConnections()`
- `runtime.followups.listAcceptedConnections()`
- `runtime.profile.viewProfile()`
- `runtime.feed.viewFeed()` and `runtime.feed.viewPost()`

That reuse is important: the new system should start by consuming existing
service outputs rather than building a second independent layer of selectors.

### CLI

The best match is the scheduler lifecycle pattern:

- `linkedin activity start --profile <profile>`
- `linkedin activity status --profile <profile>`
- `linkedin activity run-once --profile <profile>`
- `linkedin activity stop --profile <profile>`
- `linkedin activity watch add|list|remove`
- `linkedin activity webhook add|list|pause|resume|remove`
- `linkedin activity deliveries list|retry`

### MCP

Phase 1 does not need an MCP daemon tool. MCP should focus on management and
inspection:

- create/list/pause/remove watches
- create/list/pause/remove subscriptions
- inspect recent events and delivery failures
- trigger a safe `run_once` for diagnostics

## Risk assessment

### Detection risk

Highest-risk sources:

1. accepted-invitation detection that requires profile probing
2. frequent inbox polling
3. home feed polling on a personalized ranked surface

Mitigations:

- conservative defaults and per-watch jitter
- low item limits and incremental fetches
- local business-hours gating for low-priority watches
- back off aggressively on auth redirects, challenge pages, and lock contention
- share one watch across many webhook subscriptions
- prefer notification/inbox/profile watches before feed-heavy coverage

### Reliability risk

Main reliability concerns:

- selector drift across localized UIs
- missing or unstable notification ids
- feed reorder churn causing false create/delete events
- profile page formatting changes causing noisy diffs
- webhook receiver downtime or repeated `429` responses

Mitigations:

- normalize aggressively and diff semantically, not by raw DOM order
- reuse the existing selector-locale infrastructure
- record run logs and artifacts on hard failures
- keep delivery retries independent from poll success
- start with event types that already have strong stable identifiers

### Data-model and product edge cases

- a message can change thread snippet without representing a meaningful new
  inbound message
- notifications can be marked read without any new LinkedIn activity
- accepted connection detection is strongest only for invitations the tool
  already tracked locally
- profile diffs can be triggered by reordered experience entries or truncated
  text
- the current repo does not yet have a canonical account id shared across
  profile-based and stored-session-based flows

### Phase-1 scope recommendation

Ship in this order:

1. `notifications`
2. `inbox_threads`
3. `pending_invitations`
4. `profile_watch`
5. `accepted_invitations`
6. `feed` only after the first five are stable

That ordering balances user value with detection and false-positive risk.

## Final recommendation

For issue #86, the safest architecture is:

- a **local daemon** per profile
- a split between **activity watches** and **webhook subscriptions**
- **normalized per-entity state** in SQLite for change detection
- **append-only activity events** for fanout and observability
- **signed webhook delivery with independent retries**
- reuse of the existing read-only LinkedIn services instead of new selectors

The most important non-obvious product choice is to treat polling as a shared
watch layer, not as a property of each individual webhook destination. That is
what keeps LinkedIn traffic low enough to stay compatible with the project’s
safety-first posture.
