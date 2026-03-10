# MCP feature completeness audit

Date: 2026-03-10  
Parent issue: #213  
Epic: #209

## Scope

This audit compares the current LinkedIn web feature surface against the MCP
server surface implemented in `packages/mcp/src/index.ts` and
`packages/mcp/src/bin/linkedin-buddy-mcp.ts`.

The goal is not to restate every LinkedIn UI affordance. Instead, it groups the
missing MCP coverage into implementation-sized tracker issues so future work can
land in focused slices.

## Current MCP surface

| Domain | MCP tools | Coverage summary |
| --- | --- | --- |
| Session | `linkedin.session.status`, `linkedin.session.open_login`, `linkedin.session.health` | Session/auth health only |
| Profile | `linkedin.profile.view`, `linkedin.profile.view_editable`, `linkedin.profile.prepare_update_intro`, `linkedin.profile.prepare_upsert_section_item`, `linkedin.profile.prepare_remove_section_item`, `linkedin.profile.prepare_upload_photo`, `linkedin.profile.prepare_upload_banner`, `linkedin.profile.prepare_featured_add`, `linkedin.profile.prepare_featured_remove`, `linkedin.profile.prepare_featured_reorder`, `linkedin.actions.confirm` | Read/write profile inspection plus intro, structured section editing, profile media uploads, and featured-section management |
| Search | `linkedin.search` | Read-only search for `people`, `companies`, and `jobs` only |
| Inbox | `linkedin.inbox.list_threads`, `linkedin.inbox.get_thread`, `linkedin.inbox.prepare_reply`, `linkedin.actions.confirm` | Read existing threads and send replies through two-phase confirm |
| Connections | `linkedin.connections.list`, `linkedin.connections.pending`, `linkedin.connections.invite`, `linkedin.connections.accept`, `linkedin.connections.withdraw`, `linkedin.connections.prepare_ignore`, `linkedin.connections.prepare_remove`, `linkedin.connections.prepare_follow`, `linkedin.connections.prepare_unfollow`, `linkedin.network.prepare_followup_after_accept`, `linkedin.actions.confirm` | Basic network reads plus invite/accept/withdraw/ignore/remove/follow/unfollow and follow-up preparation |
| Feed | `linkedin.feed.list`, `linkedin.feed.view_post`, `linkedin.feed.like`, `linkedin.feed.comment`, `linkedin.actions.confirm` | Read feed/posts plus reactions and comments |
| Posts | `linkedin.post.prepare_create`, `linkedin.post.prepare_create_media`, `linkedin.post.prepare_create_poll`, `linkedin.post.prepare_edit`, `linkedin.post.prepare_delete`, `linkedin.actions.confirm` | Text post creation plus media, polls, edit, and delete lifecycle |
| Notifications | `linkedin.notifications.list` | Read-only notifications |
| Jobs | `linkedin.jobs.search`, `linkedin.jobs.view` | Read-only job discovery |
| Activity webhooks | `linkedin.activity_watch.*`, `linkedin.activity_webhook.*`, `linkedin.activity_events.list`, `linkedin.activity_deliveries.list`, `linkedin.activity_poller.run_once` | Local activity polling, subscriptions, and delivery inspection |

## Important partial-coverage notes

- Several MCP tool names look like immediate writes, but they actually return a
  prepared action that still requires `linkedin.actions.confirm`: this applies
  to `linkedin.connections.invite`, `linkedin.connections.accept`,
  `linkedin.connections.withdraw`, `linkedin.feed.like`, and
  `linkedin.feed.comment`.
- Profile editing now covers intro updates plus editable about / experience /
  education / certifications / languages / projects / volunteer / honors
  section CRUD, profile photo/banner uploads, and featured add/remove/reorder
  through two-phase prepare/confirm. There is still no MCP support for skills,
  endorsements, or recommendations.
- `linkedin.inbox.prepare_reply` only works for existing threads. There is no
  new-thread compose flow, no inbox reactions, and no triage actions.
- LinkedIn posts now cover text, media attachments, polls, and owned-post
  edit/delete lifecycle through prepare/confirm. Articles and newsletters still
  remain outside the MCP surface.
- `linkedin.search` only covers `people`, `companies`, and `jobs`. It does not
  cover broader discovery categories such as posts/content, groups, or events.
