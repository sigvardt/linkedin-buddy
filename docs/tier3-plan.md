# Tier 3 write-action validation plan

Implementation plan for GitHub issue #144 (parent issue #90), based on the
research in `docs/tier3-research.md` and the existing Tier 1 and Tier 2
harnesses.

## Intent

Add a first-class **Tier 3 live write-validation lane** that proves selected
LinkedIn write actions still work under real conditions **without** collapsing
Tier 1 replay, Tier 2 read-only smoke validation, and ad hoc opt-in write E2Es
into one ambiguous runner.

Tier 3 should preserve the repo’s current testing shape:

- **Tier 1** remains the deterministic replay lane for CI-safe regression work.
- **Tier 2** remains the read-only live drift-detection lane.
- **Tier 3** becomes the explicit opt-in lane for approved live write actions.

The strongest architectural precedent is already in the repository:

- Core-owned orchestration
- thin CLI wiring
- stable JSON output plus human-readable summaries
- artifact capture and rolling report snapshots
- clear opt-in safety controls

The main design decision for phase 1 should be:

- normalize on one **logical account model**
- keep the first scenario set narrow and reversible
- reuse the existing write executors instead of rewriting LinkedIn flows
- standardize policy, verification, and reporting before broadening coverage

## Architecture and module structure

### 1) Add one Core-owned Tier 3 module family

Phase 1 should add a small, concrete module set under `packages/core`.
Avoid a generic plugin framework.

Recommended file layout:

- `packages/core/src/writeValidation.ts`
  - public Tier 3 entrypoint, analogous to `liveValidation.ts`
  - validates run options
  - resolves account + scenario set
  - creates the run plan
  - executes `preflight -> prepare -> confirm -> verify -> cleanup?`
  - persists `report.json`, `events.jsonl`, and `latest-report.json`
- `packages/core/src/writeValidationAccounts.ts`
  - loads the canonical account registry
  - resolves `accountId` to profile/auth/policy metadata
  - validates approved target aliases and allowed action lists
- `packages/core/src/writeValidationPolicy.ts`
  - central write-policy engine
  - enforces approved account/action/target combinations
  - applies per-account quotas and unattended-mode rules
  - classifies phase-specific network policy
  - emits machine-readable rejection reasons
- `packages/core/src/writeValidationScenarios.ts`
  - built-in scenario definitions and named scenario sets
  - owns scenario ids, risk classes, target kinds, and cleanup guidance
  - wraps existing `runtime.inbox`, `runtime.connections`, `runtime.feed`, and
    `runtime.posts` prepare/confirm helpers instead of duplicating executor logic
- `packages/core/src/index.ts`
  - re-exports the new Tier 3 runner and public types

Phase 1 CLI additions should stay equally small:

- `packages/cli/src/bin/linkedin.ts`
  - adds `linkedin test write`
  - adds hidden alias `linkedin test:write`
  - parses flags, handles prompts, and renders output
- `packages/cli/src/writeValidationOutput.ts`
  - human-readable progress and final summary formatting

### 2) Reuse the existing runtime instead of building a second one

Tier 3 should execute through `createCoreRuntime()` and the existing service
surface:

- `runtime.inbox.prepareReply()`
- `runtime.connections.prepareSendInvitation()`
- `runtime.connections.prepareAcceptInvitation()`
- `runtime.connections.prepareWithdrawInvitation()`
- `runtime.followups.prepareFollowupsAfterAccept()`
- `runtime.feed.prepareLikePost()`
- `runtime.feed.prepareCommentOnPost()`
- `runtime.posts.prepareCreate()`
- `runtime.twoPhaseCommit.confirmByToken()`

This keeps the harness focused on **planning, policy, verification, and
reporting**, not on re-implementing the LinkedIn automation itself.

### 3) Standardize on account-backed profile auth first

Phase 1 should resolve every Tier 3 run through one logical `accountId`, but it
should **not** try to support every auth mode equally on day one.

Recommended phase-1 stance:

- support account-backed runtime execution through the existing
  `profileName`-centric runtime model
- allow `persistent_profile` and optional `cdp` transport for that account
- defer `stored_session` write execution until the account model is stable

