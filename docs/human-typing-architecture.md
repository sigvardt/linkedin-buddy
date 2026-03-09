# Human-like typing simulation architecture

Research for GitHub issue #159 (parent issue #131). Reviewed March 9, 2026.

## Executive summary

- `HumanizedPage.type()` currently types one character at a time with a flat
  random delay model: `80ms` base delay, up to `60ms` jitter, and a `5%`
  chance of a `200-600ms` think pause after each character.
- That produces an average inter-key interval of about `130ms` in the default
  profile, or roughly `92 WPM` using the standard `5 chars = 1 word`
  convention. The current `fast` mode averages about `60ms` per character,
  which is roughly `200 WPM`.
- Large-scale desktop typing research reports an average closer to `52 WPM`
  with wide variation across users, bursty word-level pacing, and context
  changes around punctuation and edits. The current implementation is therefore
  both too fast and too uniform for the write flows that issue #131 targets.
- The recommended design is a two-stage typing engine behind the existing
  `HumanizedPage` surface:
  1. a deterministic plan builder that converts text into timed typing actions
  2. a Playwright executor that emits keyboard events and waits according to
     that plan
- The plan builder should use a custom US QWERTY adjacency map keyed by
  `KeyboardEvent.code`, a profile-based cadence model, an opt-in typo engine,
  and a correction model built from short error bursts plus backspaces.
- The public API should remain non-breaking. Existing calls to
  `humanize(page, options)` and `HumanizedPage.type(selector, text)` continue
  to work, while new typing behavior is enabled through added options and safe
  defaults.

## Current repository state

### What exists today

- `packages/core/src/humanize.ts` defines `HumanizeOptions` with `baseDelay`,
  `jitterRange`, `fast`, `typingDelay`, and `typingJitter`.
- `HumanizedPage.type()`:
  - scrolls the target into view
  - clicks the first matching locator
  - iterates through `text` one character at a time
  - calls `page.keyboard.type(char, { delay: 0 })`
  - waits for `typingDelay + random() * typingJitter`
  - adds a `200-600ms` think pause with `5%` probability
- The current typing path does not model:
  - keyboard geometry
  - same-hand or same-finger transitions
  - word-boundary or punctuation pauses
  - typos or corrections
  - explicit modifier handling for `Shift`
  - seeded randomness for deterministic tests

### Where it is used

- `packages/core/src/auth/session.ts` uses `hp.type()` for LinkedIn email and
  password entry during interactive authentication.
- `packages/core/src/keepAlive.ts` uses `humanize()` for scrolling and idle
  behavior, but does not use `hp.type()`.
- The current write executors do not appear to share a richer typing policy.

### Current test coverage

- `packages/core/src/__tests__/humanize.test.ts` only verifies delay ranges,
  fast-mode defaults, option merging, and wrapper creation.
- There is no unit or browser-level test coverage for actual keystroke
  sequences, modifier handling, typo generation, or correction behavior.

## Design goals

- Make typing look plausibly human without changing the final text.
- Keep the public API backward compatible.
- Avoid risky behavior in sensitive fields such as passwords.
- Prefer deterministic, seedable planning over hard-to-test inline randomness.
- Reuse Playwright keyboard primitives instead of dropping directly to CDP for
  the main path.
- Keep the first implementation US QWERTY specific, but leave room for future
  locale-aware layouts.

## Constraints and safety rules

- The final field value must exactly match the requested `text` unless a caller
  explicitly opts into visible mistakes for a dedicated test harness.
- Password fields and other sensitive fields should disable typo injection by
  default, even if richer cadence modeling is enabled.
- The typing engine must work with the existing Playwright `Page` surface that
  the repo already uses for direct browser automation and CDP-backed contexts.
- The implementation should be safe to adopt incrementally in auth and future
  write flows without forcing all callers to accept a more aggressive profile.

## External findings that shape the design

### Current Playwright and CDP behavior

- Playwright `keyboard.type()` emits full keyboard event sequences for
  characters that exist on the keyboard, but falls back to plain text insertion
  for characters that do not map cleanly to the active layout.
- Playwright `keyboard.insertText()` emits only an input event, which makes it
  useful as a fallback but too weak for realistic modifier-aware simulation.
- Playwright `keyboard.down()` and `keyboard.up()` support modifier state, so
  holding `Shift` changes the meaning of subsequent key presses.
- Chrome DevTools Protocol exposes lower-level primitives such as
  `Input.dispatchKeyEvent` and `Input.insertText`, but using CDP directly would
  make the engine more browser-specific and would duplicate logic that
  Playwright already abstracts.

### Human typing patterns

- Large-scale desktop typing studies report average speeds near `52 WPM`, with
  most people using fewer than ten fingers and showing substantial variation by
  key transition, punctuation, and whether they look at the keyboard.
