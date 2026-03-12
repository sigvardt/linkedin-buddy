# Notifications

LinkedIn Buddy supports listing, reading, dismissing, and managing preferences for LinkedIn notifications through the CLI, MCP server, and TypeScript API.

## Overview

| Action                    | CLI                                        | MCP Tool                                            | Two-Phase |
| ------------------------- | ------------------------------------------ | --------------------------------------------------- | --------- |
| List notifications        | `notifications list`                       | `linkedin.notifications.list`                       | No        |
| Mark notification as read | `notifications mark-read`                  | `linkedin.notifications.mark_read`                  | No        |
| Dismiss notification      | `notifications dismiss`                    | `linkedin.notifications.dismiss`                    | Yes       |
| View preferences          | `notifications preferences get`            | `linkedin.notifications.preferences.get`            | No        |
| Update preference         | `notifications preferences prepare-update` | `linkedin.notifications.preferences.prepare_update` | Yes       |

Dismiss and preference update operations follow the two-phase commit pattern: **prepare** returns a confirm token, then **confirm** executes the action. Read-only operations (list, mark-read, view preferences) execute immediately.

## CLI Usage

### List notifications

```bash
npm exec -w @linkedin-buddy/cli -- linkedin notifications list --limit 10
```

Returns an array of notifications with type, message, timestamp, link, and read/unread status.

### Mark a notification as read

```bash
npm exec -w @linkedin-buddy/cli -- linkedin notifications mark-read <notificationId>
```

Opens the notification on LinkedIn to mark it as read. The `notificationId` comes from the list output.

### Dismiss a notification

```bash
npm exec -w @linkedin-buddy/cli -- linkedin notifications dismiss <notificationId>
```

Returns a prepared action with a `confirmToken`. Use `linkedin actions confirm --token ct_...` to permanently remove the notification.

### View notification preferences

```bash
npm exec -w @linkedin-buddy/cli -- linkedin notifications preferences get
npm exec -w @linkedin-buddy/cli -- linkedin notifications preferences get \
  --preference-url "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting"
```

Without `--preference-url`, returns the top-level overview with all preference categories. With a URL, returns the category or subcategory detail page including current toggle states.

### Update a notification preference

```bash
npm exec -w @linkedin-buddy/cli -- linkedin notifications preferences prepare-update \
  --preference-url "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting" \
  --enabled false
```

For subcategory pages, specify the channel:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin notifications preferences prepare-update \
  --preference-url "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions" \
  --enabled false \
  --channel in_app
