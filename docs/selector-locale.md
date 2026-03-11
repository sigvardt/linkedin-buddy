# Selector locale support

`selectorLocale` makes LinkedIn Buddy more resilient when LinkedIn renders
buttons, headings, or `aria-label` text in a language other than English.
The existing structural selectors still stay first where possible; the locale
layer only changes the text-bearing fallbacks.

Use this guide when you need to:

- run the CLI against a localized LinkedIn UI
- pass locale-aware settings through MCP
- embed `@linkedin-buddy/core` with an explicit selector locale
- replace hardcoded English selectors in feature code

## Supported locales

First-class phrase coverage currently ships for:

- `en` — English (default)
- `da` — Danish

Locale input is normalized before use:

- region tags like `da-DK` resolve to `da`
- case differences like `EN_us` resolve to `en`
- unsupported, blank, malformed, or overly long values fall back to `en`

When an explicit value falls back to English, the CLI prints a warning on
stderr and the runtime writes a `runtime.selector_locale.fallback_to_english`
event to the run log.

## Configuration model

Selector locale is intentionally explicit. The runtime does not silently infer a
browser language and override your setting.

Precedence is:

1. explicit runtime input
2. `LINKEDIN_BUDDY_SELECTOR_LOCALE`
3. default `en`

The explicit input depends on the surface you are using:

| Surface | Explicit input | Notes |
| --- | --- | --- |
| CLI | `--selector-locale <locale>` | Global flag; applies to the command being run |
| MCP | `selectorLocale` tool argument | Available on the existing tool surface; there are no locale-only MCP tools |
| Core API | `createCoreRuntime({ selectorLocale })` | Best choice for programmatic integrations |

There is currently no `config.json` field for selector locale. Keep it in the
command, MCP request, core runtime options, or environment instead.

### Environment variable

Set a shell-wide default with:

```bash
export LINKEDIN_BUDDY_SELECTOR_LOCALE=da
```

This is useful when you repeatedly work in the same localized LinkedIn session.
An explicit CLI flag or MCP/Core runtime option still wins for one-off runs.

## CLI usage

`--selector-locale` is a global CLI flag, so it can be used with read-only,
mutation, diagnostic, and keepalive commands.

```bash
# Run one command with Danish selector phrases first
npm exec -w @linkedin-buddy/cli -- linkedin status --profile default --selector-locale da

# Audit localized selectors while keeping English as the safety net
npm exec -w @linkedin-buddy/cli -- linkedin audit selectors --profile default --selector-locale da

# Start the keepalive daemon with the same selector locale
npm exec -w @linkedin-buddy/cli -- linkedin keepalive start --profile default --selector-locale da

# Fall back to the shell default instead of passing the flag every time
export LINKEDIN_BUDDY_SELECTOR_LOCALE=da-DK
npm exec -w @linkedin-buddy/cli -- linkedin inbox list --profile default
```

What to expect:

- supported locale tags run quietly
- region tags normalize to the supported base locale
- invalid values keep the command running, but fall back to English with a warning

## MCP usage

No new MCP tool names were added for locale support. Instead, every existing MCP
tool schema now accepts the optional `selectorLocale` input alongside `cdpUrl`
and its tool-specific parameters.

That means you can use the same locale setting across session, inbox,
connections, feed, post, notifications, jobs, search, and confirm flows.

Example requests:

```json
{
  "name": "linkedin.session.status",
  "arguments": {
    "profileName": "default",
    "selectorLocale": "da"
  }
}
```

```json
{
  "name": "linkedin.inbox.list_threads",
  "arguments": {
    "profileName": "default",
    "selectorLocale": "da-DK",
    "limit": 10
  }
}
```

```json
{
  "name": "linkedin.feed.comment",
  "arguments": {
    "profileName": "default",
    "postUrl": "https://www.linkedin.com/feed/update/...",
    "text": "Tak fordi du delte det.",
    "selectorLocale": "da"
  }
}
```

Notes:

- `selectorLocale` follows the same normalization and fallback rules as the CLI
- audit remains CLI-only; when an MCP read tool starts drifting, rerun
  `linkedin audit selectors` with the same locale
- if an MCP request passes an unsupported locale, the runtime uses English and
  records the fallback warning in the run log

## Core API

Programmatic integrations should pass locale directly into the runtime:

```ts
import { createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime({
  selectorLocale: "da-DK"
});

const profile = await runtime.profile.viewProfile({
  profileName: "default",
  target: "https://www.linkedin.com/in/example/"
});

console.log(runtime.selectorLocale);
runtime.close();
```

The resolved value stored on `runtime.selectorLocale` is always a supported base
locale such as `en` or `da`.

## Architecture

The locale layer is deliberately small and additive.

