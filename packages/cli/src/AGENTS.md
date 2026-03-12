# packages/cli/src — CLI Package

## Overview

Commander-based CLI exposing all core services as terminal commands. 127+ commands across 15 categories.
Entry point: `bin/linkedin.ts` (11,100+ lines — largest file in the repo).

## Files

| File | Purpose |
|------|---------|
| `bin/linkedin.ts` | All CLI commands — search, inbox, feed, jobs, profile, connections, activity, validation, etc. |
| `activityOutput.ts` | Output formatting for activity events and webhooks |
| `writeValidationOutput.ts` | Output formatting for write validation results |
| `draftQualityOutput.ts` | Output formatting for draft quality evaluation |
| `schedulerOutput.ts` | Output formatting for scheduler state |
| `keepAliveOutput.ts` | Output formatting for keep-alive daemon |
| `liveValidationOutput.ts` | Output formatting for live validation |
| `selectorAuditOutput.ts` | Output formatting for selector audit |
| `headlessLoginOutput.ts` | Output formatting for headless login |
| `profileSeed.ts` | Profile seeding for test personas |
| `activitySeed.ts` | Activity seeding for test data |

## Command Pattern

```typescript
program
  .command("feature action <required-arg>")
  .option("--optional-flag <value>", "Description", "default")
  .option("-p, --profile <profile>", "Profile name", "default")
  .action(async (requiredArg, options) => {
    const runtime = createRuntime(options.cdpUrl);
    try {
      const result = await runtime.featureService.method({ profileName: options.profile, ... });
      printJson(result);
    } finally {
      runtime.close();
    }
  });
```

## Adding a New CLI Command

1. Add command definition in `bin/linkedin.ts` under the appropriate group
2. Follow existing pattern: parse args → create runtime → call core service → format output → close runtime
3. Use `--profile` option (default: "default") for all commands
4. Use `--json` flag for structured output
5. For write commands: call `prepare*()` → display preview → print confirm token
6. If output is complex, create a dedicated `*Output.ts` formatter

## Global Options

- `--profile <name>` — Playwright profile (default: "default")
- `--json` — JSON output mode
- `--cdp-url <url>` — External browser CDP endpoint
- `--evasion-level <level>` — off/light/moderate/aggressive
- `--no-evasion` — Disable evasion entirely
- `--selector-locale <locale>` — UI locale (en/da)

## Anti-Patterns

- NEVER create a new entry point file — all commands go in `bin/linkedin.ts`
- NEVER call core services without `try/finally` for `runtime.close()`
- NEVER skip `--profile` option — every command needs profile selection
- Output formatters belong in dedicated `*Output.ts` files, not inline in the command
