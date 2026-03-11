# `@linkedin-buddy/core`

Core runtime and automation library for LinkedIn Buddy.

## Activity polling and webhooks

`createCoreRuntime()` exposes durable activity watch management and one-off poll
execution through:

- `runtime.activityWatches`
- `runtime.activityPoller`

Minimal example:

```ts
import { createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime();

try {
  const watch = runtime.activityWatches.createWatch({
    kind: "notifications",
    profileName: "default",
    intervalSeconds: 600
  });

  runtime.activityWatches.createWebhookSubscription({
    watchId: watch.id,
    deliveryUrl: "https://example.com/hooks/linkedin"
  });

  const result = await runtime.activityPoller.runTick({
    profileName: "default"
  });

  console.log(result);
} finally {
  runtime.close();
}
```

Important behavior:

- the first successful poll establishes baseline entity state and does not emit
  create-style events for already-existing items
- `ActivityPollerService` runs one tick; background daemon lifecycle remains a
  CLI concern
- watch CRUD, event history, and delivery history all persist in the shared
  SQLite database

See `../../docs/activity-webhooks.md` for operator workflows and
`../../docs/activity-webhooks-architecture.md` for schema and engine details.

## Human-like typing simulation

`packages/core/src/humanize.ts` exports the humanized Playwright wrapper used
for credential entry and any text-entry flow that opts into
`HumanizedPage.type()`.

What it does:

- adds human-like delays, pointer movement, scrolling, and clicking helpers on
  top of a Playwright `Page`
- types one grapheme at a time with profile-based cadence, pause patterns,
  nearby-key typos, and automatic corrections
- degrades to direct input when simulation would exceed the safety budget or
  when the text is too large for safe per-character replay

Common configuration knobs:

- `typingProfile`: choose `careful`, `casual`, or `fast`
- `typingProfileOverrides`: tune speed, jitter, typo rates, and pause ranges
- `typingDelay` / `typingJitter`: legacy per-character overrides for coarse tuning
- per-call `profile`, `profileOverrides`, and `fieldLabel`

### Usage examples

Balanced default for message composition:

```ts
import { humanize } from "@linkedin-buddy/core";

const hp = humanize(page, { typingProfile: "careful" });
await hp.type('[role="textbox"]', "Thanks for sharing this update.", {
  fieldLabel: "message composer"
});
```

Faster typing with lower variance:

```ts
const hp = humanize(page, {
  typingProfile: "fast",
  typingProfileOverrides: {
    baseCharDelayMs: 38,
    charDelayJitterMs: 12
  }
});

await hp.type('textarea[name="post"]', "Shipping the typing docs today.", {
  fieldLabel: "post composer"
});
```

More reflective pause pattern for longer replies:

```ts
const hp = humanize(page, {
  typingProfile: "casual",
  typingProfileOverrides: {
    thinkingPauseChance: 0.24,
    thinkingPauseRange: { minMs: 450, maxMs: 1400 },
    longPauseChance: 0.05,
    longPauseRange: { minMs: 2500, maxMs: 4500 }
  }
});

await hp.type('[role="textbox"]', "Appreciate the thoughtful write-up.", {
  fieldLabel: "follow-up composer"
});
```

Per-field override for a sensitive input:

```ts
await hp.type('input[name="password"]', password, {
  profile: "careful",
  fieldLabel: "LinkedIn password",
  profileOverrides: {
    shiftLeadRange: { minMs: 25, maxMs: 55 }
  }
});
```

## Anti-bot evasion

`@linkedin-buddy/core` exports an anti-bot evasion module that can be used
independently or alongside `createCoreRuntime()`.

Key entry points:

- `EvasionSession` for page-level behavioral helpers and optional diagnostics
- `DEFAULT_EVASION_LEVEL`, `EVASION_LEVELS`, and `EVASION_PROFILES` for profile selection
- `createEvasionStatus()` and `resolveEvasionConfig()` for resolved config snapshots
- `computeBezierPath()`, `samplePoissonInterval()`, and the other low-level helpers for custom automation flows

Example:

```ts
import { EvasionSession, createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime({
  evasionLevel: "moderate",
  evasionDiagnostics: true
});

const session = new EvasionSession(page, runtime.evasion.level, {
  diagnosticsEnabled: runtime.evasion.diagnosticsEnabled,
  diagnosticsLabel: "message-compose",
  logger: runtime.logger
});

await session.hardenFingerprint();
await session.moveMouse({ x: 0, y: 0 }, { x: 240, y: 140 });
await session.scroll(320);
```

Use `runtime.evasion.summary` for a human-readable snapshot, and inspect
`linkedin status`, `linkedin health`, `linkedin.session.status`, or
`linkedin.session.health` when you want to confirm the resolved runtime config.

`runtime.evasion.source` shows whether the active level came from the built-in
default, an environment variable, or an explicit runtime option.

See `../../docs/evasion.md` for the profile matrix, configuration precedence,
CLI/MCP integration details, and troubleshooting guidance.

## Tier 3 write validation

Tier 3 live write validation is exported from the core package through
`packages/core/src/writeValidation.ts` and `packages/core/src/writeValidationAccounts.ts`.
The main entry points are:

- `runLinkedInWriteValidation()`
- `getWriteValidationActionDefinitions()`
- `loadWriteValidationAccounts()`
- `resolveWriteValidationAccount()`
- `upsertWriteValidationAccount()`

Use the CLI when you need the operator-facing prompt flow. Use the Core API when
you need custom orchestration around the fixed Tier 3 scenario suite.

See `../../docs/write-validation.md` for the complete operator and integration
guide. Composer-based validation flows also exercise the human-like typing
simulation documented above.
