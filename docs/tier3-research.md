# Tier 3 write-action validation research

Research for GitHub issue #142 (parent issue #90).

This document summarizes the current repository state as reviewed on March 9, 2026, with a focus on how Tier 1 fixture replay and Tier 2 live read-only validation should inform a future Tier 3 write-action validation harness.

## Executive summary

- The repo already has a clear validation shape: a deterministic replay lane, a guarded live smoke lane, and a small set of opt-in live write confirms.
- Tier 3 should extend that shape instead of inventing a parallel stack. The strongest precedent is a Core-owned orchestrator with a thin CLI wrapper, stable JSON output, human-readable summaries, and artifact capture.
- The biggest structural gap is identity. Most existing write flows are keyed by `profileName`, while Tier 2 live validation is keyed by encrypted `sessionName`; there is no canonical account abstraction tying profile, stored session, approval policy, and allowed targets together.
- The codebase does not hard-code stable private LinkedIn mutation APIs. All write actions are implemented as Playwright UI flows, so Tier 3 should validate action types, target pages, network observations, and visible postconditions rather than depend on brittle LinkedIn HTTP endpoint names.
- Safety controls exist but are uneven. Two-phase commit, confirm-token expiry, failure artifacts, encrypted stored sessions, structured logging, and several per-action rate limits are already present. Connection invite/accept/withdraw flows currently have no dedicated rate limiter, public-action cleanup is not standardized, and write executors do not appear to share one central pacing/humanization policy.

## Sources reviewed

Key documents and code paths reviewed for this research:

- `docs/e2e-testing.md`
- `docs/live-validation.md`
- `docs/live-validation-architecture.md`
- `docs/scheduler.md`
- `docs/.research-brief-issue-87.md`
- `docs/.research-brief-issue-88.md`
- `docs/.plan-issue-87.md`
- `docs/.plan-issue-88.md`
- `scripts/run-e2e.js`
- `packages/core/src/fixtureReplay.ts`
- `packages/core/src/liveValidation.ts`
- `packages/core/src/auth/sessionStore.ts`
- `packages/core/src/profileManager.ts`
- `packages/core/src/runtime.ts`
- `packages/core/src/twoPhaseCommit.ts`
- `packages/core/src/rateLimiter.ts`
- `packages/core/src/linkedinInbox.ts`
- `packages/core/src/linkedinConnections.ts`
- `packages/core/src/linkedinFollowups.ts`
- `packages/core/src/linkedinFeed.ts`
- `packages/core/src/linkedinPosts.ts`
- `packages/core/src/scheduler.ts`
- `packages/core/src/db/migrations.ts`
- `packages/core/src/__tests__/e2e/*.test.ts`
- `packages/cli/src/bin/linkedin.ts`
- `packages/cli/src/liveValidationOutput.ts`
- `packages/mcp/src/index.ts`
- `packages/mcp/src/bin/linkedin-mcp.ts`

## What Tier 1 already establishes

Tier 1 is the deterministic fixture replay lane introduced for safe CI and repeatable local regression coverage.

### Patterns worth preserving

- **Replay is its own lane, not a replacement for live testing.** `npm run test:e2e:fixtures` stays separate from the real-session lane in `scripts/run-e2e.js` and `docs/e2e-testing.md`.
- **Fixtures are manifest-backed, versioned, and operator-managed.** `packages/core/src/fixtureReplay.ts` models a fixture manifest, fixture-set metadata, supported page types, route normalization, and freshness checks.
- **Replay is fail-closed.** Replay routing is attached at the Playwright context boundary and only serves known LinkedIn/Licdn traffic from recorded assets.
- **CLI remains thin.** `linkedin fixtures record|check` live in the existing binary and delegate the storage/layout logic to Core helpers.
- **Live and replay share the same suite vocabulary.** The same Vitest suites are used in both lanes, with setup deciding whether the run is replay-backed or real-session-backed.
- **Discovery fixtures are intentionally small and separate.** The live E2E lane has a second, lightweight fixture file for stable live identifiers used by CLI/MCP contract tests. That is distinct from the page replay manifest.
- **Confirm contracts are already unit-tested.** `packages/core/src/__tests__/e2eConfirmContracts.test.ts` and the E2E helpers establish expectations around prepared actions, preview shapes, and generic confirm entrypoints.

