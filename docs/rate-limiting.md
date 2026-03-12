# Rate limiting

LinkedIn Buddy enforces local rate limits on every write action to stay within
LinkedIn's usage expectations. Limits are checked at confirm time so agents
discover quota issues before the browser automation begins.

## Architecture

Two independent layers enforce cooldowns:

### Action-level rate limiting (`rateLimiter.ts`)

A per-action-type sliding window counter backed by the local SQLite database.
Every write action type (e.g. `feed.like_post`, `connections.send_invitation`)
has its own counter key, window size, and limit. The counter is stored in the
`rate_limit_counter` table.

| Phase   | Method                      | Effect                                                                                             |
| ------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| Prepare | `rateLimiter.peek()`        | Reads remaining quota without consuming. Surfaced as `rate_limit` metadata in the prepare preview. |
| Confirm | `consumeRateLimitOrThrow()` | Increments the counter and throws `RATE_LIMITED` if the limit is exceeded.                         |

Window boundaries are aligned to wall-clock multiples of `windowSizeMs`:

```
windowStartMs = Math.floor(nowMs / windowSizeMs) * windowSizeMs
```

### Session-level rate limiting (`auth/rateLimitState.ts`)

Detects when LinkedIn itself returns rate-limit signals for the account
(HTTP 429, challenge pages). Persists an exponential backoff state to
`~/.linkedin-buddy/rate-limit-state.json`. Backoff escalation:

| Consecutive hits | Cooldown |
| ---------------- | -------- |
| 1                | 2 hours  |
| 2                | 4 hours  |
| 3+               | 8 hours  |

The CLI checks this cooldown before every login and outbound operation.

## Default rate-limit policies

### Feed actions (1-hour windows)

| Action type            | Counter key                     | Limit | Window |
| ---------------------- | ------------------------------- | ----- | ------ |
| `feed.like_post`       | `linkedin.feed.like_post`       | 30    | 1 h    |
| `feed.comment_on_post` | `linkedin.feed.comment_on_post` | 15    | 1 h    |
| `feed.repost_post`     | `linkedin.feed.repost_post`     | 10    | 1 h    |
| `feed.share_post`      | `linkedin.feed.share_post`      | 10    | 1 h    |
| `feed.save_post`       | `linkedin.feed.save_post`       | 40    | 1 h    |
| `feed.unsave_post`     | `linkedin.feed.unsave_post`     | 40    | 1 h    |
| `feed.remove_reaction` | `linkedin.feed.remove_reaction` | 30    | 1 h    |

### Messaging actions (1-hour windows)

| Action type              | Counter key                           | Limit | Window |
| ------------------------ | ------------------------------------- | ----- | ------ |
| `inbox.send_reply`       | `linkedin.messaging.send_message`     | 20    | 1 h    |
| `inbox.send_new_thread`  | `linkedin.messaging.send_message`     | 20    | 1 h    |
| `inbox.add_recipients`   | `linkedin.messaging.add_recipients`   | 20    | 1 h    |
| `inbox.react`            | `linkedin.messaging.react`            | 60    | 1 h    |
| `inbox.archive_thread`   | `linkedin.messaging.archive_thread`   | 60    | 1 h    |
| `inbox.unarchive_thread` | `linkedin.messaging.unarchive_thread` | 60    | 1 h    |
| `inbox.mark_unread`      | `linkedin.messaging.mark_unread`      | 60    | 1 h    |
| `inbox.mute_thread`      | `linkedin.messaging.mute_thread`      | 60    | 1 h    |

### Connection actions (24-hour windows)

| Action type                       | Counter key                                | Limit | Window |
| --------------------------------- | ------------------------------------------ | ----- | ------ |
| `connections.send_invitation`     | `linkedin.connections.send_invitation`     | 20    | 24 h   |
| `connections.accept_invitation`   | `linkedin.connections.accept_invitation`   | 30    | 24 h   |
| `connections.withdraw_invitation` | `linkedin.connections.withdraw_invitation` | 20    | 24 h   |
| `connections.ignore_invitation`   | `linkedin.connections.ignore_invitation`   | 30    | 24 h   |
| `connections.remove_connection`   | `linkedin.connections.remove_connection`   | 20    | 24 h   |
| `connections.follow_member`       | `linkedin.connections.follow_member`       | 30    | 24 h   |
| `connections.unfollow_member`     | `linkedin.connections.unfollow_member`     | 30    | 24 h   |

### Member actions (24-hour windows)

| Action type              | Counter key                       | Limit | Window |
| ------------------------ | --------------------------------- | ----- | ------ |
| `members.block_member`   | `linkedin.members.block_member`   | 10    | 24 h   |
| `members.unblock_member` | `linkedin.members.unblock_member` | 10    | 24 h   |
| `members.report_member`  | `linkedin.members.report_member`  | 10    | 24 h   |