Rationale:

- current write executors, DB rows, and most runtime services are keyed by
  `profileName`
- Tier 2 stored-session validation was intentionally isolated from that model
- forcing stored-session write support into phase 1 would add identity and DB
  complexity before the harness contract is settled

### 4) Use `config.json` as the phase-1 account registry

The dormant SQLite `account` table is a useful long-term signal, but the safest
phase-1 source of truth is `LINKEDIN_ASSISTANT_HOME/config.json`.

Why config first:

- approved targets and allowed write actions are operator-managed safety data
- `config.json` is already an established home for tool configuration
- a file-backed registry is easy to diff, review, and back up
- it avoids blocking the harness behind an early DB migration

Recommended config shape:

```json
{
  "writeValidation": {
    "accounts": {
      "default": {
        "label": "Primary operator account",
        "profileName": "default",
        "allowedAuthModes": ["persistent_profile", "cdp"],
        "allowedActions": [
          "send_message",
          "connections.send_invitation",
          "connections.withdraw_invitation"
        ],
        "approvedTargets": {
          "send_message": {
            "aliases": {
              "simon-thread": {
                "threadId": "<approved-thread-id>",
                "participantPattern": "^Simon Miller$"
              }
            }
          },
          "connections.send_invitation": {
            "aliases": {
              "simon-profile": {
                "profileSlug": "realsimonmiller"
              }
            }
          },
          "connections.withdraw_invitation": {
            "aliases": {
              "simon-profile": {
                "profileSlug": "realsimonmiller"
              }
            }
          }
        }
      }
    }
  }
}
```

Notes:

- the registry should store **aliases and approved values**, not arbitrary raw
  user input
- phase 1 should keep `cdpUrl` outside the file and continue resolving it from
  CLI/env when the chosen account allows `cdp`
- the existing `account` table can be revisited later if scheduler or analytics
  features need relational account metadata

### 5) Model Tier 3 around explicit scenarios

Tier 3 should not run a pile of loose action flags. It should run named
**scenarios** that are comparable, reviewable, and policy-checked.

Each built-in scenario should define at least:

- stable scenario id
- action type
- risk class: `private`, `network`, or `public`
- account requirement
- target kind and approved target alias rules
- prepare function
- confirm function
- verification function
- optional cleanup function or cleanup guidance
- unattended eligibility
- phase-specific network policy
- quota/cooldown policy

Recommended initial scenario sets:

- `private-smoke`
  - `inbox.reply.approved-thread`
- `network-smoke`
  - `connections.invite.approved-profile`
  - `connections.withdraw.approved-profile`
- `extended-network`
  - `connections.accept.approved-profile`
  - `followups.after-accept.approved-profile`
- `public-smoke`
  - `feed.like.approved-post`
  - `feed.comment.approved-post`
- `post-smoke`
  - `posts.create.connections-audience`

### 6) Keep the phase model explicit

Each scenario run should use the same phase vocabulary:

1. `preflight`
   - resolve account
   - validate auth mode
   - resolve approved targets
   - check policy, cooldowns, and interactive requirements
2. `prepare`
   - call the existing prepare method
   - capture preview metadata and prepared-action id
3. `confirm`
   - call the existing two-phase confirm entrypoint
   - record artifacts and observed network telemetry
4. `verify`
   - re-check the LinkedIn-visible side effect
   - separately check local DB/state synchronization where relevant
5. `cleanup` (optional)
   - execute an automated cleanup step when supported
   - otherwise mark the run as needing manual cleanup guidance

The report should explicitly distinguish:

- **confirmed**: the executor completed
- **verified**: the LinkedIn-side effect was re-observed
- **state_synced**: expected local DB/state updates happened

That prevents weakly verified flows from being flattened into one ambiguous
“pass”.

### 7) Add one small context-instrumentation seam

Tier 3 needs network observation and phase-specific request policy, but current
write services mostly call `profileManager.runWithContext()` internally.

Recommended implementation seam:

- add an optional browser-context setup hook to `ProfileManager`
- let Tier 3 attach request observers / guards around prepare, confirm, and
  verify phases without rewriting each service end-to-end