- Real typing is bursty rather than uniform. Inter-key delays are right-skewed,
  short within smooth letter sequences, and longer at word boundaries,
  punctuation, and edits.
- Revision research supports the idea that corrections cluster into short edit
  bursts instead of being spread evenly across a sentence.

### Library survey: existing packages vs custom map

- A quick JavaScript package survey found layout-oriented libraries and general
  keyboard helpers, but not a small maintained package that combines all of the
  following needs in one place:
  - weighted QWERTY adjacency for typo generation
  - explicit `Shift` and symbol modeling
  - deterministic seeded planning
  - Playwright-oriented execution semantics
  - future locale/version control inside this repo
- Recommendation: keep the cadence model and typo planner in-repo and ship a
  custom first-party US QWERTY map instead of adding a dependency.

## Recommended architecture

### High-level shape

Split typing into three layers:

1. `TypingProfile`: profile presets and resolved numeric parameters
2. `TypingPlanBuilder`: a pure, seedable planner that produces keystroke
   actions and timed waits
3. `TypingPlanExecutor`: a Playwright-backed executor that runs the plan

That separation gives the repo three benefits:

- unit tests can validate the plan without a browser
- browser integration tests can validate event sequences separately
- future write executors can reuse the same planner without re-embedding random
  timing logic in each action

### Proposed module split

The eventual implementation can stay centered around `packages/core/src`, with
minimal surface-area growth:

- `packages/core/src/humanize.ts`
  - keep `HumanizedPage` as the public entry point
  - resolve profile defaults and call the plan builder
- `packages/core/src/typingProfiles.ts`
  - preset definitions and parameter validation
- `packages/core/src/keyboardLayouts/usQwerty.ts`
  - physical key map and adjacency graph
- `packages/core/src/typingPlan.ts`
  - plan types and planner logic
- `packages/core/src/typingExecutor.ts`
  - Playwright execution helpers

This split is not required for the first patch, but it is the cleanest long-
term shape if typing logic grows beyond a single helper.

## Keyboard adjacency map design

### Why key by `code` instead of only by character

The typo engine should model physical proximity, not just textual similarity.
`KeyboardEvent.code` gives a stable physical key identity such as `KeyA` or
`Digit2`, which is the right anchor for:

- adjacent-letter substitutions
- shifted symbol generation
- left/right-hand transition heuristics
- future per-layout overrides

Character-only maps are insufficient because several important typos depend on
modifier state and shared physical keys.

### Recommended map structure

Each key record should include:

- `code`: physical key identity such as `KeyA`
- `unshifted`: base printable character such as `a`
- `shifted`: shifted printable character such as `A` or `@`
- `row` and `column`: approximate geometry for neighborhood calculations
- `hand` and `finger`: coarse ergonomic metadata for cadence heuristics
- `neighbors`: weighted adjacent keys, split by relationship type

The adjacency graph should distinguish at least these categories:

- horizontal neighbor on the same row
- diagonal neighbor on the next row
- vertical reach or same-finger reach
- shifted variant on the same physical key

### Recommended weighting

Start with simple static weights and refine only after real traces exist:

- same-row horizontal: `1.0`
- diagonal: `0.8`
- vertical reach: `0.6`
- same-finger stretch: `0.4`

Those weights are only for typo candidate sampling. They do not need to model
true biomechanics perfectly in phase 1.

### Initial scope

Phase 1 should support the printable subset used in LinkedIn messages and auth
flows:

- letters `a-z`
- digits `0-9`
- space and common punctuation
- shifted digit symbols such as `!`, `@`, `#`

Unknown characters should bypass typo planning and use a fallback text path.

## Typo generation algorithm

### Principle

The engine should simulate occasional recoverable motor mistakes, not random
string corruption. Most errors should be single-step mistakes that a user
immediately notices and fixes.

### Eligibility rules

Only consider typo generation when all of these are true:

- `simulateTypos` is enabled
- the current field is not marked sensitive
- the current character has a known physical-key mapping
- the current word is long enough to absorb a correction naturally
- the per-message typo budget is not exhausted

### Recommended typo classes

Start with four typo classes:

1. adjacent substitution
   - intended `t`, produced `r` or `y`
   - default class for most simulated mistakes
2. missing shift
   - intended `A`, produced `a`
   - intended `?`, produced `/`
3. duplicated character
   - intended `l`, produced `ll`
4. short transposition
   - intended `te`, produced `et`
   - only when the next character is eligible and the word is long enough

Recommended initial class weights:

- adjacent substitution: `0.65`
- missing shift: `0.15`
- duplicated character: `0.10`
- transposition: `0.10`

These weights are intentionally conservative. They produce believable errors
without making text look chaotic.

