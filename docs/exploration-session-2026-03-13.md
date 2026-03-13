# LinkedIn Buddy Exploration Session — 2026-03-13

## Overview

First comprehensive exploration of LinkedIn Buddy CLI features using the Joi Ascend test account. The session tested read-only operations, write operations (posts, connections, feed interactions), and discovery features (search, newsletters).

## Account State

- **Profile**: Joi Ascend
- **Headline**: Personal Assistant to Director at Signikant
- **Location**: Copenhagen, Capital Region of Denmark
- **Connections**: 0
- **Posts**: 1 ("hi yall - new here" — 37 impressions, 1 reaction, 1 comment)
- **Pending invitations**: 2 sent (Natasha Negi, Haider Khan)

## Features Tested

### Working Features

| Feature | Status | Notes |
|---------|--------|-------|
| `status` | Working | Correctly identifies Joi Ascend |
| `profile view` (self) | Working | Returns basic profile data |
| `profile view` (others) | Working | Returns basic profile data |
| `notifications list` | Working | Returned 4 notifications |
| `feed view` (by URN) | Working | Returns full post details |
| `connections pending` | Working | Shows sent/received invitations |
| `jobs search` | Partial | Returns results but with data quality issues |
| `feed like` (prepare + confirm) | Working | Successfully reacted to post |
| `post prepare` | Working | Returns token (even when rate-limited) |

### Broken Features

| Feature | Error | Issue Filed |
|---------|-------|-------------|
| `search` (people) | Returns 0 results | #474 |
| `search` (companies) | Returns 0 results | #474 |
| `search` (posts) | Returns 0 results | #474 |
| `connections invite` (with note) | UI_CHANGED_SELECTOR_FAILED | #476 |
| `connections invite` (no note) | UI_CHANGED_SELECTOR_FAILED | #476 |
| `newsletter list` | UI_CHANGED_SELECTOR_FAILED | #481 |
| `feed list` | Returns 0 posts | #479 |

### Data Quality Issues

| Feature | Issue | Issue Filed |
|---------|-------|-------------|
| `jobs search` | Duplicate results, doubled titles, empty company | #475 |
| `feed view` | Author headline text doubled | #480 |
| `profile view` | Experience/education always empty | #483 |
| Privacy redaction | False positives on common words | #477 |

## Issues Filed

| # | Title | Type |
|---|-------|------|
| #474 | People, company, and post search returns 0 results | Bug |
| #475 | Job search returns duplicates with garbled titles | Bug |
| #476 | Connection invitation selectors completely broken | Bug |
| #477 | Privacy redaction aggressive false positives | Bug |
| #478 | Rate limiter allows prepare when rate-limited | Bug |
| #479 | Feed list returns 0 posts | Bug |
| #480 | Text duplication in headlines and titles | Bug |
| #481 | Newsletter/article selectors broken | Bug |
| #482 | Session drops during moderate automated usage | Enhancement |
| #483 | CLI quality-of-life improvements | Enhancement |

## Session Timeline

1. Auth verified — Joi Ascend, authenticated
2. Profile view — own profile retrieved
3. Feed list — returned empty (bug)
4. People search — returned empty (bug)
5. Notifications — 4 items including post analytics
6. First post view — 37 impressions, 1 comment
7. Connections list — 0 connections
8. Connection invite to Simon Miller — selector failure
9. Feed react (celebrate on own post) — success!
10. Post prepare — rate-limited from earlier session
11. Newsletter list — selector failure
12. **Session dropped** — login wall detected after ~15 operations

## Key Observations

1. **Selector staleness is the biggest issue** — LinkedIn UI changes have broken connections, newsletters, and search. Feed reactions still work.
2. **New account limitations** — The empty search results may partially be LinkedIn restricting search for very new accounts.
3. **Session fragility** — The session dropped after moderate usage, suggesting either bot detection or cookie expiry under load.
4. **Privacy redaction is too aggressive** — Common words like "AI" and city names get redacted as person names, making output unreadable.
5. **Rate limiter has design gaps** — Prepare should fail fast when rate-limited instead of returning tokens that can't be confirmed.

## Recommendations

1. **Priority fix**: Connection invitation selectors (core networking feature)
2. **Priority fix**: Search selectors (core discovery feature)
3. **Investigate**: Feed list empty results
4. **Improve**: Privacy redaction false positive rate
5. **Improve**: Session resilience under automated usage
6. **Polish**: Rate limiter UX (fail fast at prepare stage)