### Resolution and warnings

- `packages/core/src/config.ts` resolves selector locale with
  option → env → default precedence
- `packages/core/src/selectorLocale.ts` normalizes raw inputs and reports
  fallback reasons such as `unsupported_locale`, `blank`, `invalid_format`, and
  `too_long`
- `packages/core/src/runtime.ts` resolves the locale once, stores it on
  `runtime.selectorLocale`, and logs fallback warnings for explicit invalid
  values

### Phrase dictionaries and helpers

`packages/core/src/selectorLocale.ts` owns the phrase dictionaries and the small
set of public builder helpers used across feature modules:

- `getLinkedInSelectorPhrases()` for locale-first phrase lists with optional
  English fallback
- `buildLinkedInSelectorPhraseRegex()` for `getByRole(..., { name })` and other
  regex-based accessible-name probes
- `formatLinkedInSelectorRegexHint()` for readable selector hints in errors and
  selector-audit output
- `buildLinkedInAriaLabelContainsSelector()` for CSS attribute selectors that
  match localized `aria-label` text
- `valueContainsLinkedInSelectorPhrase()` for text heuristics in
  `page.evaluate()` and scraper logic

English fallback is appended automatically unless a caller opts out with
`includeEnglishFallback: false`.

### Runtime threading

`packages/core/src/runtime.ts` passes the resolved locale into the services that
need locale-aware selectors. Feature modules still own their scoped candidate
arrays, selector ordering, and structured error telemetry.

This keeps the existing architecture intact:

- stable CSS, URL, `data-*`, and scoped structural selectors stay in the module
- locale-aware text matching comes from shared helpers
- selector keys and audit schemas stay stable across locales

### Selector audit

`packages/core/src/selectorAudit.ts` builds its locale-aware candidate registry
from the same phrase layer used by live automation. That keeps diagnostics and
runtime behavior aligned and makes `linkedin audit selectors` the safest way to
validate a new locale or troubleshoot UI drift.

Selector audit uses `runtime.selectorLocale`; there is no per-call
`selectorLocale` option on `auditSelectors()`. Set the locale when creating the
runtime, or pass a locale-specific registry via
`createLinkedInSelectorAuditRegistry(locale)`.

## Migration guide

### For operators

If you previously worked around a localized LinkedIn UI by only using English
sessions or by running patched local commands, prefer explicit locale config
instead:

1. remove ad-hoc command wrappers that swap English-only selectors
2. set `--selector-locale <locale>` for one-off runs or
   `LINKEDIN_BUDDY_SELECTOR_LOCALE` for a shell-wide default
3. run `linkedin audit selectors --selector-locale <locale>` to verify the
   built-in selector coverage before troubleshooting individual flows

If you already use English LinkedIn sessions, no migration is required. The
default remains `en`.

### For contributors replacing hardcoded selectors

Do not read locale directly from `process.env` inside feature modules. Use the
resolved runtime value instead.

Before:

```ts
const sendButton = dialog.getByRole("button", { name: /^Send$/i });
const addNoteSelector = 'button[aria-label*="Add a note" i]';

if (/^Experience$/i.test(sectionHeading)) {
  // ...
}
```

After:

```ts
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  valueContainsLinkedInSelectorPhrase
} from "./selectorLocale.js";

const sendButton = dialog.getByRole("button", {
  name: buildLinkedInSelectorPhraseRegex("send", runtime.selectorLocale, {
    exact: true
  })
});

const addNoteSelector = buildLinkedInAriaLabelContainsSelector(
  "button",
  "add_note",
  runtime.selectorLocale
);

if (
  valueContainsLinkedInSelectorPhrase(
    sectionHeading,
    "experience",
    runtime.selectorLocale
  )
) {
  // ...
}
```

Migration checklist:

- keep structural selectors and scoped containers first when they already work
- replace hardcoded English text/`aria-label` checks with shared phrase helpers
- pass `runtime.selectorLocale` through helper calls instead of resolving locale
  per module
- keep selector keys and error payloads stable so audit and runtime telemetry do
  not churn across locales
- rerun `npm exec -w @linkedin-buddy/cli -- linkedin audit selectors --profile default --selector-locale <locale>` after changing text-bearing selectors

## Troubleshooting

- warning on stderr about fallback to English: fix the locale value or use one
  of `en`, `da`, or a region tag that resolves to them
- MCP requests appear to ignore the locale: verify that `selectorLocale` is in
  the tool arguments, not only in an outer client wrapper
- a localized flow still fails: run selector audit with the same locale first,
  then inspect the captured artifacts before changing the selector dictionary

Related docs:

- `README.md`
- `docs/selector-audit.md`
- `docs/.plan-issue-8.md`
- `docs/.research-brief-issue-33.md`
