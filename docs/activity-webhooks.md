# Activity webhooks

The LinkedIn activity webhook system is a **local, operator-visible polling and
subscription layer**.

LinkedIn does not expose first-party webhooks for inbox threads,
notifications, invitations, profile changes, or feed updates, so LinkedIn
Assistant builds them by:

- storing durable **activity watches** in SQLite
- polling existing read-only LinkedIn services on a conservative schedule
- diffing the latest normalized snapshot against stored entity state
- appending internal **activity events** when semantic changes are detected
- fanning matching events out to one or more **webhook subscriptions**
- retrying retryable deliveries with bounded backoff and durable history

Use this guide when you need to:

- create, list, pause, resume, or remove activity watches
- attach webhook receivers to one or more watch streams
- poll immediately with the CLI or operate the background daemon
- inspect event and delivery history
- tune intervals, queue depth, leases, retries, and diagnostics

## Quickstart

Create a watch for LinkedIn notifications:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind notifications \
  --interval-seconds 600
```

Attach a webhook receiver:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook add \
  --watch <watch-id> \
  --url https://example.com/hooks/linkedin
```

Poll immediately and inspect history:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity run-once --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity events --profile default --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin activity deliveries --profile default --limit 20
```

Start the local daemon when you want background polling:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity start --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity status --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity stop --profile default
```

Notes:

- interactive terminals default to **human-readable** summaries; add `--json`
  for automation or exact machine parsing
- `linkedin activity run-once` has a `tick` alias:
  `linkedin activity tick --profile default`
- the **first successful poll** establishes baseline state and does not emit
  create-style events for already-existing entities
- daemon lifecycle is CLI-only; MCP exposes management and one-off polling, not
  background start or stop

## Watch kinds, schedules, and targets

Each watch belongs to one profile, one `kind`, and one schedule.

Scheduling rules:

- use either `--interval-seconds` or `--cron`, never both
- omitting both uses the built-in default interval for that watch kind
- cron uses **five fields**:
  `minute hour day-of-month month day-of-week`
- cron supports numbers, ranges, lists, and step values
- day-of-week accepts `0` or `7` for Sunday
- cron evaluation uses the **local time zone of the machine running the CLI**
- the effective minimum interval is `max(kind minimum, LINKEDIN_ASSISTANT_ACTIVITY_MIN_POLL_INTERVAL_SECONDS)`

You can pass the target object inline with `--target '<json>'` or from disk with
`--target-file path/to/target.json`.

| Kind | Default interval | Effective minimum interval | Target object |
| --- | --- | --- | --- |
| `inbox_threads` | `300s` | `120s` | `{ "limit": 10, "messageLimit": 10, "unreadOnly": false }` |
| `notifications` | `600s` | `300s` | `{ "limit": 20 }` |
| `pending_invitations` | `900s` | `600s` | `{ "direction": "all" }` where direction is `all`, `sent`, or `received` |
| `accepted_invitations` | `1800s` | `900s` | `{ "sinceDays": 30 }` up to `365` |
| `connections` | `1200s` | `600s` | `{ "limit": 40 }` |
| `profile_watch` | `21600s` | `3600s` | `{ "target": "https://www.linkedin.com/in/example-person/" }` |
| `feed` | `1200s` | `900s` | `{ "limit": 10 }` up to `20` |

Example targets:

```bash
# Only unread inbox threads, and inspect up to 15 messages per changed thread
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind inbox_threads \
  --target '{"unreadOnly":true,"limit":10,"messageLimit":15}'

# Watch one profile on a daily cron
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind profile_watch \
  --cron '0 9 * * *' \
  --target '{"target":"https://www.linkedin.com/in/example-person/"}'

# Only track sent invitations
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind pending_invitations \
  --target '{"direction":"sent"}'
```

### Event types by watch kind