```

### Common options

All commands support:

- `-p, --profile <profile>` — LinkedIn profile name (default: `default`)
- `-o, --operator-note <note>` — Optional note attached to prepared actions
- `--cdp-url <url>` — Connect to an existing Chrome DevTools Protocol session

## MCP Usage

### linkedin.notifications.list

List your LinkedIn notifications.

**Parameters:**

| Name          | Type   | Required | Description                                             |
| ------------- | ------ | -------- | ------------------------------------------------------- |
| `profileName` | string | No       | Profile name (default: `default`)                       |
| `limit`       | number | No       | Maximum notifications to return (default: 20, max: 100) |

**Returns:** `{ count, notifications: [{ id, type, message, timestamp, link, is_read }] }`

### linkedin.notifications.mark_read

Mark one LinkedIn notification as read by notification ID.

**Parameters:**

| Name             | Type   | Required | Description                                      |
| ---------------- | ------ | -------- | ------------------------------------------------ |
| `notificationId` | string | Yes      | Notification ID returned by `notifications.list` |
| `profileName`    | string | No       | Profile name                                     |

**Returns:** `{ marked_read, was_already_read, notification_id, link, selector_key }`

### linkedin.notifications.dismiss

Prepare a dismiss action for one LinkedIn notification (two-phase).

**Parameters:**

| Name             | Type   | Required | Description                                      |
| ---------------- | ------ | -------- | ------------------------------------------------ |
| `notificationId` | string | Yes      | Notification ID returned by `notifications.list` |
| `profileName`    | string | No       | Profile name                                     |
| `operatorNote`   | string | No       | Optional operator note                           |

**Returns:** `{ preparedActionId, confirmToken, expiresAtMs, preview }`

### linkedin.notifications.preferences.get

Read LinkedIn notification preference categories or a specific preference page.

**Parameters:**

| Name            | Type   | Required | Description                                                     |
| --------------- | ------ | -------- | --------------------------------------------------------------- |
| `preferenceUrl` | string | No       | Preference page URL. Omit for the overview with all categories. |
| `profileName`   | string | No       | Profile name                                                    |

**Returns:** One of three view types:

- **overview** — `{ view_type: "overview", categories: [{ title, slug, preference_url }] }`
- **category** — `{ view_type: "category", title, master_toggle, subcategories: [...] }`
- **subcategory** — `{ view_type: "subcategory", title, channels: [{ label, enabled, channel_key }] }`

### linkedin.notifications.preferences.prepare_update

Prepare a LinkedIn notification preference update (two-phase).

**Parameters:**

| Name            | Type    | Required | Description                                                     |
| --------------- | ------- | -------- | --------------------------------------------------------------- |
| `preferenceUrl` | string  | Yes      | Category or subcategory URL from `preferences.get`              |
| `enabled`       | boolean | Yes      | Whether the selected preference should be enabled               |
| `channel`       | string  | No       | Channel key for subcategory pages: `in_app`, `push`, or `email` |
| `profileName`   | string  | No       | Profile name                                                    |
| `operatorNote`  | string  | No       | Optional operator note                                          |

**Returns:** `{ preparedActionId, confirmToken, expiresAtMs, preview }`

## Limits

| Parameter  | Default | Maximum |
| ---------- | ------- | ------- |
| List limit | 20      | 100     |
| Scan limit | 50      | 200     |

The list limit controls how many notifications are returned. The scan limit controls how many cards are searched when locating a specific notification by ID.

## TypeScript API

```typescript
import { createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime();

try {
  // List notifications
  const notifications = await runtime.notifications.listNotifications({
    profileName: "default",
    limit: 10,
  });
  console.log(notifications);

  // Mark as read
  const readResult = await runtime.notifications.markRead({
    profileName: "default",
    notificationId: notifications[0].id,
  });
  console.log(readResult);

  // View preference overview
  const overview = await runtime.notifications.getPreferences();
  console.log(overview);

  // Prepare a preference update
  const prepared = await runtime.notifications.prepareUpdatePreference({
    profileName: "default",
    preferenceUrl:
      "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting",
    enabled: false,
  });
  console.log(prepared.confirmToken);

  // Confirm the action
  const result = await runtime.twoPhaseCommit.confirmByToken({
    confirmToken: prepared.confirmToken,
  });
  console.log(result);
} finally {
  runtime.close();
}
```

## Error Codes

| Code                         | When                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `ACTION_PRECONDITION_FAILED` | Invalid input (empty ID, overview page for update, channel required, already at target state) |
| `TARGET_NOT_FOUND`           | Notification or preference switch not found on the page                                       |
| `AUTH_REQUIRED`              | LinkedIn session not authenticated                                                            |
| `UI_CHANGED_SELECTOR_FAILED` | LinkedIn UI changed and selectors no longer match                                             |
| `TIMEOUT`                    | Browser automation timed out                                                                  |
| `NETWORK_ERROR`              | Network connectivity issue during automation                                                  |

## Artifacts

Dismiss and preference update operations capture:

- **Screenshots**: Before and after screenshots of the LinkedIn notification page
- **Traces**: Playwright browser traces (`.zip`) for debugging
- **Error screenshots**: Captured on failure for diagnostic purposes

Artifacts are stored under `~/.linkedin-buddy/linkedin-buddy/runs/<run-id>/`.

## E2E Verification

Read-only operations (list, mark-read, preferences get) can be verified against any authenticated profile. Write operations (dismiss, preference update) require manual E2E testing against an approved test account per the [E2E testing safety rules](./e2e-testing.md).
