# Anti-bot evasion

The anti-bot evasion module adds **opt-in behavioral pacing, browser-signal
hardening, and session-aware diagnostics** for Playwright-driven LinkedIn
flows.

The design is intentionally conservative:

- it adds human-like timing and input patterns where the runtime already owns
  the page
- it surfaces the resolved configuration in status and health checks for easy
  inspection
- it fails open when possible so diagnostics do not turn recoverable browser
  glitches into broken operator workflows
- it does **not** solve CAPTCHAs, rotate proxies, spoof network identity, or
  bypass LinkedIn checkpoints by itself

## What the module covers

The evasion system has three layers:

1. **Browser fingerprint hardening**
   - `moderate` removes the `navigator.webdriver` signal
   - `paranoid` adds the `moderate` hardening plus per-session canvas noise
2. **Behavioral timing and movement**
   - Bezier mouse paths with overshoot
   - momentum-style scroll steps
   - idle cursor drift
   - content-proportional reading pauses
   - Poisson-distributed interval sampling with rate-limit-aware backoff
3. **Session management and diagnostics**
   - `createCoreRuntime()` resolves one evasion snapshot for the whole run
   - `runtime.evasion` is injected into auth and health responses
   - `EvasionSession` wraps a single Playwright page with page-level helpers

## Architecture overview

The evasion flow is built around one resolved runtime snapshot and one optional
page session wrapper.

### 1. Configuration resolution

`resolveEvasionConfig()` combines three inputs into one `EvasionStatus` object:

- built-in defaults
- environment variables
- explicit runtime options

Precedence is:

1. `createCoreRuntime({ evasionLevel, evasionDiagnostics })`
2. `LINKEDIN_BUDDY_EVASION_LEVEL` and
   `LINKEDIN_BUDDY_EVASION_DIAGNOSTICS`
3. built-in defaults

The resolved object includes:

- `level`
- `source`
- `diagnosticsEnabled`
- `enabledFeatures`
- `disabledFeatures`
- `profile`
- `summary`

### 2. Runtime wiring

`createCoreRuntime()` stores the resolved snapshot on `runtime.evasion`. That
same snapshot is then surfaced through:

- `runtime.auth.status()` as top-level `evasion`
- `runtime.healthCheck()` as `session.evasion`
- CLI `linkedin status` and `linkedin health`
- MCP `linkedin.session.status` and `linkedin.session.health`

These read-only status and health flows **report the active evasion config but
do not inject synthetic input or fingerprint changes into the inspected page**.

### 3. Page-level execution

`EvasionSession` is the page wrapper used by custom Playwright flows when you
want the behavior layer itself.

Typical sequence:

```ts
import { EvasionSession, createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime({
  evasionLevel: "moderate",
  evasionDiagnostics: true
});

const session = new EvasionSession(page, runtime.evasion.level, {
  diagnosticsEnabled: runtime.evasion.diagnosticsEnabled,
  diagnosticsLabel: "feed",
  logger: runtime.logger
});

await session.hardenFingerprint();
await session.moveMouse({ x: 0, y: 0 }, { x: 240, y: 160 });
await session.scroll(320);
await session.readingPause(500);
```

The public page helpers cover:

- `hardenFingerprint()`
- `moveMouse()`
- `scroll()`
- `idle()`
- `simulateTabSwitch()`
- `simulateViewportJitter()`
- `readingPause()`
- `sampleInterval()`
- `detectCaptcha()`
- `findHoneypotFields()`

### 4. Fail-open behavior

The session wrapper is intentionally defensive:

- out-of-range scroll distances are clamped instead of throwing
- mouse coordinates are normalized and viewport-clamped when possible
- failed mouse moves and timer calls are logged when diagnostics are enabled
- fingerprint hardening is deduplicated per session

That keeps diagnostics actionable without making recoverable browser issues more
disruptive than the underlying LinkedIn workflow.

## Profile matrix

The default evasion level is `moderate`.