| Watch kind | Emitted event types |
| --- | --- |
| `inbox_threads` | `linkedin.inbox.thread.created`, `linkedin.inbox.thread.updated`, `linkedin.inbox.message.received` |
| `notifications` | `linkedin.notifications.item.created`, `linkedin.notifications.item.read_changed` |
| `pending_invitations` | `linkedin.connections.invitation.received`, `linkedin.connections.invitation.sent_changed` |
| `accepted_invitations` | `linkedin.connections.invitation.accepted` |
| `connections` | `linkedin.connections.connected` |
| `profile_watch` | `linkedin.profile.snapshot.changed` |
| `feed` | `linkedin.feed.post.appeared`, `linkedin.feed.post.engagement_changed` |

## CLI workflow

### Add a watch

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind notifications \
  --interval-seconds 900
```

Human-readable output includes the watch id, resolved schedule, target, next
poll time, and suggested next steps. JSON output returns the full structured
watch record.

### List, pause, resume, and remove watches

List all watches for a profile:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch list --profile default
```

Filter by status:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch list \
  --profile default \
  --status active
```

Pause, resume, or remove one watch by id:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch pause <watch-id>
npm exec -w @linkedin-assistant/cli -- linkedin activity watch resume <watch-id>
npm exec -w @linkedin-assistant/cli -- linkedin activity watch remove <watch-id>
```

Important behavior:

- `resume` makes the watch **due immediately** by setting `next_poll_at` to now
- create and resume enforce `LINKEDIN_ASSISTANT_ACTIVITY_MAX_CONCURRENT_WATCHES`
- removing a watch deletes its entity state, events, subscriptions, and
  delivery attempts through SQLite foreign-key cascades

### Add, list, pause, resume, and remove webhook subscriptions

Create a subscription:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook add \
  --watch <watch-id> \
  --url https://example.com/hooks/linkedin \
  --event linkedin.notifications.item.created \
  --event linkedin.notifications.item.read_changed
```

Useful options:

- `--event <eventType...>` limits one subscription to specific event types
- `--secret <secret>` uses your own signing secret instead of an auto-generated
  `whsec_...` value
- `--max-attempts <count>` overrides the default delivery attempt ceiling for
  this one subscription

If you omit `--secret`, the CLI generates one, returns it **once**, and the raw
secret is stored locally in SQLite so later delivery attempts can be signed.

List subscriptions:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook list --profile default
```

Filter by watch or status:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook list \
  --profile default \
  --watch <watch-id> \
  --status active
```

Pause, resume, or remove one subscription:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook pause <subscription-id>
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook resume <subscription-id>
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook remove <subscription-id>
```

### Poll now

There is no separate `activity watch poll` subcommand. To poll the due watch set
for a profile immediately, use `run-once` or its `tick` alias:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity run-once --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity tick --profile default --json
```

One tick always processes **webhook deliveries first**, then claims due watches
if queue depth allows. The run summary includes:

- claimed, polled, and failed watch counts
- emitted event and enqueued delivery counts
- claimed, delivered, retried, failed, and dead-letter delivery counts
- per-watch and per-delivery result lines in human output

`run-once` exits non-zero when a watch fails, a delivery fails, or a delivery
is dead-lettered.

### History

Use event history to see what the poller detected:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity events \
  --profile default \
  --watch <watch-id> \
  --limit 20
```

Use delivery history to inspect receiver outcomes and retry state:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity deliveries \
  --profile default \
  --subscription <subscription-id> \
  --status retrying \
  --limit 20
```

Delivery status filters:

- `deferred`
- `pending`
- `delivered`
- `leased`
- `retrying`
- `failed`
- `dead_letter`

History ordering is newest first by `created_at`.

### Daemon lifecycle

Start the detached daemon:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity start --profile default
```

Inspect daemon health, queue counts, config, and file paths:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity status --profile default
```

Stop the daemon:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity stop --profile default
```

Status and stop behavior:

- `status` shows watch counts, webhook counts, recent-history counts, resolved
  config, and any config-validation error details
- `status` flags a **stale PID file** if a saved daemon pid is no longer alive
- `stop` safely removes stale pid files and records that in daemon state
- `stop` escalates from `SIGTERM` to `SIGKILL` after 5 seconds if the daemon
  does not exit cleanly

## Activity output and diagnostics

The activity CLI shares the UX work added in PR #204:

- interactive terminals default to **human-readable summaries**
- non-interactive stdout or explicit `--json` returns structured payloads
- human output is sanitized to strip control characters and ANSI escape
  sequences before rendering potentially remote text
- activity command errors include the structured error code plus targeted
  details like the failing field, env var, allowed values, minimum interval,
  supported watch kinds, or supported event types when available
- human-readable errors end with actionable tips and a reminder to rerun with
  `--json` for the raw structured payload

Examples of diagnostic coverage:

- invalid `deliveryUrl` errors include the expected absolute `http(s)` example
- invalid activity env vars surface in `activity status` under **Config Issue**
- the daemon state and event log files sanitize secret-bearing CDP URLs before
  persisting them, so credentials, tokens, and fragments are not written to
  disk in clear text

Daemon state values:

- `starting`: detached process has been launched and initial state written
- `running`: last tick processed work successfully
- `idle`: no due watches or pending deliveries were found in the last tick
- `degraded`: last tick had failed watches, failed deliveries, dead letters, or
  the daemon hit its consecutive-failure threshold
- `stopped`: daemon exited or was stopped and state was finalized

The daemon marks itself degraded after **5 consecutive loop failures**. A
single successful tick resets the loop-failure counter back to zero.

## Webhook delivery contract

Each webhook is sent as an `HTTP POST` with `content-type: application/json`
and `user-agent: linkedin-assistant-webhooks/1`.

Headers:

- `x-linkedin-assistant-event`
- `x-linkedin-assistant-delivery`
- `x-linkedin-assistant-retry-count`
- `x-linkedin-assistant-timestamp`
- `x-linkedin-assistant-signature-256`

Signature format:

```text
sha256=<hex hmac of "<timestamp>.<raw-json-payload>">
```

Body shape:

```json
{
  "id": "evt_m8qg1r_1a2b3c4d",
  "version": "2026-03-activity-v1",
  "type": "linkedin.notifications.item.created",
  "occurred_at": "2026-03-09T12:34:00.000Z",
  "profile_name": "default",
  "watch": {
    "id": "watch_m8qfzz_9abc1234",
    "kind": "notifications"
  },
  "entity": {
    "key": "notification:123456",
    "type": "notification",
    "url": "https://www.linkedin.com/notifications/"
  },
  "change": {
    "kind": "created",
    "previous": null,
    "current": {
      "id": "123456",
      "type": "mention",
      "message": "Simon Miller mentioned you in a comment",
      "timestamp": "1m",
      "link": "https://www.linkedin.com/notifications/",
      "is_read": false
    }
  },
  "meta": {
    "correlation_id": "pollcorr_m8qg1r_a1b2c3d4",
    "poll_started_at": "2026-03-09T12:34:00.000Z",
    "poll_finished_at": "2026-03-09T12:34:07.000Z"
  }
}
```

Delivery outcomes:

- `2xx` marks the attempt `delivered`
- `408`, `409`, `425`, `429`, and `5xx` are retried
- network failures and request timeouts are retried
- other `4xx` responses fail immediately
- `410 Gone` fails immediately **and disables the subscription**
- response bodies are truncated to a `500` character excerpt before storage

## Configuration

Activity config is resolved in `packages/core/src/config.ts`.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `LINKEDIN_ASSISTANT_ACTIVITY_ENABLED` | `true` | Master on/off switch for activity polling and delivery |
| `LINKEDIN_ASSISTANT_ACTIVITY_DAEMON_POLL_INTERVAL_SECONDS` | `60` | Background daemon wake-up interval |
| `LINKEDIN_ASSISTANT_ACTIVITY_MAX_WATCHES_PER_TICK` | `4` | Maximum due watches claimed in one tick |
| `LINKEDIN_ASSISTANT_ACTIVITY_MAX_CONCURRENT_WATCHES` | `20` | Maximum active watches per profile |
| `LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS` | `120` | Lease TTL for claimed watches |
| `LINKEDIN_ASSISTANT_ACTIVITY_MIN_POLL_INTERVAL_SECONDS` | `60` | Global lower bound for watch interval schedules |
| `LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERIES_PER_TICK` | `12` | Maximum pending deliveries claimed in one tick |
| `LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH` | `250` | Cap on queued `pending` + `leased` deliveries before watch polling backs off |
| `LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS` | `60` | Lease TTL for claimed delivery attempts |
| `LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS` | `10` | Timeout for one outbound webhook POST |
| `LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS` | `5` | Clock-skew allowance when reclaiming expired leases |
| `LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERY_ATTEMPTS` | `6` | Default retry ceiling for newly created webhook subscriptions |
| `LINKEDIN_ASSISTANT_ACTIVITY_INITIAL_BACKOFF_SECONDS` | `60` | Initial exponential backoff for retryable deliveries and watch poll failures |
| `LINKEDIN_ASSISTANT_ACTIVITY_MAX_BACKOFF_SECONDS` | `86400` | Maximum backoff cap for retryable deliveries and watch poll failures |