### Tier 1 implication for Tier 3

Tier 3 should not try to make fixture replay and live write validation converge into one magic runner. The repo is already organized around explicit lanes:

- deterministic replay for safe regression coverage
- live smoke for read-only drift detection
- opt-in live confirms for real side effects

The right direction is to add a first-class Tier 3 lane that reuses the same harness conventions, not to blur the boundaries between them.

## What Tier 2 already establishes

Tier 2 is implemented as the read-only live validation workflow behind `linkedin test live --read-only`.

### Core architectural decisions

`packages/core/src/liveValidation.ts` is the most important direct template for Tier 3.

It already establishes that the validation lane should be:

- **Core-owned.** The orchestration logic lives in `packages/core`, not inline in the CLI.
- **Fixed-plan.** The run executes a stable ordered suite (`feed`, `profile`, `notifications`, `inbox`, `connections`) so reports stay comparable.
- **Policy-driven.** The run enforces a request cap, minimum interval, read-only network guard, retry policy, blocking error rules, and report persistence.
- **Artifact-aware.** It writes events, JSON reports, and a rolling `latest-report.json` snapshot used for diffing.
- **Session-scoped.** It loads one encrypted stored session, creates one fresh browser context, and runs the full suite there.

### CLI and operator conventions

Tier 2 also established several UX conventions that are strong candidates for Tier 3 reuse:

- explicit acknowledgement flags (`--read-only` today)
- hidden alias support (`test:live`) when it fits existing CLI style
- human-readable progress on `stderr`, structured JSON on `stdout`
- prompt hooks for interactive runs and `--yes` for non-interactive execution
- exit code split between validation failures and preflight/runtime failures
- retry-on-refresh behavior for expired stored sessions in interactive mode

### Output/report conventions

`packages/cli/src/liveValidationOutput.ts` provides a good operator-facing reporting model:

- live progress events
- one stable human-readable summary
- one stable JSON report schema
- sections for warnings, failures, regressions, blocked requests, and suggested next steps

Tier 3 should copy this shape instead of creating a second reporting idiom.

### Tier 2 implication for Tier 3

Tier 3 should follow the same layering:

1. Core module owns run planning, safety policy, retries, and report generation.
2. CLI parses flags, handles prompts, and renders progress/output.
3. Tests cover policy helpers and output formatting separately from the live browser run.

## Account and session model today

The repo currently has multiple identity concepts, but not one canonical account model.

| Concept | Current role | Where it appears | Tier 3 concern |
| --- | --- | --- | --- |
| `profileName` | Logical browser/profile identity | Most Core services, CLI commands, scheduler, DB rows, real-session E2Es | Primary key for most write flows today |
| `sessionName` | Encrypted stored session identity | `linkedin auth session`, Tier 2 live validation | Separate from `profileName`; no explicit mapping |
| `account` table | Reserved schema concept | `packages/core/src/db/migrations.ts` | Exists in SQLite but is currently unused |

### Current split

- The main runtime model uses `ProfileManager` and `profileName` to open either a tool-owned persistent browser profile or an attached CDP browser context.
- Tier 2 deliberately does not use `profileName` or `--cdp-url`. It loads a stored `storageState` blob from `LinkedInSessionStore` by `sessionName`, creates a fresh headless context, and runs validation there.
- DB-backed state such as `prepared_action`, `sent_invitation_state`, and `scheduler_job` is keyed by `profile_name`, not `session_name`.
- The repository already has an `account` table in the schema, but there is no code using it as the source of truth for account selection.
- Stored sessions are encrypted and machine-bound, while normal persistent profiles are ordinary Chromium user-data directories. That makes the two auth modes materially different from a safety and portability perspective.

### Why this matters for Tier 3

Tier 3 will need to answer questions that Tier 2 mostly avoids:

- Which logical LinkedIn account is allowed to perform this mutation?
- Which auth source should be used for that account: persistent profile, attached CDP, or stored session?
- Which safe targets are approved for that account?
- Which reports, artifacts, quotas, and cooldowns belong to that account?
- Which local DB rows should be associated with the run when the auth source is a stored session instead of a persistent profile?

### Recommendation

Before broad Tier 3 implementation, introduce one canonical account registry.

Minimum useful shape:

- `accountId` or equivalent stable logical identifier
- resolved `profileName`
- resolved `sessionName` when stored-session mode is used
- auth mode (`persistent_profile`, `cdp`, or `stored_session`)
- approved targets per action class
- allowed write actions per account
- default operator label/report label

The existing `account` table is a plausible home for this, but the important part is the abstraction, not the storage backend.

## Mutation surface catalog

Important finding: the repo does **not** encode stable private LinkedIn mutation endpoints in source. It drives LinkedIn through Playwright UI flows.

That means the “mutation endpoints” Tier 3 should catalog are the repo’s **action surfaces**:

- action type
- prepare API
- confirm executor
- target page or UI entrypoint
- expected visible verification signal
- local state changes
- current safety controls

### Core mutation surfaces

| Surface | Action type | Prepare API | Confirm executor | Main UI target | Local state touched | Current safeguards |
| --- | --- | --- | --- | --- | --- | --- |
| Inbox reply | `send_message` | `runtime.inbox.prepareReply()` | `SendMessageActionExecutor` | Existing messaging thread | `prepared_action` only | Two-phase commit, 30-minute token TTL, rate limit `linkedin.messaging.send_message` = 20/hour, confirm failure artifacts |
| Connection invite | `connections.send_invitation` | `runtime.connections.prepareSendInvitation()` | `SendInvitationActionExecutor` | Target profile page | `prepared_action`, `sent_invitation_state` on successful send | Two-phase commit, confirm failure artifacts |
| Connection accept | `connections.accept_invitation` | `runtime.connections.prepareAcceptInvitation()` | `AcceptInvitationActionExecutor` | Invitation manager received page | `prepared_action` | Two-phase commit, confirm failure artifacts |
| Connection withdraw | `connections.withdraw_invitation` | `runtime.connections.prepareWithdrawInvitation()` | `WithdrawInvitationActionExecutor` | Invitation manager sent page | `prepared_action`, `sent_invitation_state` closed reason `withdrawn` | Two-phase commit, confirm failure artifacts |
| Follow-up after accept | `network.followup_after_accept` | `runtime.followups.prepareFollowupsAfterAccept()` / `runtime.followups.prepareFollowupForAcceptedConnection()` | `FollowupAfterAcceptActionExecutor` | Accepted connection profile / message surface | `prepared_action`, `sent_invitation_state`, optional `scheduler_job` linkage | Two-phase commit, message send rate limit, scheduler business-hours + retry policy for preparation |
| Feed like | `feed.like_post` | `runtime.feed.prepareLikePost()` | `LikePostActionExecutor` | Target post page | `prepared_action` | Two-phase commit, rate limit `linkedin.feed.like_post` = 30/hour, confirm failure artifacts |
| Feed comment | `feed.comment_on_post` | `runtime.feed.prepareCommentOnPost()` | `CommentOnPostActionExecutor` | Target post page | `prepared_action` | Two-phase commit, rate limit `linkedin.feed.comment_on_post` = 15/hour, confirm failure artifacts |
| Post create | `post.create` | `runtime.posts.prepareCreate()` | `CreatePostActionExecutor` | Feed composer / post composer | `prepared_action` | Two-phase commit, rate limit `linkedin.post.create` = 1/day, content linting, confirm failure artifacts |

### Verification strength today

The current write executors do not all verify success equally well.

- `post.create` has the strongest visible verification: it re-checks the feed for the published post snippet.
- `feed.comment_on_post` also performs a visible verification pass after submission.
- `connections.send_invitation` verifies a pending/sent state indicator on the profile surface.
- `connections.accept_invitation` and `connections.withdraw_invitation` are comparatively shallow and mostly rely on click success plus short waits.
- `send_message` and `network.followup_after_accept` use message-echo verification, but that verification is best-effort rather than a hard failure boundary.