| Level | Intended use | Fingerprint hardening | Mouse/scroll behavior | Timing behavior | Extra signals |
| --- | --- | --- | --- | --- | --- |
| `minimal` | deterministic development and test flows | disabled | straight mouse moves, no momentum scroll, no idle drift | fixed intervals, no reading pauses | no tab blur, no viewport jitter |
| `moderate` | default production balance | `navigator.webdriver` hardening | Bezier moves, `0.15` overshoot, `3px` jitter, momentum scroll, idle drift | Poisson timing, reading pauses at `230 WPM` | no synthetic tab blur, no viewport jitter |
| `paranoid` | more aggressive environments | `moderate` hardening plus canvas noise | Bezier moves, `0.25` overshoot, `6px` jitter, momentum scroll, idle drift | Poisson timing, reading pauses at `200 WPM` | synthetic tab blur and viewport resize events |

The stable feature names surfaced in status output are:

- `bezier_mouse_movement`
- `momentum_scroll`
- `tab_blur_simulation`
- `viewport_resize_simulation`
- `idle_drift`
- `reading_pauses`
- `poisson_timing`
- `fingerprint_hardening`

## Configuration reference

### Environment variables

| Variable | Values | Default | Notes |
| --- | --- | --- | --- |
| `LINKEDIN_BUDDY_EVASION_LEVEL` | `minimal`, `moderate`, `paranoid` | `moderate` | Sets the default evasion profile for CLI, MCP, and any Core caller that does not override it |
| `LINKEDIN_BUDDY_EVASION_DIAGNOSTICS` | strict boolean values such as `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off` | `false` | Enables `evasion.*` debug events in the run log |

Example:

```bash
export LINKEDIN_BUDDY_EVASION_LEVEL=paranoid
export LINKEDIN_BUDDY_EVASION_DIAGNOSTICS=true
```

### Core runtime options

Direct Core callers can override env/default values per runtime:

```ts
import { createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime({
  evasionLevel: "minimal",
  evasionDiagnostics: false
});
```

### Resolved status fields

Every surfaced evasion snapshot uses the same shape:

| Field | Meaning |
| --- | --- |
| `level` | effective level after precedence is applied |
| `source` | where the level came from: `default`, `env`, or `option` |
| `diagnosticsEnabled` | whether verbose `evasion.*` events should be logged |
| `enabledFeatures` / `disabledFeatures` | stable feature-name lists for UI and automation |
| `profile` | concrete numeric and boolean values used by the active level |
| `summary` | human-readable one-line description |

## CLI integration

There is **no standalone `linkedin evasion ...` command group** in the current
CLI.

Instead, the CLI exposes evasion through the session diagnostics commands:

- `linkedin status --profile <name>` returns a top-level `evasion` block
- `linkedin health --profile <name>` returns `session.evasion`

Important CLI behavior:

- there are **no** `--evasion-level` or `--evasion-diagnostics` flags today
- the CLI inherits evasion defaults from environment variables or built-in
  defaults
- the command `--help` text for `status` and `health` points operators to the
  evasion env vars
- enabling diagnostics affects the run log, not the JSON schema

Example:

```bash
LINKEDIN_BUDDY_EVASION_LEVEL=paranoid \
LINKEDIN_BUDDY_EVASION_DIAGNOSTICS=true \
npm exec -w @linkedin-buddy/cli -- linkedin status --profile default
```

Shape to inspect:

```json
{
  "authenticated": true,
  "evasion": {
    "level": "paranoid",
    "source": "env",
    "diagnosticsEnabled": true,
    "enabledFeatures": ["bezier_mouse_movement", "momentum_scroll"]
  }
}
```

## MCP integration

There is **no dedicated `linkedin.evasion.*` MCP tool family** in the current
server.

The evasion snapshot is exposed through the existing session tools:

- `linkedin.session.status` returns `status.evasion`
- `linkedin.session.health` returns `session.evasion`

Important MCP behavior:

- there are **no** per-tool evasion args today
- MCP callers cannot set evasion level or diagnostics in tool input
- the server process inherits env/default-driven evasion settings when it
  starts
