# E2E Testing

The E2E suite now has two complementary lanes:

- a live-session runner for validating behavior against an authenticated LinkedIn browser
- a fixture-backed replay runner that serves recorded LinkedIn HTML/HTTP responses locally

The replay lane gives CI and local development deterministic end-to-end coverage
without touching live LinkedIn.

## Live runner

Use the default runner from the repo root when you want to exercise a real
LinkedIn session over CDP:

```bash
npm run test:e2e
```

The live runner:

1. Prints the effective E2E configuration.
2. Checks that a CDP endpoint is reachable.
3. Verifies that the attached browser is already authenticated with LinkedIn.
4. Runs the Vitest E2E suite.

If no authenticated session is available, the runner prints a skip reason and
exits successfully. Pass `--require-session` when a missing CDP/authenticated
session should fail instead of skip:

```bash
npm run test:e2e -- --require-session
```

The same strict behavior is available through
`LINKEDIN_E2E_REQUIRE_SESSION=1`.

The runner forwards any remaining arguments to Vitest, so focused reruns stay
simple:

```bash
npm run test:e2e -- packages/core/src/__tests__/e2e/cli.e2e.test.ts
npm run test:e2e -- --reporter=verbose packages/core/src/__tests__/e2e/error-paths.e2e.test.ts
npm run test:e2e -- --help
```

To force the raw Vitest suite directly, use:

```bash
npm run test:e2e:raw
```

## Fixture-backed replay runner

Use the replay lane when you want deterministic Playwright coverage without
credentials or live LinkedIn traffic:

```bash
npm run test:e2e:fixtures
```

This script enables `LINKEDIN_E2E_REPLAY=1`, loads
`test/fixtures/manifest.json`, starts the local replay server, and runs the same
Vitest E2E suites headlessly against recorded fixtures.

Focused reruns work the same way:

```bash
npm run test:e2e:fixtures -- packages/core/src/__tests__/e2e/inbox.e2e.test.ts
```

CI uses this lane so E2E coverage runs without a real LinkedIn account.
Unrecorded LinkedIn routes fail closed with fixture-miss errors, and non-
LinkedIn network requests are aborted instead of silently passing through.

## Coverage lanes

The E2E matrix now has five layers:

- Live runtime suites in `packages/core/src/__tests__/e2e/*.e2e.test.ts`
  validate the LinkedIn interaction logic directly.
- Fixture-backed runtime suites reuse the same files but run against the local
  replay server in CI and local headless runs.
- Thin CLI contract coverage in
  `packages/core/src/__tests__/e2e/cli.e2e.test.ts` validates parsing, JSON
  output, exit codes, keepalive behavior, selector audit, and confirm
  entrypoints.
- Thin MCP contract coverage in
  `packages/core/src/__tests__/e2e/mcp.e2e.test.ts` validates tool payload
  shape, structured errors, and registration gaps.
- Non-live unit tests in `packages/core/src/__tests__/e2eRunner.test.ts`,
  `packages/core/src/__tests__/e2eSetup.test.ts`,
  `packages/core/src/__tests__/e2eHelpers.test.ts`, and
  `packages/core/src/__tests__/e2eConfirmContracts.test.ts` harden runner
  parsing, skip semantics, fixture replay, retry behavior, and confirm
  contracts without needing LinkedIn access.

The default live lane only executes tests that are read-only, preview-only, or
use the `test.echo` executor for the generic confirm entrypoints. Real outbound
confirms remain opt-in.

## Prerequisites

- Node.js 22+
- Installed dependencies via `npm install`
- Playwright Chromium available via `npx playwright install chromium`
- For the live lane only: a dedicated Chromium session exposed over CDP and
  already logged into LinkedIn

Environment variables:

- `LINKEDIN_CDP_URL` — live lane only, defaults to `http://localhost:18800`
- `LINKEDIN_E2E_PROFILE` — optional logical profile name, defaults to `default`
- `LINKEDIN_E2E_REQUIRE_SESSION` — optional, set to `1` or `true` to fail instead of skip
- `LINKEDIN_E2E_REPLAY` — optional, set to `1` or `true` to enable replay mode
- `LINKEDIN_E2E_FIXTURE_MANIFEST` — optional manifest path for replay mode, defaults to `test/fixtures/manifest.json`
- `LINKEDIN_E2E_FIXTURE_SET` — optional fixture set name override, defaults to the manifest default set
- `LINKEDIN_E2E_FIXTURE_SERVER_URL` — optional externally managed replay server base URL
- `LINKEDIN_E2E_FIXTURE_FILE` — optional JSON file used to record or replay shared CLI/MCP discovery fixtures in the live lane
- `LINKEDIN_E2E_REFRESH_FIXTURES` — optional, set to `1` or `true` to overwrite the live discovery fixture file
- `LINKEDIN_E2E_JOB_QUERY` — optional job query override for live fixture discovery, defaults to `software engineer`
- `LINKEDIN_E2E_JOB_LOCATION` — optional job location override for live fixture discovery, defaults to `Copenhagen`
- `LINKEDIN_E2E_MESSAGE_TARGET_PATTERN` — optional regex source used when live-discovering the approved inbox thread, defaults to `Simon Miller`
- `LINKEDIN_E2E_CONNECTION_TARGET` — optional connection target slug used for preview coverage and connection confirms, defaults to `realsimonmiller`
- `LINKEDIN_E2E_CONNECTION_CONFIRM_MODE` — optional connection confirm mode: `invite`, `accept`, or `withdraw`
- `LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM` — optional, enables the real inbox confirm test
- `LINKEDIN_E2E_ENABLE_CONNECTION_CONFIRM` — optional, enables the configured real connection confirm test
- `LINKEDIN_E2E_ENABLE_LIKE_CONFIRM` — optional, enables the real like confirm test
- `LINKEDIN_E2E_LIKE_POST_URL` — required only when `LINKEDIN_E2E_ENABLE_LIKE_CONFIRM=1`
- `LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM` — optional, enables the real comment confirm test
- `LINKEDIN_E2E_COMMENT_POST_URL` — required only when `LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM=1`
- `LINKEDIN_ENABLE_POST_WRITE_E2E` — optional, enables real post publishing after explicit approval

## Recorded fixture workflow

Replay fixtures live under `test/fixtures/`. The committed manifest points to a
small `ci` fixture set that is safe for headless CI. Local recordings can add
more sets without overwriting others.

Record or refresh pages manually:

```bash
linkedin fixtures record --page feed --page messaging
owa fixtures:record --set da-dk --page profile,notifications --no-har
```

Supported page types:

- `feed`
- `profile`
- `messaging`
- `notifications`
- `composer`
- `search`
- `connections`
- `jobs`

The recorder:

- launches a persistent Playwright browser for manual LinkedIn navigation
- records LinkedIn/Licdn responses into a fixture set plus optional HAR output
- stores per-page metadata including capture date, locale, viewport, and URL
- preserves untouched pages and routes so you can re-record one page at a time

Validate fixture freshness:

```bash
linkedin fixtures check
owa fixtures:check --set ci --max-age-days 14
```

`fixtures check` warns when a set or page is older than the configured age.

Storage rules:

- `test/fixtures/manifest.json` is committed
- `test/fixtures/ci/**` is committed for deterministic CI coverage
- other local fixture sets under `test/fixtures/<set>/` stay ignored by default
- large captured HAR files and raw response bodies stay ignored unless you
  intentionally promote them

## Contract discovery fixtures

The CLI and MCP contract suites also use a separate lightweight JSON fixture
file for live discovery. Those files only store a message thread id, a feed
post URL, a job id, and a connection target so contract-focused reruns do not
need to rediscover live targets every time.

Fixture files are intentionally small and profile-aware. The helper records the
fixture format version, capture timestamp, `LINKEDIN_E2E_PROFILE`, and the
stable identifiers needed by the CLI/MCP suites. Replays fail fast when the
saved format is unsupported or when the saved profile name does not match the
current `LINKEDIN_E2E_PROFILE`.

Capture or refresh the live discovery fixtures:

```bash
npm run test:e2e --   --fixtures .tmp/e2e-fixtures.json   --refresh-fixtures   packages/core/src/__tests__/e2e/cli.e2e.test.ts
```

Replay the saved discovery fixtures on later live runs:

```bash
npm run test:e2e --   --fixtures .tmp/e2e-fixtures.json   packages/core/src/__tests__/e2e/mcp.e2e.test.ts
```

If the discovery file becomes stale or malformed, rerun with
`--refresh-fixtures` to overwrite it with fresh live-discovery output.

Live discovery uses `LINKEDIN_E2E_MESSAGE_TARGET_PATTERN`,
`LINKEDIN_E2E_JOB_QUERY`, `LINKEDIN_E2E_JOB_LOCATION`, and
`LINKEDIN_E2E_CONNECTION_TARGET`. Once a discovery fixture file exists, the CLI
and MCP contract suites can replay it without rediscovering those targets.

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