- `linkedin.notifications.list` and `linkedin.jobs.search` /
  `linkedin.jobs.view` are read-only surfaces with no corresponding action
  tools.

## Gap issues opened from this audit

| Issue | Priority | Missing feature cluster | Suggested MCP surface |
| --- | --- | --- | --- |
| #228 | Medium | Skills, endorsements, and recommendations | `linkedin.profile.prepare_add_skill`, `linkedin.profile.prepare_endorse_skill`, `linkedin.profile.prepare_request_recommendation` |
| #229 | High | Starting new LinkedIn message threads | `linkedin.inbox.search_recipients`, `linkedin.inbox.prepare_new_thread` |
| #230 | Medium | Inbox reactions and thread triage actions | `linkedin.inbox.prepare_react`, `linkedin.inbox.archive_thread`, `linkedin.inbox.mark_unread`, `linkedin.inbox.mute_thread` |
| #232 | Medium | Privacy and member-safety controls | `linkedin.members.prepare_block`, `linkedin.members.prepare_report`, `linkedin.privacy.get_settings`, `linkedin.privacy.prepare_update_setting` |
| #233 | High | Repost/share/save feed interactions | `linkedin.feed.prepare_repost`, `linkedin.feed.prepare_share`, `linkedin.feed.save_post`, `linkedin.feed.prepare_remove_reaction` |
| #235 | Medium | LinkedIn articles and newsletters | `linkedin.article.prepare_create`, `linkedin.article.prepare_publish`, `linkedin.newsletter.prepare_publish_issue` |
| #236 | Medium | Company pages and expanded discovery search | `linkedin.company.view`, `linkedin.company.prepare_follow`, expanded `linkedin.search` categories |
| #237 | Medium | Groups and events | `linkedin.groups.*`, `linkedin.events.*` |
| #238 | High | Job saves, alerts, and applications | `linkedin.jobs.save`, `linkedin.jobs.alerts.*`, `linkedin.jobs.prepare_easy_apply` |
| #239 | Medium | Analytics and insights surfaces | `linkedin.analytics.profile_views`, `linkedin.analytics.search_appearances`, `linkedin.analytics.post_metrics` |
| #240 | Low | Notification actions and preferences | `linkedin.notifications.mark_read`, `linkedin.notifications.dismiss`, `linkedin.notifications.preferences.*` |

## Notes on ambiguous or moving UI surfaces

- Topic or hashtag following was folded into #236 rather than given a dedicated
  issue. The public member UI around hashtag follow appears less prominent than
  it used to be, so implementation should first confirm the exact current UX on
  desktop web before exposing a dedicated MCP tool family.
- Some feature families could be split further once implementation starts. This
  audit intentionally groups them into slices that feel small enough to ship but
  large enough to avoid tracker spam.

## Reference points used during the audit

Local code:

- `packages/mcp/src/index.ts`
- `packages/mcp/src/bin/linkedin-buddy-mcp.ts`
- `packages/core/src/linkedinProfile.ts`
- `packages/core/src/linkedinInbox.ts`
- `packages/core/src/linkedinConnections.ts`
- `packages/core/src/linkedinFeed.ts`
- `packages/core/src/linkedinPosts.ts`
- `packages/core/src/linkedinSearch.ts`
- `packages/core/src/linkedinJobs.ts`
- `packages/core/src/linkedinNotifications.ts`

Official LinkedIn references consulted while verifying feature clusters:

- https://www.linkedin.com/help/linkedin/answer/a541697
- https://www.linkedin.com/help/linkedin/answer/a541709
- https://www.linkedin.com/help/linkedin/answer/a566336
- https://www.linkedin.com/help/linkedin/answer/a552201
- https://www.linkedin.com/help/linkedin/answer/a571735
- https://www.linkedin.com/help/linkedin/answer/67376
- https://www.linkedin.com/help/linkedin/answer/a573460
- https://www.linkedin.com/help/linkedin/answer/a599445
- https://members.linkedin.com/content/dam/me/business/en-us/amp/marketing-solutions/resources/pdfs/Articles-and-Newsletters-for-Creators.pdf
- https://www.linkedin.com/help/linkedin/answer/a709158
- https://www.linkedin.com/help/linkedin/answer/a546966
- https://www.linkedin.com/help/linkedin/answer/a557720
- https://www.linkedin.com/help/linkedin/answer/a567226
