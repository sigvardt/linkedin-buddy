# LinkedIn Platform Exploration Session — March 15, 2026

## Session Overview

Full exploration of LinkedIn Buddy capabilities using the Joi Ascend test profile.
Goal: Fill out profile, engage with platform features, and document tool issues.

## Profile State

| Field | Status | Value |
|-------|--------|-------|
| Name | ✅ Set | Joi Ascend |
| Headline | ✅ Set | Executive Assistant to the Director at Signikant \| Making AI workflows human-friendly |
| Location | ✅ Set | Copenhagen, Capital Region of Denmark, Denmark |
| Vanity URL | ✅ Updated | linkedin.com/in/joi-ascend |
| Industry | ✅ Set | Technology, Information and Internet |
| About | ❌ Blocked | LinkedIn UI changed — see #526 |
| Experience | ❌ Blocked | LinkedIn UI changed — see #526 |
| Education | ❌ Blocked | LinkedIn UI changed — see #526 |
| Certifications | ❌ Blocked | LinkedIn UI changed — see #526 |
| Languages | ❌ Blocked | LinkedIn UI changed — see #526 |
| Projects | ❌ Blocked | LinkedIn UI changed — see #526 |
| Volunteer | ❌ Blocked | LinkedIn UI changed — see #526 |
| Honors | ❌ Blocked | LinkedIn UI changed — see #526 |

## Platform Activity

| Feature | Status | Details |
|---------|--------|---------|
| Post creation | ✅ Works (rate limited 1/day) | 2 posts exist from previous session |
| Feed reactions | ✅ Works | Liked own AI tools post |
| Feed comments | ❌ Browser context closed | Attempted self-comment |
| Company follow | ✅ Works (partial) | Followed OpenAI; Anthropic already followed; Microsoft blocked by modal |
| Job search | ✅ Works (parsing issues) | Found 5 results but duplicates, missing fields |
| Job save | ✅ Works | Saved Executive Assistant posting |
| Job alerts | ❌ Selector changed | Alert toggle not found |
| Profile view | ✅ Works | Viewed own + Simon Miller |
| Inbox list | ✅ Works | LinkedIn Team welcome message visible |
| Messaging | ❌ Selector changed | Message button not found |
| Connections | ❌ Selector changed | Connect button not found |
| Notifications | ✅ List works, ❌ actions broken | IDs not stable |
| Search | ❌ Returns empty | All categories (people, posts, companies) |
| Newsletter | ❌ Editor changed | Article editor selectors broken |

## Issues Filed

| # | Type | Title |
|---|------|-------|
| #526 | Bug | Profile section edit dialogs broken — LinkedIn changed from modal to dropdown/page-based editing |
| #527 | Bug | Profile intro editor hangs/times out — edit page route may have changed |
| #528 | Bug | Search returns 0 results for all categories |
| #529 | Bug | Feed post view shows duplicate author_headline text |
| #530 | Bug | Connection invitation fails — Connect button not found |
| #531 | Bug | Company follow blocked by page viewing settings modal |
| #532 | Bug | Newsletter and article editor selectors broken |
| #533 | Bug | Job search results have duplicate entries and missing fields |
| #534 | Bug | Job alert creation fails — alert toggle not found |
| #535 | Bug | Inbox messaging fails — Message button not found |
| #536 | Bug | Notification mark-read fails — IDs not stable |
| #537 | Enhancement | Comprehensive usability QoL findings |

## Key Insight

LinkedIn has made significant UI changes that break ~70% of write operations. The core
two-phase commit infrastructure works perfectly. The failures are consistently at the
Playwright selector level where LinkedIn changed:

1. **Modal dialogs → dropdowns/page routes** (profile editing)
2. **Button positions** (Connect moved to More menu, Message button structure)
3. **Page structure** (article editor, job alert toggle, search results)

## Prepared Profile Spec

A complete profile spec JSON is saved at `docs/joi-ascend-profile-spec.json` and ready
to apply once #526 and #527 are resolved.
