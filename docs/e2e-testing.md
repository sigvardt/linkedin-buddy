# E2E Testing

The E2E suite exercises the CLI, the MCP tool surface, and the core two-phase
commit flows against a real authenticated LinkedIn browser session.

## Runner behavior

Use the default runner from the repo root:

```bash
npm run test:e2e
```

The runner:

1. Checks that a CDP endpoint is reachable.
2. Verifies that the attached browser is already authenticated with LinkedIn.
3. Builds the workspace.
4. Runs the Vitest E2E suite.

If no authenticated session is available, the runner prints a skip reason and
exits successfully. This makes it safe for CI environments that do not have a
LinkedIn browser session.

To force the raw Vitest suite directly, use:

```bash
npm run test:e2e:raw
```

## Prerequisites

- Node.js 22+
- Installed dependencies via `npm install`
- Playwright Chromium dependencies available for the existing toolchain
- A dedicated Chromium session exposed over CDP and already logged into LinkedIn

Environment variables:

- `LINKEDIN_CDP_URL` — optional, defaults to `http://localhost:18800`
- `LINKEDIN_E2E_PROFILE` — optional logical profile name, defaults to `default`

## Safe defaults

The default E2E suite is read-only or preview-only for all outbound actions.
That means it can validate:

- every CLI command
- every MCP tool
- prepare-only two-phase commit flows
- confirm entrypoints using the built-in `test.echo` executor
- failure paths like expired tokens, rate limits, and selector drift reporting

By default, the suite does **not** send messages, likes, comments, posts, or
connection changes.

## Approved targets and opt-in writes

Real outbound confirms are opt-in and must only be used with approved targets.

### Messages

Safe target: Simon Miller (`linkedin.com/in/realsimonmiller`)

Enable:

```bash
LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM=1 npm run test:e2e
```

### Connections

Safe target: Simon Miller unless an explicitly approved alternative is provided.

Enable one confirm mode with a target that is already in the correct state:

```bash
LINKEDIN_E2E_ENABLE_CONNECTION_CONFIRM=1 \
LINKEDIN_E2E_CONNECTION_CONFIRM_MODE=invite \
LINKEDIN_E2E_CONNECTION_TARGET=realsimonmiller \
npm run test:e2e
```

Supported modes:

- `invite`
- `accept`
- `withdraw`

### Likes

Public actions require explicit approval before execution.

```bash
LINKEDIN_E2E_ENABLE_LIKE_CONFIRM=1 \
LINKEDIN_E2E_LIKE_POST_URL='https://www.linkedin.com/feed/update/...' \
npm run test:e2e
```

### Comments

Public actions require explicit approval before execution.

```bash
LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM=1 \
LINKEDIN_E2E_COMMENT_POST_URL='https://www.linkedin.com/feed/update/...' \
npm run test:e2e
```

### Posts

Real post publishing is intentionally separate and already opt-in:

```bash
LINKEDIN_ENABLE_POST_WRITE_E2E=1 npm run test:e2e
```

## Coverage overview

The E2E suite now covers:

- CLI command groups: session, rate-limit, keepalive, inbox, connections,
  followups, feed, post, notifications, jobs, profile, selector audit,
  health, and confirm entrypoints
- MCP tools: session status/open-login/health, inbox, profile, search,
  connections, followups, feed, post prepare, notifications, jobs,
  and actions confirm
- Two-phase commit confirm flows for messages, connections, likes, and comments
  behind explicit opt-in flags
- Error paths for expired tokens, rate limits, and UI drift detection

## Notes

- Run the E2E suite against a dedicated browser session; many commands navigate
  LinkedIn pages as part of the test flow.
- Selector audit failures are surfaced as structured reports and do not require
  outbound actions.
- The confirm E2Es are intentionally split between safe default coverage and
  explicit opt-in side effects.