### Job actions (1-hour windows)

| Action type          | Counter key                   | Limit | Window |
| -------------------- | ----------------------------- | ----- | ------ |
| `jobs.save`          | `linkedin.jobs.save`          | 40    | 1 h    |
| `jobs.unsave`        | `linkedin.jobs.unsave`        | 40    | 1 h    |
| `jobs.alerts.create` | `linkedin.jobs.alerts.create` | 30    | 1 h    |
| `jobs.alerts.remove` | `linkedin.jobs.alerts.remove` | 30    | 1 h    |
| `jobs.easy_apply`    | `linkedin.jobs.easy_apply`    | 6     | 1 h    |

### Post actions (24-hour windows)

| Action type                  | Counter key            | Limit | Window |
| ---------------------------- | ---------------------- | ----- | ------ |
| `post.create` (all variants) | `linkedin.post.create` | 1     | 24 h   |
| `post.edit`                  | `linkedin.post.edit`   | 10    | 24 h   |
| `post.delete`                | `linkedin.post.delete` | 10    | 24 h   |

### Publishing actions (24-hour windows)

| Action type                | Counter key                         | Limit | Window |
| -------------------------- | ----------------------------------- | ----- | ------ |
| `article.create`           | `linkedin.article.create`           | 1     | 24 h   |
| `article.publish`          | `linkedin.article.publish`          | 1     | 24 h   |
| `newsletter.create`        | `linkedin.newsletter.create`        | 1     | 24 h   |
| `newsletter.publish_issue` | `linkedin.newsletter.publish_issue` | 1     | 24 h   |

### Other actions (24-hour windows)

Groups, events, privacy settings, and profile actions also have per-action
limits. See the `*_RATE_LIMIT_CONFIG` constants in each executor source file
for exact values.

## Error handling

When a rate limit is exceeded, the confirm call throws a `LinkedInBuddyError`
with code `RATE_LIMITED`:

```json
{
  "code": "RATE_LIMITED",
  "message": "LinkedIn send_invitation confirm is rate limited for the current window. Try again in 23h 45m.",
  "details": {
    "action_id": "pa_abc123",
    "profile_name": "default",
    "rate_limit": {
      "counter_key": "linkedin.connections.send_invitation",
      "window_start_ms": 1710201600000,
      "window_size_ms": 86400000,
      "window_ends_at_ms": 1710288000000,
      "retry_after_ms": 85500000,
      "count": 21,
      "limit": 20,
      "remaining": 0,
      "allowed": false
    }
  }
}
```

Key fields for agents and operators:

- `retry_after_ms` — milliseconds until the current window resets
- `window_ends_at_ms` — absolute timestamp when the window resets
- `remaining` — how many actions are left in the current window (0 when blocked)

The error message includes a human-readable retry hint (e.g. "Try again in
23h 45m") when the window has not yet expired.

## Prepare preview metadata

Every prepare call includes a `rate_limit` block in the returned preview. This
lets agents show the remaining quota before the operator confirms:

```json
{
  "preview": {
    "summary": "Send connection invitation to ...",
    "rate_limit": {
      "counter_key": "linkedin.connections.send_invitation",
      "count": 5,
      "limit": 20,
      "remaining": 15,
      "allowed": true,
      "window_ends_at_ms": 1710288000000,
      "retry_after_ms": 72000000
    }
  }
}
```

## For developers

### Adding rate limits to a new write action

1. Define a `ConsumeRateLimitInput` constant in the executor file:

   ```ts
   const MY_ACTION_RATE_LIMIT_CONFIG = {
     counterKey: "linkedin.my_feature.my_action",
     windowSizeMs: 24 * 60 * 60 * 1000,
     limit: 10,
   } as const;
   ```

2. In the executor's `execute` callback or `beforeExecute` hook, call:

   ```ts
   consumeRateLimitOrThrow(runtime.rateLimiter, {
     config: MY_ACTION_RATE_LIMIT_CONFIG,
     message: createConfirmRateLimitMessage(MY_ACTION_TYPE),
     details: { action_id: action.id, profile_name: profileName },
   });
   ```

3. In the prepare method, include a rate-limit preview:
   ```ts
   rate_limit: peekRateLimitPreview(
     this.runtime.rateLimiter,
     MY_ACTION_RATE_LIMIT_CONFIG,
   );
   ```

### Helper functions (`rateLimiter.ts`)

| Function                          | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `consumeRateLimitOrThrow()`       | Consume quota and throw `RATE_LIMITED` if exceeded             |
| `peekRateLimitPreview()`          | Peek at quota and return formatted state for previews          |
| `createConfirmRateLimitMessage()` | Generate standard error message from action type               |
| `formatRateLimitState()`          | Convert `RateLimiterState` to a snake_case record              |
| `formatRetryAfter()`              | Format milliseconds as human-readable duration (e.g. "1h 30m") |