### Typo budgeting

Do not sample typos independently for every character with no upper bound.
Instead:

- compute a target typo budget from text length and profile rate
- clamp the budget to avoid bursts in short strings
- allow at most one active mistake at a time
- avoid back-to-back typo events within the same short word unless explicitly
  testing an error-heavy profile

For example, a 150-character LinkedIn message under a casual profile should
usually produce zero or one correction, not five.

## Correction sequence design

### Default correction behavior

When a typo is emitted, the planner should schedule:

1. the mistaken keystroke or short mistaken burst
2. a recognition pause
3. one or more `Backspace` actions
4. a brief recovery pause
5. the intended replacement text

### Recommended timing distributions

Use profile-specific, right-skewed distributions rather than fixed waits.

- recognition pause after noticing a mistake:
  - careful: median `220ms`, p95 about `450ms`
  - casual: median `160ms`, p95 about `320ms`
  - fast: median `120ms`, p95 about `240ms`
- backspace interval:
  - careful: `70-120ms`
  - casual: `55-95ms`
  - fast: `45-80ms`
- recovery pause before resuming forward typing:
  - careful: `100-220ms`
  - casual: `80-180ms`
  - fast: `60-140ms`

### Immediate vs delayed correction

Default distribution for when the correction happens:

- immediate correction within the same word:
  - careful: `95%`
  - casual: `90%`
  - fast: `80%`
- delayed correction at the next word boundary:
  - careful: `5%`
  - casual: `10%`
  - fast: `20%`

Do not defer corrections across sentence-final punctuation, submit actions, or
field blur events.

### What not to simulate in phase 1

Avoid these behaviors in the initial implementation:

- cursor movement with arrow keys
- selection-based replacement
- mouse-driven correction
- multi-word deferred edits

Backspace-and-retype is both realistic enough and far more reliable for UI
automation.

## Cadence model

### Replace uniform jitter with a contextual model

The current model adds a flat random delay after each character. Replace that
with a cadence model built from these components:

- base inter-key interval drawn from the selected profile
- transition adjustment for same-hand and same-finger motion
- word-boundary pause
- punctuation pause
- sentence-final pause
- post-correction recovery pause
- occasional think pause after longer bursts

### Recommended base speed ranges

Use WPM as the profile-facing abstraction and convert it to inter-key timing
internally with the standard `60000 / (wpm * 5)` formula.

Recommended profile ranges:

- careful: `35-50 WPM`
- casual: `45-65 WPM`
- fast: `70-90 WPM`

Those ranges keep the default profile close to the large-scale typing research,
while still allowing a clearly faster preset when needed.

### Recommended contextual adjustments

Add small delays on top of the base inter-key interval:

- same-hand transition: `+10-30ms`
- same-finger stretch: `+25-70ms`
- shifted character: `+20-50ms`
- digit or symbol: `+15-45ms`
- word boundary: `+50-140ms`
- comma or semicolon: `+120-260ms`
- sentence-ending punctuation: `+220-600ms`

Think pauses should be tied to burst length and boundaries rather than sampled
blindly after each character. A good starting rule is one extra think pause
every `20-60` characters on average, with a heavier bias after punctuation.

### Distribution choice

Use a log-normal or gamma-shaped distribution for pauses. Either is acceptable
as long as the planner produces:

- many short intervals
- fewer medium intervals
- rare but believable long pauses

A uniform distribution should not be used for primary typing cadence.

## Typing profile presets

### Recommended preset table

| Profile | Base speed | Typo rate | Word pauses | Correction style |
| --- | --- | --- | --- | --- |
| `careful` | `35-50 WPM` | `0.1-0.3%` per eligible char | slightly heavier | mostly immediate |
| `casual` | `45-65 WPM` | `0.3-0.8%` per eligible char | medium | immediate with some deferred word-boundary fixes |
| `fast` | `70-90 WPM` | `0.8-1.5%` per eligible char | lighter within words, burstier overall | fastest correction, most deferred fixes |

These are engineering defaults, not claims about one true human average.
They are conservative enough for automation while still producing visible human
variation.

### Additional internal profile recommendation

Add a fourth internal profile for safe rollout:

- `auth`
  - cadence similar to `careful`
  - `simulateTypos: false`
  - stronger word-boundary pauses
  - intended for login and other sensitive fields

The public issue only requires `casual`, `careful`, and `fast`, but an
internal auth-safe preset reduces rollout risk.

## Shift key simulation mechanics

### Recommended primary path

For characters with a known US QWERTY mapping, use explicit modifier-aware key
actions instead of relying exclusively on `keyboard.type()`.

Examples:

- `A`
  - `keyboard.down("Shift")`
  - press `KeyA`
  - `keyboard.up("Shift")`
