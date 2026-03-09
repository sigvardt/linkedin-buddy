# Activity webhooks

LinkedIn does not expose native webhooks for inbox, notifications, connections,
profile changes, or feed activity, so this feature uses a conservative local
poller plus durable local state.

## What it does

- stores one or more **activity watches** per profile
- polls LinkedIn on each watch schedule
- diffs the latest LinkedIn snapshot against the last known state
- writes durable **activity events** when changes are detected
- fans each event out to matching **webhook subscriptions**
- signs webhook requests and retries retryable delivery failures

## Supported watch kinds

- `inbox_threads`
- `notifications`
- `pending_invitations`
- `accepted_invitations`
- `connections`
- `profile_watch`
- `feed`

## Supported event types

- `linkedin.inbox.thread.created`
- `linkedin.inbox.thread.updated`
- `linkedin.inbox.message.received`
- `linkedin.notifications.item.created`
- `linkedin.notifications.item.read_changed`
- `linkedin.connections.invitation.received`
- `linkedin.connections.invitation.sent_changed`
- `linkedin.connections.invitation.accepted`
- `linkedin.connections.connected`
- `linkedin.profile.snapshot.changed`
- `linkedin.feed.post.appeared`
- `linkedin.feed.post.engagement_changed`

## Quickstart

Create a watch:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind notifications \
  --interval-seconds 600
```

Create a webhook subscription for that watch:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook add \
  --watch <watch-id> \
  --url https://example.com/hooks/linkedin
```

Run one tick immediately:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity run-once --profile default
```

Start the local daemon:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity start --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity status --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity stop --profile default
```

Inspect local event and delivery history:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity events --profile default --limit 20
npm exec -w @linkedin-assistant/cli -- linkedin activity deliveries --profile default --limit 20
```

## Watch targets

Each watch kind accepts a JSON object target.

Examples:

```bash
# Only unread inbox threads, and inspect 15 messages when a thread changes
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind inbox_threads \
  --target '{"unreadOnly":true,"limit":10,"messageLimit":15}'

# Track one profile snapshot
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind profile_watch \
  --target '{"target":"https://www.linkedin.com/in/example-person/"}'

# Track only sent invitations
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add \
  --profile default \
  --kind pending_invitations \
  --target '{"direction":"sent"}'
```

You can also load the target from a file with `--target-file path/to/target.json`.

## Configuration

Environment variables:

- `LINKEDIN_ASSISTANT_ACTIVITY_ENABLED=true|false`
- `LINKEDIN_ASSISTANT_ACTIVITY_DAEMON_POLL_INTERVAL_SECONDS=300`
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_WATCHES_PER_TICK=10`
- `LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS=120`
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERIES_PER_TICK=50`
- `LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS=120`
- `LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS=15`
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERY_ATTEMPTS=5`
- `LINKEDIN_ASSISTANT_ACTIVITY_INITIAL_BACKOFF_SECONDS=60`
- `LINKEDIN_ASSISTANT_ACTIVITY_MAX_BACKOFF_SECONDS=3600`

Recommendations:

- keep polling conservative to reduce LinkedIn automation risk
- prefer a few shared watches with multiple webhook subscribers
- use `activity run-once` while tuning filters before enabling the daemon

## Webhook request format

The tool sends `POST` requests with `content-type: application/json` and these
headers:

- `x-linkedin-assistant-event`
- `x-linkedin-assistant-delivery`
- `x-linkedin-assistant-retry-count`
- `x-linkedin-assistant-timestamp`
- `x-linkedin-assistant-signature-256`

`x-linkedin-assistant-signature-256` uses:

```text
sha256=<hex hmac of "<timestamp>.<raw-json-payload>">
```

The body includes:

- event id and version
- event type
- timestamp
- profile name
- watch id and kind
- entity key/type/url
- current snapshot and previous snapshot for the detected change
- poll timing metadata

## Local files

The daemon keeps local state under:

- `~/.linkedin-assistant/linkedin-owa-agentools/activity/`

That directory contains the daemon pid, state, and event log. Durable watch,
event, and delivery records live in the shared SQLite database.

## MCP

The MCP server exposes activity watch CRUD, webhook CRUD, event/delivery list,
and `linkedin.activity_poller.run_once` for on-demand execution. Daemon
lifecycle remains a CLI concern.

## More detail

- Setup and operator guide: `docs/activity-webhooks.md`
- Internal design: `docs/activity-webhooks-architecture.md`
- Earlier planning notes: `docs/activity-webhooks-plan.md`