The opt-in write suite files still run their preview assertions by default, but
the real confirm cases stay skipped until the matching environment variables
are enabled.

## Approved targets and opt-in writes

Real outbound confirms are opt-in and must only be used with approved targets.

### Messages

Safe target: Simon Miller (`linkedin.com/in/realsimonmiller`)

If you are not replaying a saved fixture file, live discovery uses the
`LINKEDIN_E2E_MESSAGE_TARGET_PATTERN` regex source to find the approved inbox
thread.

Enable:

```bash
LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM=1 npm run test:e2e
```

### Connections

Safe target: Simon Miller unless an explicitly approved alternative is provided.

`LINKEDIN_E2E_CONNECTION_TARGET` defaults to `realsimonmiller`. The selected
target must already be in the correct state for the chosen confirm mode.

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

The default lane still covers `prepareLikePost()` preview behavior without
confirming the action.

```bash
LINKEDIN_E2E_ENABLE_LIKE_CONFIRM=1 \
LINKEDIN_E2E_LIKE_POST_URL='https://www.linkedin.com/feed/update/...' \
npm run test:e2e
```

### Comments

Public actions require explicit approval before execution.

The default lane still covers `prepareCommentOnPost()` preview behavior without
confirming the action.

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

- Live and fixture-backed runtime suites for auth, health, profile, search,
  jobs, inbox, connections, feed, notifications, and preview coverage for
  outbound actions
- CLI command groups: session, rate-limit, keepalive, inbox, connections,
  followups, feed, post, notifications, jobs, profile, selector audit,
  health, and both confirm entrypoints
- MCP tools: session status/open-login/health, inbox list/get-thread/
  prepare-reply, profile, search, connections list/pending/invite/accept/
  withdraw, followup prepare-after-accept, feed list/view-post/like/comment,
  post prepare-create, notifications, jobs search/view, and actions confirm
- Real outbound confirm flows for messages, connections, likes, comments, and
  posts behind explicit opt-in flags
- Error paths for expired tokens, rate limits, UI drift detection, profile
  mismatches, unknown confirm tokens, retry behavior, and timeout handling

## Developer workflow

### Architecture

- `scripts/run-e2e.js` is the live-session entrypoint that probes
  CDP/authentication, chooses skip versus fail behavior, prints configuration,
  and forwards the remaining args to Vitest.
- `packages/core/src/fixtureReplay.ts` owns the replay manifest format, local
  mock server, route matching, and Playwright request interception used by the
  fixture-backed lane.
- `packages/core/src/__tests__/e2e/setup.ts` owns the shared runtime,
  temporary assistant home, stale-directory cleanup, and explicit skip helpers.
  Use `setupE2ESuite()` plus `skipIfE2EUnavailable()` instead of re-implementing
  per-test probes.
- `packages/core/src/__tests__/e2e/helpers.ts` wraps CLI and MCP execution,
  retries transient browser/process failures, extracts the last JSON object from
  mixed output, and manages reusable fixture files.

### Adding or changing coverage

1. Start at the runtime layer when validating LinkedIn behavior.
2. Add CLI or MCP tests only for transport and contract behavior.
3. Keep new coverage read-only or prepare-only by default.
4. Gate any real outbound confirm behind a dedicated environment flag and
   document the approved target in the test file and this guide.
5. Reuse `getCliCoverageFixtures()` for CLI/MCP suites unless the new coverage
   truly needs a new live identifier.
6. Update the runner `--help`, `README.md`, and this guide whenever you add a
   new E2E environment variable, fixture field, or safety rule.
7. Update `test/fixtures/manifest.json`, the committed `test/fixtures/ci/`
   set, and this guide together whenever replay selectors or routes change.
8. Add or update non-live unit tests when changing `scripts/run-e2e.js`,
   `packages/core/src/fixtureReplay.ts`,
   `packages/core/src/__tests__/e2e/setup.ts`, or
   `packages/core/src/__tests__/e2e/helpers.ts`.

## Notes

- Run the E2E suite against a dedicated browser session; many commands navigate
  LinkedIn pages as part of the test flow.
- Selector audit failures are surfaced as structured reports and do not require
  outbound actions.
- The confirm E2Es are intentionally split between safe default coverage and
  explicit opt-in side effects.
- The default runner does not build the workspace; it executes the Vitest E2E
  config directly from source.