- `@`
  - `keyboard.down("Shift")`
  - press `Digit2`
  - `keyboard.up("Shift")`

That approach gives the planner accurate control over:

- typo generation on shifted keys
- realistic modifier timing
- browser-visible keyboard events

### Shift hold heuristics

Phase 1 can start with simple per-character shift taps. Later refinement can
hold `Shift` across short uppercase runs such as acronyms.

Recommended initial rules:

- single shifted character: tap `Shift`
- two or more consecutive shifted letters: optionally hold `Shift` for the run
- symbols from shifted digits: always use explicit `Shift` + key when mapped

### Fallback path

When a character has no known physical-key mapping under the selected layout:

- skip typo generation for that character
- insert it with `keyboard.type(char, { delay: 0 })` or `insertText`
- continue with the planned cadence after the fallback

## Integration plan for the existing `HumanizedPage` API

### Non-breaking API shape

Keep the current constructor and helper:

- `humanize(page, options?)`
- `new HumanizedPage(page, options?)`

Extend `HumanizeOptions` rather than replacing it.

Recommended additions:

- `typingProfile?: "careful" | "casual" | "fast"`
- `simulateTypos?: boolean`
- `sensitive?: boolean`
- `typingSeed?: number`
- `keyboardLayout?: "us-qwerty"`
- `typingOverrides?: Partial<ResolvedTypingProfile>`

### Method evolution

Keep the existing method valid:

- `type(selector: string, text: string): Promise<void>`

Optional phase-2 enhancement:

- `type(selector: string, text: string, options?: HumanizedTypeOptions): Promise<void>`

The third parameter is additive and therefore non-breaking.

### Rollout plan

1. refactor `type()` to use a private planner/executor split but preserve the
   current visible behavior
2. replace flat per-character jitter with profile-based cadence while keeping
   `simulateTypos` disabled by default
3. add the US QWERTY map and typo/correction planning behind
   `simulateTypos: true`
4. enable typo simulation only in safe write surfaces, not in auth/password
   flows
5. expand adoption to additional write executors after local event-harness
   validation proves stable

## Test strategy

### Unit tests

Add fast deterministic tests for pure planning logic:

- profile resolution and option merging
- WPM-to-delay conversion
- adjacency map coverage for supported printable characters
- typo class selection and budgeting
- correction plans always restoring the intended final text
- shift planning for uppercase letters and shifted symbols

### Browser integration tests

Use a local HTML fixture with listeners for `keydown`, `keyup`, `beforeinput`,
and `input` so the suite can assert the exact event order for:

- lowercase text
- uppercase text with explicit `Shift`
- punctuation and symbols
- typo plus backspace correction
- fallback insertion for unmapped characters

This is more reliable than trying to validate the raw sequence against a live
LinkedIn page.

### Statistical envelope tests

For seeded batches of generated plans, assert that distributions stay inside
expected envelopes instead of snapshotting every delay exactly:

- average WPM within profile range
- typo counts within budget
- backspace counts matching planned corrections
- long pauses appearing rarely but predictably

### Safety tests

Add specific tests for rollout constraints:

- `sensitive: true` never injects typos
- password-field helpers never emit visible wrong characters
- `simulateTypos: false` still benefits from cadence modeling
- `fast: true` remains available without forcing the new profile system

## Recommended implementation order

### Phase 0: research and design

- deliver this architecture document
- settle initial profile ranges and safe defaults

### Phase 1: planner and cadence refactor

- introduce a seedable plan type
- keep typo injection off
- add unit and local browser tests

### Phase 2: adjacency map and typo engine

- ship the US QWERTY map
- add substitution, missing-shift, duplicate, and transposition typos
- add correction planning and backspace timing

### Phase 3: controlled adoption

- use `careful` or `auth` for sensitive flows
- opt selected write flows into `casual`
- collect real-world artifacts before adjusting profile defaults

## Recommendation

Proceed with a custom, seedable typing planner behind the existing
`HumanizedPage` API. The first implementation should focus on realistic cadence
and explicit modifier handling, with typo generation kept opt-in and disabled
for sensitive fields. That gives issue #131 a credible human-typing
architecture without destabilizing the auth flow that already depends on
`hp.type()`.

## Source notes

- Playwright keyboard API docs: `https://playwright.dev/docs/api/class-keyboard`
- Chrome DevTools Protocol Input domain:
  `https://chromedevtools.github.io/devtools-protocol/tot/Input/`
- Dhakal, Feit, Kristensson, and Oulasvirta, "Observations on Typing from 136
  Million Keystrokes", CHI 2018 / Typing37k summary pages
- Dhakal et al., "How We Type", CHI 2019
- Writing-process pause and revision literature reviewed for bursty edit and
  pause behavior
