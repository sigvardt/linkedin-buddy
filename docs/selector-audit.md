# Selector audit

`linkedin audit selectors` is a read-only diagnostic for the built-in LinkedIn
selector registry. It navigates across key pages, checks each selector group in
primary-to-tertiary order, captures artifacts for failures, and writes a
structured JSON report for humans and automation.

The selector audit feature is also exported from `@linkedin-assistant/core` via
`packages/core/src/index.ts`.

## What it checks

- Pages: `feed`, `inbox`, `profile`, `connections`, `notifications`
- Strategies per selector group: `primary`, `secondary`, `tertiary`
- Page readiness before selector checks, but as a warning instead of a hard stop
- Failure artifacts: screenshot, DOM snapshot, accessibility snapshot

## Quick start

```bash
# Human-readable summary with progress
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default

# Verbose human-readable summary
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default --verbose

# JSON for CI, scripts, or agent workflows
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default --json

# Attach to an existing authenticated browser session
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default --cdp-url http://127.0.0.1:18800

# Prefer Danish selectors first, then fall back to English phrases
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --profile default --selector-locale da

# Show built-in help and doc pointer
npm exec -w @linkedin-assistant/cli -- linkedin audit selectors --help
```

## Reading the result

- `PASS`: every selector group matched a primary selector
- `PASS WITH FALLBACKS`: at least one selector group matched only a secondary or
  tertiary selector
- `FAIL`: at least one selector group failed across every strategy
- Exit code `0`: no hard failures
- Exit code `1`: at least one hard failure or command/runtime failure

Representative output:

```text
Starting selector audit for profile default (2 pages).
Checking page 1/2: feed (2 selector groups)...
Finished page 1/2: feed — 1 passed, 1 failed, 1 fallback.
Checking page 2/2: inbox (1 selector group)...
Finished page 2/2: inbox — 1 passed, 0 failed, 0 fallback.
Selector audit finished. Report: /tmp/run_test/selector-audit/report.json

Selector Audit: FAIL
Profile: default
Checked At: 2026-03-08T12:00:00.000Z
Summary: Checked 3 selector groups across 2 pages. 2 passed. 1 failed. 1 used fallback selectors.
Report JSON: /tmp/run_test/selector-audit/report.json
Artifacts: /tmp/run_test/selector-audit

Pages
- FAIL feed: 1 passed, 1 failed, 1 fallback-only
- PASS inbox: 1 passed, 0 failed, 0 fallback-only

Failures
- feed/post_composer_trigger — Feed post composer trigger
  Error: No selector strategy matched for post_composer_trigger on feed. Review the failure artifacts, update the selector registry if LinkedIn's UI changed, and rerun the selector audit.
  Artifacts: screenshot=/tmp/run_test/selector-audit/feed/post_composer_trigger.png | dom=/tmp/run_test/selector-audit/feed/post_composer_trigger.html | a11y=/tmp/run_test/selector-audit/feed/post_composer_trigger.a11y.json
  Next: Open the captured failure artifacts for post_composer_trigger on feed, update that selector group in the registry, and rerun the selector audit.
```

Typical JSON fields:

```json
{
  "outcome": "pass_with_fallbacks",
  "summary": "Checked 14 selector groups across 5 pages. 14 passed. 0 failed. 2 used fallback selectors.",
  "artifact_dir": "/path/to/run/selector-audit",
  "report_path": "/path/to/run/selector-audit/report.json",
  "page_summaries": [
    {
      "page": "feed",
      "total_count": 4,
      "pass_count": 4,
      "fail_count": 0,
      "fallback_count": 1
    }
  ],
  "failed_selectors": [],
  "fallback_selectors": [
    {
      "page": "feed",
      "selector_key": "feed_sort_menu",
      "fallback_strategy": "secondary",
      "fallback_used": "css-feed-sort-menu"
    }
  ]
}
```

## Artifacts and report files

- The JSON report is written to `selector-audit/report.json` under the current
  run artifact directory.
- Failure artifact paths are absolute paths in the returned report so they are
  easy to open from CI logs or agent output.
- Screenshots, DOM snapshots, and accessibility snapshots are captured only for
  failures to keep successful runs lightweight.

## Configuration

### CLI

Available switches:

- `--profile <profile>`: choose the persistent Playwright profile
- `--json`: emit the full structured report
- `--verbose`: add selector-by-selector detail to human output
- `--no-progress`: suppress live progress lines in human output
- `--cdp-url <url>`: attach to an existing authenticated browser session
- `--selector-locale <locale>`: prefer locale-aware UI text fallbacks (`en`, `da`); region tags like `da-DK` normalize to `da`

You can also set `LINKEDIN_ASSISTANT_SELECTOR_LOCALE` to change the default
selector locale. Unsupported values fall back to `en` with a warning. General
tool state and artifacts still follow
`LINKEDIN_ASSISTANT_HOME`.

### Core API

The core service supports registry and timeout overrides:

```ts
import {
  LinkedInSelectorAuditService,
  createCoreRuntime,
  createLinkedInSelectorAuditRegistry
} from "@linkedin-assistant/core";

const runtime = createCoreRuntime();
const registry = createLinkedInSelectorAuditRegistry();

const selectorAudit = new LinkedInSelectorAuditService(runtime, {
  registry,
  candidateTimeoutMs: 2500,
  pageReadyTimeoutMs: 10000,
  pageNavigationTimeoutMs: 20000
});

const report = await selectorAudit.auditSelectors({
  profileName: "default"
});

console.log(report.outcome, report.report_path);
runtime.close();
```

Public selector-audit exports include:

- `LinkedInSelectorAuditService`
- `createLinkedInSelectorAuditRegistry`
- `LINKEDIN_SELECTOR_AUDIT_PAGES`
- `LINKEDIN_SELECTOR_AUDIT_STRATEGIES`
- `SelectorAuditReport` and related result types

## Where to find it

- README quick start: `README.md`
- CLI help: `linkedin audit selectors --help`
- MCP discoverability: read-only tool descriptions point operators back to the
  CLI selector audit when investigating UI drift
- Core exports: `packages/core/src/index.ts`