### Operator-facing entrypoints

CLI write surfaces today:

- `linkedin inbox prepare-reply`
- `linkedin connections invite`
- `linkedin connections accept`
- `linkedin connections withdraw`
- `linkedin followups prepare`
- `linkedin feed like`
- `linkedin feed comment`
- `linkedin post prepare`
- `linkedin actions confirm`

MCP write surfaces today:

- `linkedin.inbox.prepare_reply`
- `linkedin.connections.invite`
- `linkedin.connections.accept`
- `linkedin.connections.withdraw`
- `linkedin.network.prepare_followup_after_accept`
- `linkedin.feed.like`
- `linkedin.feed.comment`
- `linkedin.post.prepare_create`
- `linkedin.actions.confirm`

One important operational difference: the CLI confirm flow is safer by default than MCP. The CLI prints preview information, prompts for explicit confirmation unless `--yes` is set, and refuses non-interactive confirmation without that acknowledgement. MCP exposes raw prepare and confirm tools directly.

### Current live write coverage

The repo already has live E2E proof points for real confirm flows, but they are intentionally opt-in and fragmented by action class:

- messages via `LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM`
- connections via `LINKEDIN_E2E_ENABLE_CONNECTION_CONFIRM`
- likes via `LINKEDIN_E2E_ENABLE_LIKE_CONFIRM`
- comments via `LINKEDIN_E2E_ENABLE_COMMENT_CONFIRM`
- posts via `LINKEDIN_ENABLE_POST_WRITE_E2E`

By default, the live lane still exercises preview behavior for the opt-in write suites, while real confirms stay skipped.

## Existing safety mechanisms

### Already in place

- **Two-phase commit everywhere for outbound actions.** Prepare returns a `preparedActionId`, `confirmToken`, expiry, and preview. Confirm executes through registered executors in `runtime.ts`.
- **Short-lived confirm tokens.** Default TTL is 30 minutes in `packages/core/src/twoPhaseCommit.ts`.
- **Encrypted-at-rest stored sessions.** `LinkedInSessionStore` saves Playwright `storageState` using AES-GCM with a local master key.
- **Structured failure artifacts.** `executeConfirmActionWithArtifacts()` centralizes screenshot/trace/error attachment for confirm-time failures.
- **Per-action quotas for several write classes.** Messages/followups, likes, comments, and posts all use `RateLimiter` counters.
- **Persistent auth cooldown handling.** Auth rate-limit challenges are recorded in `rate-limit-state.json` and surfaced by `LinkedInAuthService`.
- **Scheduler safety for follow-up preparation.** The scheduler only prepares follow-ups, never auto-confirms them, and adds business-hours and retry controls.
- **Approved-target documentation.** `docs/e2e-testing.md` and `AGENTS.md` clearly restrict live social writes to approved targets.
- **Post-specific content linting.** Post creation has the strongest prepare-time safety checks via `lintLinkedInPostContent()` and `postSafetyLint` config.

### Important asymmetries

Not all write paths are equally protected.

- Connections do **not** currently use a dedicated confirm-time rate limiter.
- Connection prepare previews do not expose the same rate-limit metadata that message/feed/post previews do.
- Rate-limit counters are global per assistant home, not scoped per `profileName`, target, or logical account.
- Public actions are guarded mainly through docs and opt-in env flags, not a central runtime policy engine.
- The `humanize()` helper is used in auth/keepalive flows, but not visibly shared by the write executors themselves.
- Post creation has content linting; comments, messages, follow-up messages, and connection notes do not have a comparable central lint layer.
- Stored-session auth is encrypted-at-rest, while persistent-profile auth is not protected the same way.

## Gaps that matter for Tier 3

### 1) No shared write-validation orchestrator

Today, live write validation exists as scattered opt-in E2E tests. There is no Tier-2-style Core service that:

- plans a multi-step write validation run
- applies one explicit safety policy
- records one unified report
- captures per-phase artifacts and outcomes
- summarizes recommended operator follow-ups

