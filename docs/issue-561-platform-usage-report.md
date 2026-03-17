# LinkedIn Platform Usage Report — Issue #561

## Session: March 17, 2026

### Account: Joi Ascend (linkedin.com/in/joi-ascend)

---

## Executive Summary

Systematically exercised 35+ LinkedIn Buddy CLI tools against the Joi Ascend test account. Found 9 bugs (filed as GitHub issues) and 1 feature gap. Of ~100 MCP tools available, approximately 40% work correctly, 30% fail due to stale selectors, and 30% were blocked by cascading failures (search broken → can't find targets).

## Profile State

### Filled
- **Name:** Joi Ascend
- **Headline:** executive assistant & ai operations coordinator | streamlining workflows at signikant
- **Location:** Denmark
- **About:** Comprehensive about section (professional summary, focus areas, personality)
- **Industry:** Technology, Information and Internet
- **Vanity URL:** joi-ascend

### Empty (blocked by #563)
- Experience, Education, Certifications, Languages, Projects, Volunteer Experience, Honors & Awards, Skills, Featured section

## Actions Taken

### Posts
- Existing post viewed: "There's something quietly exciting happening in the Copenhagen tech scene..." (urn:li:activity:7439297422322831361) — 16+ impressions
- Existing post viewed: "Something I keep noticing: there's a growing gap between what AI tools can do..." (urn:li:activity:7439296123434926080) — 13+ impressions
- New text post prepared and confirmed (rate limited to 1/day — may have published before page crash)

### Feed Interactions
- Celebrate reaction added to post ✅
- Celebrate reaction removed from post ✅

### Connections
- Connection invitation sent to Simon Miller with personalized note ✅
- 8 pending sent invitations found from prior activity
- 0 accepted connections

### Jobs
- Job search: "executive assistant" — 3 results found
- Job viewed: LEGO Group Executive Assistant (ID: 4382741411)
- Job saved ✅, then unsaved ✅

### Company Pages
- Signikant company page viewed ✅ (employer)
- Microsoft company page viewed ✅
- Google followed ✅ (unfollow verification failed)

### Inbox
- 1 thread found (LinkedIn Team welcome message)
- Thread details and messages loaded ✅
- Recipient search attempted (0 results — no connections to message)

### Notifications
- 5 notifications listed ✅
- 14 notification preference categories loaded ✅

### Privacy
- 3 privacy settings read ✅ (profile_viewing_mode: full_profile)
- Privacy update attempted → failed (radio button intercepted)

### Activity Monitoring
- Activity watch created, listed, paused, resumed, removed ✅ (full lifecycle)
- Webhook subscription created, paused, resumed, removed ✅ (full lifecycle)
- Activity events listed ✅
- Webhook deliveries listed ✅
- Followups list executed ✅

## Issues Filed (9 total)

| # | Type | Title |
|---|------|-------|
| 563 | Bug | Profile section editor dialog selector timeout |
| 564 | Bug | Search returns 0 results for all categories |
| 565 | Bug | Job alert toggle selector broken |
| 566 | Bug | Browser page crash during write confirmations |
| 567 | Bug | Article/newsletter editor selectors broken |
| 568 | Enhancement | Missing tools — create group, create event |
| 569 | Bug | Feed list returns 0 posts |
| 570 | Bug | Privacy setting update — radio button intercepted |
| 571 | Bug | Company unfollow verification fails |

## Tools Not Exercised (with reasons)

| Tool | Reason |
|------|--------|
| Profile photo/banner upload | No image files available; image generation requires OpenAI API key |
| Profile section editing | Dialog selector broken (#563) |
| Skills add/reorder | Depends on profile section editor |
| Featured section | Depends on having posts/content to feature |
| Article creation | Editor selector broken (#567) |
| Newsletter creation | Editor selector broken (#567) |
| Feed comment | Browser page crash (#566) |
| Feed repost/share | Depends on feed list (broken #569) |
| Feed save/unsave | Browser page crash (#566) |
| Groups join/post/leave | Search returns 0 results (#564) |
| Events RSVP | Search returns 0 results (#564) |
| Members block/unblock | Intentionally skipped (safety) |
| Connections follow/unfollow | No connections yet |
| Job alerts | Toggle selector broken (#565) |
| Easy Apply | Would require real job application |
| Inbox new thread | No connections to message |
| Notification dismiss | Browser page crash |
| Post analytics | Depends on feed working |

## Recommendations

1. **Priority: Fix browser page crash (#566)** — This blocks ~30% of write operations
2. **Priority: Fix search selectors (#564)** — This blocks all discovery workflows
3. **Priority: Fix profile editor dialog (#563)** — This blocks profile completion
4. **Fix article/newsletter editor (#567)** — Blocks content publishing
5. **Fix feed list (#569)** — Blocks feed browsing and engagement
6. **Add missing tools (#568)** — Group/event creation
