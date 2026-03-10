# Anti-bot evasion

The anti-bot evasion module adds opt-in behavioral pacing, browser-signal hardening,
and developer-facing diagnostics for Playwright-driven LinkedIn flows.

## Defaults

The default evasion level is `moderate`.

Available profiles:

- `minimal` keeps behavioral and fingerprint simulation disabled for deterministic
  development and test flows.
- `moderate` enables Bezier mouse movement, momentum scroll, idle drift,
  reading pauses, Poisson timing, and fingerprint hardening.
- `paranoid` enables the `moderate` profile plus synthetic tab blur and
  viewport resize signals with stronger cursor jitter.

## Configuration

Runtime callers can override the defaults through `createCoreRuntime()`:

```ts
import { createCoreRuntime } from "@linkedin-assistant/core";

const runtime = createCoreRuntime({
  evasionLevel: "paranoid",
  evasionDiagnostics: true
});
```

Shell and CLI users can configure the same defaults with environment variables:

- `LINKEDIN_ASSISTANT_EVASION_LEVEL=minimal|moderate|paranoid`
- `LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS=true|false`

`LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS` defaults to `false`, so debug evasion
logs stay quiet unless you opt in.

## Status and health output

The resolved evasion configuration is surfaced in both CLI and MCP status flows:

- `linkedin status` includes a top-level `evasion` block.
- `linkedin health` includes `session.evasion`.
- MCP `linkedin.session.status` includes `status.evasion`.
- MCP `linkedin.session.health` includes `session.evasion`.

These read-only status and health checks report the resolved configuration for
diagnostics, but they do not inject synthetic input or fingerprint hardening into
the inspected page.

## Session diagnostics

`EvasionSession` accepts optional diagnostics controls so callers can trace the
important moments without adding noise by default:

```ts
import { EvasionSession, createCoreRuntime } from "@linkedin-assistant/core";

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
await session.moveMouse({ x: 0, y: 0 }, { x: 200, y: 120 });
await session.scroll(300);
```

When diagnostics are enabled, the run log records high-signal events such as:

- session creation and fingerprint hardening
- clamped scroll distances and rate-limit-aware interval sampling
- detected CAPTCHA or honeypot signals
- fail-open recoveries like rejected mouse moves or timer calls

That makes it easier to understand what the evasion layer attempted without
forcing noisy output into normal CLI runs.