### 2) No canonical account identity

Tier 3 cannot scale cleanly while `profileName` and `sessionName` stay parallel concepts with no explicit mapping.

### 3) No phase-specific write network policy

Tier 2 can simply allow `GET` and block everything else. Tier 3 will need a more expressive policy:

- prepare phase should remain as close to read-only as possible
- confirm phase should allow only expected LinkedIn-owned write traffic for the specific action under test
- verify phase should return to read-only expectations

The repo does not yet have a shared abstraction for that.

### 4) No unified approval matrix

The current opt-in model is mostly environment-driven and documented socially:

- approved message target
- approved connection target
- manual approval for likes/comments/posts

That works for ad hoc E2Es, but Tier 3 needs a central policy object or account registry that can answer “is this action/target allowed in this run?” before Playwright navigates anywhere.

### 5) No standardized cleanup story for public side effects

Likes, comments, and posts leave visible public artifacts. Existing tests rely on opt-in flags and manual cleanup expectations, but there is no shared cleanup plan or run report field that captures whether cleanup is automatic, manual, or intentionally skipped.

### 6) Mixed remote and local mutation semantics

Some flows mutate LinkedIn and local state, some only mutate LinkedIn, and some are nominally read-only on LinkedIn while still updating local DB state.

Examples:

- `followups` preparation writes local queue/state data even before confirm
- connection invite/withdraw update `sent_invitation_state`
- scheduler activity can prepare future writes without confirming them

Tier 3 reports should distinguish:

- remote side effect on LinkedIn
- local side effect in assistant state
- verification result for each

### 7) Verification quality is inconsistent across actions

Tier 3 should not assume that the existing executors already prove success to the same standard.

- Connection accept/withdraw are currently lighter-weight than comment/post verification.
- Message and follow-up send rely on echo checks that do not always fail hard when the echo is missing.
- Post verification is snippet-based and therefore stronger than nothing, but still not a perfect unique-proof contract.

This matters because Tier 3 needs to report both **action executed** and **side effect verified** as separate states.

### 8) Confirm execution is not obviously idempotent under concurrency

`TwoPhaseCommitService.confirmByToken()` reads the prepared row, executes the action, and only then persists the executed/failed result.

That is acceptable for today’s mostly human-driven workflow, but Tier 3 should assume a future harness may run in more automated or concurrent contexts. A safer architecture would either:

- claim/lock the prepared action before side effects happen, or
- make confirm paths explicitly idempotent at the action layer.

### 9) No write diff/baseline model yet

Tier 2 has a rolling diff model against `latest-report.json`. There is no equivalent baseline format for write validation results, even though stable comparison will matter for later regression detection.

## Recommended Tier 3 architecture

### 1) Put Tier 3 orchestration in `packages/core`

Add one Core module dedicated to write validation, similar in spirit to `packages/core/src/liveValidation.ts`.

It should own:

- scenario definitions
- run planning
- account resolution
- approval and target checks
- per-phase network policy
- retries and cooldown enforcement
- unified reporting
- artifact capture hooks

The CLI should stay thin and only provide:

- flag parsing
- interactive confirmation prompts
- progress rendering
- human/JSON output selection

### 2) Model Tier 3 around explicit scenarios

A Tier 3 scenario should be more specific than a generic action type. A useful first-pass scenario shape would include:

- stable scenario id
- action type
- risk class (`private`, `network`, `public`)
- account reference
- target resolver
- prepare function
- confirm function
- verification function
- cleanup guidance
- allowed target policy
- allowed network policy for prepare/confirm/verify phases
- cooldown/quota policy

That keeps the harness concrete and comparable without forcing a generic plugin framework too early.

### 3) Reuse Tier 2’s report philosophy

Tier 3 should emit one stable JSON report plus one human-readable summary.

Suggested report fields:

- run metadata: scenario set, account id, auth mode, operator flags, timestamps
- per-scenario phase results: `preflight`, `prepare`, `confirm`, `verify`, optional `cleanup`
- prepared action metadata: `preparedActionId`, expiry, preview summary
- blocked/unexpected request summary during each phase
- artifact paths
- local state changes detected
- verification result for the LinkedIn side effect
- cleanup requirements or reminders
- recommended next actions

