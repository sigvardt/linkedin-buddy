# Hardening Pass (#215) — Quality Pass

Date: 2026-03-12
Parent issue: #215
Quality pass issue: #358
Original hardening PR: #313

## Summary

This quality pass ran the remaining phases (3–8) from the hardening pipeline
defined in #215. The original PR #313 added MCP tool input schema validation
and a shared tool catalog. This pass extends that foundation with input
validation helpers, unit tests for previously untested modules, and error
recovery hints for MCP tool consumers.

## Phase 3 — Simplify / Refactor

No code changes were needed. The 30 previously reported typecheck errors were
traced to missing workspace symlinks in the worktree environment, not source
code issues. All quality gates pass clean on the current `main` codebase.

## Phase 4 — Test

Added 36 unit tests across three new test files:

| File                                          | Tests | Coverage                                                                                                                             |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/__tests__/errors.test.ts`  | 13    | `LinkedInBuddyError` construction, error payload conversion, privacy redaction in error payloads, `asLinkedInBuddyError` conversions |
| `packages/core/src/__tests__/privacy.test.ts` | 15    | `resolvePrivacyConfig`, `redactFreeformText`, `redactStructuredValue` across off/partial/full redaction modes                        |
| `packages/core/src/__tests__/logging.test.ts` | 8     | Logger creation, JSONL event format, log levels, append semantics, payload redaction, DB emission                                    |

These modules were identified as critical gaps: the error taxonomy and privacy
redaction are used across every MCP tool handler and CLI command, yet had zero
dedicated test coverage.

## Phase 5 — Harden

### New MCP validation helpers

Three reusable input validation functions added to the MCP server
(`packages/mcp/src/bin/linkedin-mcp.ts`):

| Helper                                               | Purpose                                                         | Default     |
| ---------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| `readBoundedString(args, key, maxLength, fallback?)` | Enforces max character length on text inputs                    | 5 000 chars |
| `readValidatedUrl(args, key)`                        | Validates and normalizes URL format via `new URL()`             | —           |
| `readValidatedFilePath(args, key)`                   | Rejects empty paths and path-traversal patterns (`../`, `..\\`) | —           |

### Application

- **Bounded strings** applied to: `handlePrepareReply` (8 000), `handlePrepareNewThread` (8 000), `handleFeedComment` (3 000), `handlePostPrepareCreate` (3 000), `handlePostPrepareEdit` (3 000)
- **URL validation** applied to: `handleFeedViewPost`, `handleFeedLike`, `handleFeedComment`, `handleFeedPrepareRepost`, `handleFeedSavePost`
- **File path validation** applied to: `handleProfilePrepareUploadPhoto`, `handleProfilePrepareUploadBanner`

All validation errors throw `LinkedInBuddyError` with code
`ACTION_PRECONDITION_FAILED` and include the argument path, actual value
metadata, and a descriptive message.

## Phase 6 — UX / QoL

Added error recovery hints to MCP tool error responses. Every error response
now includes a `recovery_hint` field that suggests the next action based on
the error code:

| Error code                   | Recovery hint summary                                     |
| ---------------------------- | --------------------------------------------------------- |
| `AUTH_REQUIRED`              | Run `linkedin.session.open_login` to re-authenticate      |
| `CAPTCHA_OR_CHALLENGE`       | Complete the challenge in the browser manually            |
| `RATE_LIMITED`               | Wait for the rate-limit window to reset                   |
| `UI_CHANGED_SELECTOR_FAILED` | Run `linkedin.session.health` to check browser state      |
| `NETWORK_ERROR`              | Verify connectivity, then check `linkedin.session.health` |
| `TIMEOUT`                    | Check session health, retry with simpler query            |
| `TARGET_NOT_FOUND`           | Verify the URL or identifier is correct                   |
| `ACTION_PRECONDITION_FAILED` | Check error details for missing prerequisites             |

## Phase 7 — Verify

Deferred. Live E2E verification against the Joi Ascend test account requires
an authenticated LinkedIn session with browser access, which is not available
in the automated agent context. This phase should be run manually by a human
operator following the procedure in `docs/e2e-testing.md`.

## Phase 8 — Docs

This document.

## Quality gates

All gates pass after all phases:

- `npm run typecheck` — 0 errors
- `npm run lint` — clean
- `npm test` — 1143+ tests passing (107+ test files)
- `npm run build` — clean