Validation rules worth knowing:

- `MAX_BACKOFF_SECONDS` must be greater than or equal to `INITIAL_BACKOFF_SECONDS`
- `DELIVERY_LEASE_SECONDS` must be greater than or equal to
  `DELIVERY_TIMEOUT_SECONDS + CLOCK_SKEW_SECONDS`
- `WATCH_LEASE_SECONDS` and `DELIVERY_LEASE_SECONDS` must each be greater than
  `CLOCK_SKEW_SECONDS`

Conservative shell example:

```bash
export LINKEDIN_ASSISTANT_ACTIVITY_DAEMON_POLL_INTERVAL_SECONDS=120
export LINKEDIN_ASSISTANT_ACTIVITY_MAX_WATCHES_PER_TICK=2
export LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERIES_PER_TICK=6
export LINKEDIN_ASSISTANT_ACTIVITY_INITIAL_BACKOFF_SECONDS=120

npm exec -w @linkedin-assistant/cli -- linkedin activity start --profile default
```

## Files and storage

By default, activity daemon files live under:

- `~/.linkedin-assistant/linkedin-owa-agentools/activity/*.pid`
- `~/.linkedin-assistant/linkedin-owa-agentools/activity/*.state.json`
- `~/.linkedin-assistant/linkedin-owa-agentools/activity/*.events.jsonl`

Durable watch, entity-state, event, subscription, and delivery records live in
the shared SQLite database at:

- `~/.linkedin-assistant/linkedin-owa-agentools/state.sqlite`

See `docs/activity-webhooks-architecture.md` for the actual schema, table
relationships, and polling-engine architecture.

## Common workflows

### Validate a new receiver before starting the daemon

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind notifications \
  --interval-seconds 900

npm exec -w @linkedin-assistant/cli -- linkedin activity webhook add \
  --watch <watch-id> \
  --url http://127.0.0.1:8787/hooks/linkedin

npm exec -w @linkedin-assistant/cli -- linkedin activity run-once --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity deliveries --profile default --limit 10
```

This is the safest way to verify endpoint reachability, signatures, and payload
shape before background polling is left running.

### Pause delivery during receiver maintenance

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook pause <subscription-id>
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook list --profile default

# ...fix the receiver...

npm exec -w @linkedin-assistant/cli -- linkedin activity webhook resume <subscription-id>
npm exec -w @linkedin-assistant/cli -- linkedin activity tick --profile default
```

### Track a specific profile daily

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind profile_watch \
  --cron '0 8 * * *' \
  --target '{"target":"https://www.linkedin.com/in/example-person/"}'
```

### Use one watch with multiple consumers

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook add \
  --watch <watch-id> \
  --url https://example.com/hooks/ops

npm exec -w @linkedin-assistant/cli -- linkedin activity webhook add \
  --watch <watch-id> \
  --url https://example.com/hooks/analytics \
  --event linkedin.notifications.item.created
```

This avoids redundant LinkedIn polling while still letting different receivers
subscribe to different slices of the same event stream.

## MCP and core API

The MCP server exposes watch, webhook, history, and one-off poll surfaces:

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

Programmatic core usage is exposed through `createCoreRuntime()` as:

- `runtime.activityWatches`
- `runtime.activityPoller`

See `packages/core/README.md` for a small code example and
`docs/activity-webhooks-architecture.md` for the implementation details.