Do **not** persist raw confirm tokens in reports or logs.

### 4) Introduce a write-policy engine

Tier 3 needs something stricter than today’s scattered env flags.

Minimum responsibilities:

- validate approved account/action/target combinations
- apply per-action quotas, including new quotas for connection flows
- scope quotas per logical account and, where useful, per target class
- decide whether a scenario is allowed in unattended mode
- distinguish public actions from private-message/network actions
- define phase-specific network allowlists
- emit explicit rejection reasons into the final report

### 5) Raise verification and confirmation to first-class concepts

Tier 3 should model these as separate concerns:

- **confirmed:** the executor completed without throwing
- **verified:** the expected LinkedIn-side effect was re-observed
- **state_synced:** local DB/state updates were applied as expected

That will make weaker current flows visible instead of flattening them into one ambiguous “pass”.

### 6) Normalize account selection first

The cleanest near-term move is to make every Tier 3 run resolve through one logical account object, even if the underlying auth mode remains mixed.

At minimum, each scenario run should carry:

- `accountId`
- `profileName`
- `sessionName` when relevant
- `authMode`
- `approvedTargetSet`

### 7) Treat network observations as telemetry, not source-of-truth contracts

Because the repo drives UI flows rather than calling official LinkedIn APIs, Tier 3 should avoid hard-coding private mutation endpoints as the primary contract.

Better approach:

- validate the repo’s own action types and visible outcomes
- record request telemetry during confirm
- flag unexpected domains/methods or obviously suspicious traffic
- optionally snapshot observed LinkedIn write requests for operator review
- avoid asserting on exact private endpoint names unless a later phase proves they are stable enough to be useful

### 8) Harden confirm concurrency before broad automation

If Tier 3 becomes more automated than today’s opt-in E2Es, it should include one of these protections early:

- DB claim/lease of prepared actions before confirm executes
- optimistic update that fails closed when the row is no longer `prepared`
- action-specific idempotency checks before UI submission

## Recommended implementation order

### Slice 1: contracts and policy

Build the Tier 3 scaffolding before any live write execution:

- account resolution
- scenario definitions
- report schema
- phase model
- approval policy
- network policy abstraction

### Slice 2: lowest-risk live scenarios

Start with the least publicly visible, most reversible flows:

- inbox reply to approved thread
- connection invite / withdraw against approved target

These already have narrow targets and clear visible verification signals.

### Slice 3: remaining network/private actions

Add:

- connection accept
- follow-up after accept

These are useful but more coupled to invitation state and scheduler/local DB state.

### Slice 4: public engagement actions

Add:

- feed like
- feed comment

These should likely require explicit approval metadata in the scenario definition and clear cleanup guidance in the report.

### Slice 5: post creation last

`post.create` is the highest-risk Tier 3 scenario:

- most public visibility
- strongest need for cleanup discipline
- most complex composer/visibility workflow
- most sensitive content validation requirements

It should land only after the harness, policy engine, and account model are already stable.

## Planning recommendations

For the planning phase after this research, the strongest next questions are:

1. Should Tier 3 support both `profileName` and stored-session auth on day one, or standardize on one auth mode first?
2. Will the existing SQLite `account` table become the source of truth for multi-account support, or should account mapping live in config first?
3. Which scenarios are officially allowed for unattended runs versus interactive-only runs?
4. What is the minimum acceptable cleanup story for public actions?
5. Should Tier 3 reports be diffed against a rolling baseline the same way Tier 2 reports are?

## Bottom line

The repo is already pointing in the right direction.

Tier 1 established the lane separation, deterministic replay conventions, and operator workflow. Tier 2 established the Core-owned orchestration, safety policy, report/output model, and stored-session pattern. Tier 3 should build directly on those ideas.

The most important design choice before implementation is to normalize account identity and write policy. Once that exists, the actual write validation harness can look a lot like Tier 2: fixed scenarios, clear guardrails, one structured report, and a thin CLI wrapper.
