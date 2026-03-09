# Scheduled follow-ups

The scheduler is a **local, operator-visible daemon** for accepted-connection
follow-ups.

It does three things:

- refreshes accepted sent-invitation state
- queues one local scheduler job per accepted connection that still needs a
  follow-up
- prepares due follow-ups near the configured review window

It does **not** send messages automatically. Every prepared action still goes
through `linkedin actions confirm`.

Use this guide when you need to:

- start or inspect the local follow-up scheduler from the CLI
- tune scheduler timing, business hours, or retry behavior
- embed the scheduler service from `@linkedin-assistant/core`
- understand how the scheduler queue relates to follow-up state and two-phase
  confirmation

## Quickstart

Run a one-off scheduler tick:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin scheduler run-once --profile default
```

Start the background daemon and inspect the queue:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin scheduler start --profile default
npm exec -w @linkedin-assistant/cli -- linkedin scheduler status --profile default --jobs 10
```

Stop the daemon when you are done:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin scheduler stop --profile default
```

Notes:

- interactive terminals default to human-readable scheduler summaries
- use `--json` on `start`, `status`, `run-once`, or `stop` for automation
- `run-once` has a `tick` alias: `linkedin scheduler tick --profile default`
- prepared work keeps the same confirm-time safety model; the scheduler itself
  never sends messages automatically
- the scheduler is CLI-only today; there is no dedicated MCP scheduler daemon
  tool

## Timing model

Follow-up preparation stays tied to the existing accepted-connection flow.

For each accepted sent invitation that still needs a follow-up:

1. the scheduler discovers or refreshes acceptance state
2. it creates or updates one `scheduler_job` row for that connection
3. the job becomes due at `accepted_at + followupDelayMs`
4. the due time is snapped forward into the configured business-hours window
5. when the job is claimed, the scheduler prepares the follow-up and stores the
   prepared action id

If the runtime is busy, the profile is locked, or a transient failure happens,
the job is rescheduled with backoff instead of being sent automatically.

## Configuration

Scheduler config is environment-driven and resolved in
`packages/core/src/config.ts`.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `LINKEDIN_ASSISTANT_SCHEDULER_ENABLED` | `true` | Master on/off switch for scheduler work |
| `LINKEDIN_ASSISTANT_SCHEDULER_ENABLED_LANES` | `followup_preparation` | Comma-separated enabled lanes; set to an empty string to disable all lanes |
| `LINKEDIN_ASSISTANT_SCHEDULER_POLL_INTERVAL_SECONDS` | `300` | Background daemon poll interval |
| `LINKEDIN_ASSISTANT_SCHEDULER_MAX_JOBS_PER_TICK` | `2` | Maximum due jobs leased and processed in one tick |
| `LINKEDIN_ASSISTANT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE` | `100` | Cap on pending + leased + prepared scheduler jobs for one profile |
| `LINKEDIN_ASSISTANT_SCHEDULER_LEASE_SECONDS` | `120` | Lease TTL for claimed jobs before another worker may reclaim them |
| `LINKEDIN_ASSISTANT_SCHEDULER_FOLLOWUP_DELAY_MINUTES` | `15` | Delay after acceptance before a follow-up job becomes due |
| `LINKEDIN_ASSISTANT_SCHEDULER_FOLLOWUP_LOOKBACK_DAYS` | `30` | Accepted-connection discovery window used during refresh |
| `LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_START` | `09:00` | Inclusive local business-hours start time (`HH:MM`) |
| `LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_END` | `17:00` | Exclusive local business-hours end time (`HH:MM`) |
| `LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE` | local system timezone | IANA timezone used for business-hours evaluation; falls back to `UTC` only if the local timezone cannot be resolved |
| `LINKEDIN_ASSISTANT_SCHEDULER_MAX_ATTEMPTS` | `5` | Maximum attempts before a job is marked failed |
| `LINKEDIN_ASSISTANT_SCHEDULER_INITIAL_BACKOFF_SECONDS` | `300` | Initial retry backoff for retryable failures |
| `LINKEDIN_ASSISTANT_SCHEDULER_MAX_BACKOFF_SECONDS` | `21600` | Maximum retry backoff cap |

Current lane guidance:

- keep `followup_preparation` enabled for the shipped scheduler flow
- other supported lane names are reserved for future scheduler queues and do
  not add useful work in the current build

Example shell configuration:

```bash
export LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE=Europe/Copenhagen
export LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_START=08:30
export LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_END=16:30
export LINKEDIN_ASSISTANT_SCHEDULER_POLL_INTERVAL_SECONDS=180
export LINKEDIN_ASSISTANT_SCHEDULER_FOLLOWUP_DELAY_MINUTES=30