- if you need per-run overrides, start the server with env vars or use the Core
  API directly

Start the server with explicit evasion defaults:

```bash
LINKEDIN_BUDDY_EVASION_LEVEL=moderate \
LINKEDIN_BUDDY_EVASION_DIAGNOSTICS=true \
npm exec -w @linkedin-buddy/mcp -- linkedin-buddy-mcp
```

### JSON path reference

| Surface | JSON path |
| --- | --- |
| CLI `linkedin status` | `evasion` |
| CLI `linkedin health` | `session.evasion` |
| MCP `linkedin.session.status` | `status.evasion` |
| MCP `linkedin.session.health` | `session.evasion` |

## Core API notes

The `@linkedin-buddy/core` package exports the evasion building blocks in
three groups:

- **profiles and status** — `DEFAULT_EVASION_LEVEL`, `EVASION_LEVELS`,
  `EVASION_PROFILES`, `createEvasionStatus()`, `resolveEvasionLevel()`,
  `resolveEvasionProfile()`
- **page behavior** — `EvasionSession`, `applyFingerprintHardening()`,
  `simulateMomentumScroll()`, `simulateIdleDrift()`, `simulateTabBlur()`,
  `simulateViewportJitter()`, `detectCaptcha()`, `findHoneypotFields()`
- **timing helpers** — `computeBezierPath()`, `computeMomentumSteps()`,
  `computeReadingPauseMs()`, `samplePoissonInterval()`, `resolveIntervalMs()`

Example status-only usage without a full runtime:

```ts
import { createEvasionStatus, resolveEvasionProfile } from "@linkedin-buddy/core";

const evasion = createEvasionStatus({
  level: "moderate",
  diagnosticsEnabled: true,
  source: "option"
});

const profile = resolveEvasionProfile(evasion.level);
console.log(evasion.summary, profile.mouseOvershootFactor);
```

## Troubleshooting

### LinkedIn still shows a checkpoint, login wall, or CAPTCHA

- use `linkedin status` or `linkedin health` first to inspect `currentUrl`,
  `reason`, `checkpointDetected`, `loginWallDetected`, and `rateLimited`
- remember that the evasion layer does **not** solve CAPTCHA challenges
- in custom Playwright flows, call `detectCaptcha()` and
  `findHoneypotFields()` to stop and alert an operator
- move from `minimal` to `moderate`, then to `paranoid`; do not assume the most
  aggressive profile is always the best fit

### Output shows the wrong level or the wrong source

- inspect `source` first: `default`, `env`, or `option`
- CLI and MCP surfaces do not accept evasion-specific flags or tool args, so
  unexpected values usually come from environment variables or direct Core
  runtime options
- if multiple shells or daemons are involved, confirm the env vars were present
  in the process that created the runtime

### Diagnostics are enabled, but no `evasion.*` events appear

- `status` and `health` only surface the resolved snapshot; they do not trigger
  mouse movement, scrolling, or fingerprint hardening
- `evasion.*` log events appear when an `EvasionSession` is actively used
- ensure diagnostics are enabled via `LINKEDIN_BUDDY_EVASION_DIAGNOSTICS`
  or `createCoreRuntime({ evasionDiagnostics: true })`

Typical events include:

- `runtime.evasion.configured`
- `evasion.session.created`
- `evasion.session.fingerprint_hardening.applied`
- `evasion.session.interval.sampled`
- `evasion.session.captcha.detected`
- `evasion.session.honeypots.detected`
- `evasion.session.operation.failed`

### Tests need deterministic timing

- use `minimal` for repeatable local and CI-style flows
- `minimal` disables behavioral and fingerprint simulation while keeping the
  same status-reporting surface available for assertions

### Scroll or mouse recovery seems unusual

- large scroll requests are clamped by design to avoid unrealistic jumps
- viewport bounds are used when available to keep pointer coordinates valid
- when diagnostics are enabled, look for `.clamped`, `.failed`, and
  `.fallback_to_direct` events in the run log