This is a focused change with high leverage. Avoid a broader service-API rewrite
unless the first scenarios prove that the hook is insufficient.

## Safety controls

### Approved targets

Approved targets should move out of scattered environment variables and into the
account registry.

Rules for phase 1:

- every mutating scenario must resolve through an approved target alias
- the CLI must never accept raw target URLs, thread ids, or profile slugs for
  Tier 3 execution
- exact identifiers should be preferred over fuzzy matching
- display-name regex matching is acceptable only as a secondary confirmation for
  inbox participants when thread ids are already pinned

Approved target shapes by action family:

- messages: exact thread id + optional participant check
- connections: exact profile slug
- likes/comments: exact post URL
- post creation: no external target, but the account policy must still constrain
  visibility and audience choices

### Write-policy engine

Phase 1 needs a central policy object rather than more one-off env flags.

Minimum policy responsibilities:

- reject unapproved `accountId` / `scenarioId` / `targetAlias` combinations
- reject auth modes the account does not allow
- enforce per-account quotas and cooldowns
- distinguish `interactive_only` from unattended-eligible scenarios
- distinguish `private`, `network`, and `public` risk classes
- define phase-specific network allowlists
- attach cleanup requirements and operator reminders to the report

Recommended policy defaults:

- `private` scenarios may become unattended-eligible once stable
- `network` scenarios remain interactive by default in phase 1
- `public` scenarios are interactive-only in phase 1
- `post.create` remains interactive-only and last in rollout order

### Multi-account isolation

Tier 3 should assume multiple logical LinkedIn accounts will eventually share
one assistant home, even if only one is active today.

Phase-1 isolation rules:

- every run is keyed by `accountId`
- artifact/report paths are namespaced by `accountId`
- rolling `latest-report.json` snapshots are also namespaced by `accountId`
- policy decisions and quotas are keyed by `accountId`, not only by action type
- one Tier 3 run may execute per `accountId` at a time
- selected targets come only from the chosen account’s approved target set

Concrete implementation suggestions:

- keep using the existing per-profile lock from `ProfileManager`
- add a Tier 3 run lock such as `artifacts/live-write/<accountId>/.run.lock`
- prefix harness-owned quota counters with `accountId`
  - example: `write_validation:<accountId>:connections.send_invitation`

### Network policy

Tier 3 should treat network observations as **telemetry plus guardrails**, not
as brittle private-endpoint contracts.

Recommended phase-specific policy:

- `preflight`, `prepare`, `verify`
  - allow only `GET` requests to LinkedIn-owned domains
- `confirm`, `cleanup`
  - allow LinkedIn-owned domains
  - allow non-`GET` only while the active scenario phase explicitly permits it
  - record observed write requests for the final report
  - fail closed on non-LinkedIn domains or obviously out-of-scope traffic

Do **not** make exact private LinkedIn endpoint names the primary assertion in
phase 1. The real contract is the repo’s own action surface plus visible
postconditions.

### Concurrency and idempotency

Current two-phase confirm behavior marks the prepared action as executed **after**
executor completion, which is not strong enough for a broader automated Tier 3
lane.

Before unattended mode expands, Tier 3 should add one of these protections:

- DB claim/lease of prepared actions before executor execution
- optimistic transition from `prepared` to an `executing` state that fails closed
  when another worker already claimed the row
- scenario-specific idempotency checks before UI submission

This should be treated as Tier 3 scaffolding work, not a later polish item.

### Cleanup policy

Cleanup must be explicit in the scenario definition.

Phase-1 rules:

- favor reversible and low-visibility scenarios first
- public scenarios must declare cleanup guidance before they ship
- a scenario that executes successfully but still needs manual cleanup should not
  be reported as a clean green success

Recommended reporting states:

- `cleanup_not_required`
- `cleanup_completed`
- `cleanup_required_manual`
- `cleanup_failed`

## Integration with Tier 1 and Tier 2

### Reuse from Tier 1 fixture replay

Tier 1 should remain a separate deterministic lane. Tier 3 should reuse its
patterns, not its illusion of live writes.

Reuse directly:

- lane separation and explicit runner modes
- fixture-backed CLI and contract tests for safe deterministic coverage
- small discovery-fixture mindset for approved live ids used by CLI/MCP tests
- existing confirm-contract tests for prepared-action plumbing

Do not reuse incorrectly:

- replay should **not** be presented as proof that a write mutation still works
- Tier 3 should not try to fake a full write-confirm story from saved fixtures

Where Tier 1 still helps Tier 3:

- policy-only tests
- `--plan-only` CLI tests
- report-shape regression tests
- approved-target resolution tests
- failure-path tests that do not need live LinkedIn side effects

### Reuse from Tier 2 live validation

Tier 2 is the closest architectural template and should be copied on purpose.

Tier 3 should reuse:

- Core-owned orchestration in `packages/core`
- thin CLI wiring in `packages/cli`
- stable JSON reports plus human-readable summaries
- event logging + artifact directories + `latest-report.json`
- hidden colon alias conventions (`test:write`)
- human-readable progress on `stderr`, machine-readable JSON on `stdout`
- exit-code discipline: validation failure vs runtime/preflight failure

Tier 3 should differ from Tier 2 in these deliberate ways:

- no implicit default scenario set; the operator must choose a scenario or set
- explicit account selection instead of a plain stored-session name
- write-policy checks before any scenario is allowed to navigate
- separate reporting for confirm, verify, local-state sync, and cleanup
- public-action scenarios remain interactive-only initially

### Relationship to the current opt-in write E2Es

The existing opt-in write E2Es should stay in place while Tier 3 is being built.

Recommended transition:

- keep the current per-action write E2Es as executor-level safety nets
- add new Tier 3 harness tests on top
- only trim duplicate E2E coverage after the harness proves stable for a given
  scenario family

That avoids betting the whole live-write story on the new harness before it has
built confidence.

## Test strategy

Tier 3 needs stronger harness tests than “run a live action and hope.”

### 1) Pure unit tests

Add unit coverage for:

- account-registry parsing and validation
- scenario-set planning
- approved-target alias resolution
- risk-class policy rules
- unattended eligibility checks
- quota / cooldown helpers
- network-policy classification helpers
- report aggregation and status rollup
- cleanup-state rollup

These tests should not require Playwright or LinkedIn access.

### 2) Core integration tests with fake scenarios

The orchestrator itself should be tested with deterministic fake scenario
definitions that simulate:

- happy path through all phases
- policy rejection at preflight
- prepare failure
- confirm failure
- confirm succeeds but verify fails
- confirm + verify succeed but local state is missing
- cleanup required vs cleanup completed
- blocked network requests recorded during confirm
- partial reports on late-step failure

This is the safest place to harden the harness contract.

### 3) CLI tests

Add CLI-focused tests for:

- required `--account` and `--scenario` / `--set` behavior
- `--json` vs human-readable mode
- `--yes` behavior for unattended-safe scenarios
- rejection of `--yes` when any selected scenario is interactive-only
- help text, examples, and exit codes
- prompt wording and plan summaries

### 4) Replay-backed and policy-only tests

Use the existing fixture-replay/testing conventions for deterministic coverage of:

- `--plan-only` runs
- account + target resolution
- report serialization
- output formatting
- negative-policy cases

Replay should cover the harness contract, not pretend to cover live mutation
success.

### 5) Live opt-in E2E tests

Add a small number of true live Tier 3 tests that exercise the new harness end
to end against approved targets.

Initial live scenarios should be limited to:

- inbox reply to the approved Simon Miller thread
- connection invite / withdraw for the approved profile

Only after the harness stabilizes should the live Tier 3 E2Es expand to:

- connection accept
- follow-up after accept
- like / comment on explicitly approved posts
- post creation last

### 6) Regression tests for concurrency and cleanup

Tier 3 adds new failure modes that should get dedicated tests:

- double-confirm attempts against one prepared action
- run-lock contention on the same account
- quota exhaustion on one account without affecting another
- cleanup-required runs producing non-green summaries
- manual cleanup reminders preserved in JSON and human output

## CLI interface design

### Primary command

Add a dedicated command group:

- `linkedin test write`
- hidden alias: `linkedin test:write`

Keep it operator-facing and explicit.