npm exec -w @linkedin-assistant/cli -- linkedin scheduler start --profile default
```

## CLI workflow

### `linkedin scheduler start`

Starts a detached daemon for one profile. The daemon wakes up on the configured
poll interval, creates a fresh core runtime for each tick, and writes state and
event logs under the scheduler directory inside `LINKEDIN_ASSISTANT_HOME`.

### `linkedin scheduler status`

Shows:

- daemon state and health
- resolved scheduler config or config validation errors
- queue counts grouped by status
- upcoming jobs and recent history for the selected profile

Use `--jobs <count>` to control how many queued and recent jobs are shown.

### `linkedin scheduler run-once`

Runs one immediate scheduler pass without starting the daemon. This is the
fastest way to validate config, discover accepted invitations, or prepare any
due follow-ups on demand.

### `linkedin scheduler stop`

Stops the daemon, cleans up stale PID state when safe, and leaves already
prepared follow-up actions untouched.

## Core API

Programmatic integrations can run one scheduler tick directly from
`@linkedin-assistant/core`:

```ts
import {
  LinkedInSchedulerService,
  createCoreRuntime,
  resolveSchedulerConfig
} from "@linkedin-assistant/core";

const runtime = createCoreRuntime();

try {
  const scheduler = new LinkedInSchedulerService({
    db: runtime.db,
    logger: runtime.logger,
    followups: runtime.followups,
    schedulerConfig: resolveSchedulerConfig()
  });

  const result = await scheduler.runTick({ profileName: "default" });
  console.log(result);
} finally {
  runtime.close();
}
```

Important behavior:

- `LinkedInSchedulerService` runs a single tick; the CLI owns the daemon loop
- `resolveSchedulerConfig()` reads the environment and validates scheduler-only
  settings before work starts
- the scheduler prepares actions through the same two-phase commit flow used by
  `linkedin followups prepare`

## Architecture

The scheduler subsystem is deliberately narrow in phase 1.

### Safety model

- `packages/core/src/linkedinFollowups.ts` remains the source of truth for
  accepted-connection follow-up preparation
- `packages/core/src/scheduler.ts` only decides **when** to prepare work, not
  how to confirm or execute it
- `linkedin actions confirm` remains the only way to send the prepared message

### Storage model

- `sent_invitation_state` keeps invitation discovery, acceptance detection, and
  follow-up lifecycle state
- `scheduler_job` stores due times, leasing, retries, prepared action ids, and
  queue status
- dedupe keys ensure one active scheduler job per profile + accepted connection

### Runtime model

- the scheduler daemon is local-only and CLI-owned
- each daemon tick creates a fresh core runtime instead of keeping one long-
  lived runtime open forever
- profile lock contention is treated as a retryable, expected scheduler
  condition

### Business-hours and retries

- due follow-up jobs are aligned into the configured local business-hours window
- retryable failures use exponential backoff capped by
  `LINKEDIN_ASSISTANT_SCHEDULER_MAX_BACKOFF_SECONDS`
- invalid scheduler env vars fail fast with structured config errors that are
  surfaced in both human and JSON CLI output

## Files and observability

By default, scheduler state lives under:

- `~/.linkedin-assistant/linkedin-owa-agentools/scheduler/*.pid`
- `~/.linkedin-assistant/linkedin-owa-agentools/scheduler/*.state.json`
- `~/.linkedin-assistant/linkedin-owa-agentools/scheduler/*.events.jsonl`

The CLI `status` command also reports the exact state and event-log paths for
the selected profile.