Recommended phase-1 command contract:

- `--account <id>`
  - required
  - resolves the canonical account + policy bundle
- `--scenario <id>`
  - repeatable or comma-separated
  - explicit single-scenario execution
- `--set <name>`
  - optional named scenario set such as `private-smoke`
- `--target <alias>`
  - optional approved target alias when the chosen scenario needs one and does
    not have a default
  - must resolve only through the account registry
- `--plan-only`
  - show the resolved run plan and policy decisions without performing writes
- `--yes`
  - skip the run-level prompt only when all selected scenarios are
    unattended-eligible
- `--json`
  - print the structured report to `stdout`
- `--no-progress`
  - suppress live human progress lines on `stderr`
- `--timeout-seconds`, `--max-retries`, `--retry-max-delay-ms`
  - optional execution tuning, mirroring Tier 2 where useful

Important safety choices:

- no raw `--profile`, `--thread`, `--profile-slug`, or `--post-url` overrides on
  the Tier 3 command
- no implicit default scenario set
- `--yes` should be rejected if any selected scenario is interactive-only

### Prompting model

Recommended prompt behavior:

- show one run-level plan before any write begins
- include account, scenario ids, targets, risk class, and cleanup expectations
- require explicit confirmation unless `--yes` is allowed
- keep public scenarios interactive-only even if lower-risk scenarios later
  allow unattended execution

Phase 1 should prefer **one run-level confirmation** over a prompt before every
step. The exception is when a later public-action rollout explicitly needs an
extra confirmation.

### Output and exit codes

Output should mirror Tier 2 conventions.

Human-readable mode should show:

- selected account and scenario set
- per-scenario phase summaries
- policy rejections or warnings
- blocked request summary
- verification and local-state sync results
- cleanup requirements
- next recommended actions

JSON mode should include:

- run metadata
- selected account + auth mode
- selected scenarios / set ids
- per-phase status for each scenario
- prepared-action metadata without raw confirm tokens
- blocked/unexpected request telemetry
- artifact paths
- cleanup state
- overall outcome

Recommended exit codes:

- `0` all selected scenarios passed and no cleanup action remains outstanding
- `1` one or more scenarios failed policy, prepare, confirm, verify, local-state,
  or cleanup requirements
- `2` the run could not complete because of preflight, auth, or runtime failure

### Example commands

```bash
linkedin test write --account default --set private-smoke
linkedin test write --account default --scenario inbox.reply.approved-thread --target simon-thread
linkedin test write --account default --scenario connections.invite.approved-profile --target simon-profile --yes --json
linkedin test write --account default --set private-smoke --plan-only --json
```

## Rollout plan

### Slice 1: contracts, account registry, and policy

Build the harness scaffolding before any new live write execution:

- account registry in `config.json`
- scenario definitions and scenario-set planner
- write-policy engine
- report schema and output skeleton
- account-scoped locks and quota keys
- confirm concurrency hardening plan

This is the most important slice because it determines whether the later live
coverage is safe and maintainable.

### Slice 2: first low-risk live scenarios

Implement the smallest reversible set first:

- `inbox.reply.approved-thread`
- `connections.invite.approved-profile`
- `connections.withdraw.approved-profile`

Why first:

- approved targets are narrow and already documented
- visible verification signals are relatively clear
- side effects are private or reversible
- they map cleanly to existing opt-in write E2Es

### Slice 3: remaining network/private actions

Add:

- `connections.accept.approved-profile`
- `followups.after-accept.approved-profile`

These are still less risky than public engagement, but they are more coupled to
invitation state, scheduler state, and local DB synchronization.

### Slice 4: public engagement actions

Add:

- `feed.like.approved-post`
- `feed.comment.approved-post`

Requirements before this slice ships:

- public scenarios remain interactive-only
- cleanup guidance is explicit in the scenario definition and report
- approved targets are exact post URLs, ideally operator-owned or otherwise
  explicitly approved posts

### Slice 5: post creation last

`post.create` should be the last Tier 3 scenario family.

Recommended order inside this slice:

1. `posts.create.connections-audience`
2. only later, if still needed, `posts.create.public-audience`

Reasons to keep it last:

- highest visibility and social impact
- strongest need for cleanup discipline
- most complex composer flow
- most sensitive content policy surface

## Suggested files to touch, in order

1. `packages/core/src/writeValidationAccounts.ts`
2. `packages/core/src/writeValidationPolicy.ts`
3. `packages/core/src/profileManager.ts`
4. `packages/core/src/writeValidation.ts`
5. `packages/core/src/index.ts`
6. `packages/core/test/writeValidationAccounts.test.ts`
7. `packages/core/test/writeValidationPolicy.test.ts`
8. `packages/core/test/writeValidation.test.ts`
9. `packages/cli/src/writeValidationOutput.ts`
10. `packages/cli/src/bin/linkedin.ts`
11. `packages/cli/test/writeValidationCli.test.ts`
12. `packages/core/src/__tests__/e2e/writeValidation.e2e.test.ts`
13. `docs/write-validation.md`
14. `docs/e2e-testing.md`

Files that may need targeted follow-up changes once scenario rollout begins:

- `packages/core/src/twoPhaseCommit.ts`
- `packages/core/src/db/database.ts`
- `packages/core/src/linkedinInbox.ts`
- `packages/core/src/linkedinConnections.ts`
- `packages/core/src/linkedinFollowups.ts`
- `packages/core/src/linkedinFeed.ts`
- `packages/core/src/linkedinPosts.ts`

## Main risks to watch

### 1) Account scope can sprawl into a general account-management project

Keep phase 1 focused on the minimum account metadata needed for Tier 3:

- label
- profile/auth resolution
- allowed actions
- approved targets

Do not expand it into full LinkedIn identity management before the harness
exists.

### 2) Network observation can become too brittle or too weak

Avoid both extremes:

- do not hard-code private LinkedIn endpoint names as the primary contract
- do not allow a “write lane” that ignores suspicious traffic entirely

The right middle ground is phase-specific allowlists plus telemetry.

### 3) Public-action cleanup can create false-green runs

A successful comment or post that still requires manual cleanup should not be
flattened into a clean PASS. Treat cleanup as a first-class result.

### 4) Existing DB rows are still profile-centric

Tier 3 should not let that block delivery, but the plan must keep the mismatch
visible:

- policy, locks, and reports are account-scoped
- older DB tables may still remain profile-scoped in phase 1
- if cross-account reporting becomes important, a later schema pass can align
  them

### 5) Scope can drift into “replace all write E2Es immediately”

Do not delete the existing write E2Es early. Keep them as narrower executor
proof points while the harness matures.

### 6) Stored-session support can derail phase 1

Tier 2 proved stored sessions are valuable for read-only validation, but they
are not the fastest path to a safe Tier 3 harness. Keep that boundary explicit.

## Guardrails

### Do touch

- one new Core-owned Tier 3 orchestrator
- one config-backed account registry
- one central write-policy engine
- one thin CLI command and output formatter
- targeted profile/context instrumentation hooks
- layered tests for policy, reporting, CLI, and live opt-in scenarios

### Do not touch unless the implementation proves it is necessary

- broad rewrites of existing write service APIs
- generic plugin systems for scenario loading
- MCP write-harness surfaces in phase 1
- exact private LinkedIn endpoint assertions as the main success contract
- stored-session write execution in the first delivery slice

### Avoid these traps

- raw target values from CLI flags
- implicit default scenario sets
- treating “confirmed” as equivalent to “verified”
- reporting manual cleanup work as green success
- widening rollout to public actions before private/network scenarios are stable

## Implementation compass

If the implementation stays aligned with the points below, it is on the right
track:

- **One lane, not a mashup:** Tier 3 is distinct from Tier 1 replay and Tier 2
  read-only validation.
- **Core first:** planning, policy, and reporting live in `packages/core`.
- **Thin CLI:** `packages/cli` parses flags, prompts, and renders output.
- **Account before breadth:** normalize account identity and approved targets
  before widening scenario coverage.
- **Verification before confidence:** confirmed, verified, state-synced, and
  cleanup-complete are separate outcomes.
- **Roll out from least risky to most public:** inbox reply and reversible
  connection flows first; public engagement and post creation last.
