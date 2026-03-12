# Articles & Newsletters

LinkedIn Buddy supports creating and publishing long-form LinkedIn articles and newsletters through the CLI, MCP server, and TypeScript API.

## Overview

| Action                   | CLI                                | MCP Tool                                    | Two-Phase |
| ------------------------ | ---------------------------------- | ------------------------------------------- | --------- |
| Create article draft     | `article prepare-create`           | `linkedin.article.prepare_create`           | Yes       |
| Publish article          | `article prepare-publish`          | `linkedin.article.prepare_publish`          | Yes       |
| Create newsletter        | `newsletter prepare-create`        | `linkedin.newsletter.prepare_create`        | Yes       |
| Publish newsletter issue | `newsletter prepare-publish-issue` | `linkedin.newsletter.prepare_publish_issue` | Yes       |
| List newsletters         | `newsletter list`                  | `linkedin.newsletter.list`                  | No        |

All write operations follow the two-phase commit pattern: **prepare** returns a confirm token, then **confirm** executes the action. This prevents accidental publishing and gives the operator full review capability.

## CLI Usage

### Articles

#### Create a draft article

```bash
npm exec -w @linkedin-buddy/cli -- linkedin article prepare-create \
  --title "Building Reliable Browser Automation" \
  --body "Browser automation is tricky. Here is what I learned..."
```

Returns a prepared action with a `confirmToken`. Use `linkedin actions confirm --token ct_...` to create the draft in the LinkedIn publishing editor.

#### Publish an existing article draft

```bash
npm exec -w @linkedin-buddy/cli -- linkedin article prepare-publish \
  --draft-url "https://www.linkedin.com/pulse/edit/123456/"
```

### Newsletters

#### List your newsletters

```bash
npm exec -w @linkedin-buddy/cli -- linkedin newsletter list
```

Returns a list of newsletter series available in your LinkedIn publishing editor, including which one is currently selected.

#### Create a new newsletter series

```bash
npm exec -w @linkedin-buddy/cli -- linkedin newsletter prepare-create \
  --title "Builder Brief" \
  --description "Weekly notes on building developer tools" \
  --cadence weekly
```

Supported cadence values: `daily`, `weekly`, `biweekly`, `monthly`.

#### Publish a newsletter issue

```bash
npm exec -w @linkedin-buddy/cli -- linkedin newsletter prepare-publish-issue \
  --newsletter "Builder Brief" \
  --title "March Update: What We Shipped" \
  --body "This month we focused on reliability improvements..."
```

### Common options

All commands support:

- `-p, --profile <profile>` — LinkedIn profile name (default: `default`)
- `-o, --operator-note <note>` — Optional note attached to the prepared action
- `--cdp-url <url>` — Connect to an existing Chrome DevTools Protocol session

## MCP Usage

### linkedin.article.prepare_create

Prepare a new LinkedIn long-form article draft.

**Parameters:**

| Name           | Type   | Required | Description                                                            |
| -------------- | ------ | -------- | ---------------------------------------------------------------------- |
| `title`        | string | Yes      | Article headline (max 150 characters)                                  |
| `body`         | string | Yes      | Plain-text article body with paragraph breaks (max 125,000 characters) |
| `profileName`  | string | No       | Profile name (default: `default`)                                      |
| `operatorNote` | string | No       | Optional operator note                                                 |

### linkedin.article.prepare_publish

Prepare to publish an existing LinkedIn article draft.

**Parameters:**

| Name           | Type   | Required | Description                                   |
| -------------- | ------ | -------- | --------------------------------------------- |
| `draftUrl`     | string | Yes      | Absolute LinkedIn article editor or draft URL |
| `profileName`  | string | No       | Profile name                                  |
| `operatorNote` | string | No       | Optional operator note                        |

### linkedin.newsletter.prepare_create

Prepare a new LinkedIn newsletter series.

**Parameters:**

| Name           | Type   | Required | Description                                                     |
| -------------- | ------ | -------- | --------------------------------------------------------------- |
| `title`        | string | Yes      | Newsletter title (max 64 characters)                            |
| `description`  | string | Yes      | Short newsletter description (max 300 characters)               |
| `cadence`      | string | Yes      | Publishing cadence: `daily`, `weekly`, `biweekly`, or `monthly` |
| `profileName`  | string | No       | Profile name                                                    |
| `operatorNote` | string | No       | Optional operator note                                          |

### linkedin.newsletter.prepare_publish_issue

Prepare a new LinkedIn newsletter issue.

**Parameters:**

| Name           | Type   | Required | Description                                                          |
| -------------- | ------ | -------- | -------------------------------------------------------------------- |
| `newsletter`   | string | Yes      | Newsletter title as returned by `linkedin.newsletter.list`           |
| `title`        | string | Yes      | Issue title (max 150 characters)                                     |
| `body`         | string | Yes      | Plain-text issue body with paragraph breaks (max 125,000 characters) |
| `profileName`  | string | No       | Profile name                                                         |
| `operatorNote` | string | No       | Optional operator note                                               |

### linkedin.newsletter.list

List newsletter series currently available in the LinkedIn publishing editor.

**Parameters:**

| Name          | Type   | Required | Description  |
| ------------- | ------ | -------- | ------------ |
| `profileName` | string | No       | Profile name |

**Returns:** `{ count, newsletters: [{ title, selected }] }`

## Rate Limits

Each publishing action is rate limited to **1 per 24 hours**:

| Action                   | Counter Key                         | Limit |
| ------------------------ | ----------------------------------- | ----- |
| Create article           | `linkedin.article.create`           | 1/day |
| Publish article          | `linkedin.article.publish`          | 1/day |
| Create newsletter        | `linkedin.newsletter.create`        | 1/day |
| Publish newsletter issue | `linkedin.newsletter.publish_issue` | 1/day |

Rate limits are enforced at confirm time (not prepare time). The prepare response includes a `rate_limit` preview showing current usage.

## Input Validation

All inputs are validated before authentication or browser automation:

- **Titles**: Must be non-empty, single-line, no control characters, no raw URLs
- **Bodies**: Must be non-empty, control characters rejected, line endings normalized
- **Cadence**: Must be one of the supported values (case-insensitive, aliases accepted)
- **Draft URLs**: Must be valid absolute URLs pointing to `linkedin.com`

### Length Limits

| Field                  | Max Length         |
| ---------------------- | ------------------ |
| Article title          | 150 characters     |
| Article body           | 125,000 characters |
| Newsletter title       | 64 characters      |
| Newsletter description | 300 characters     |
| Newsletter issue title | 150 characters     |
| Newsletter issue body  | 125,000 characters |

## TypeScript API

```typescript
import { createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime();

try {
  // List newsletters
  const newsletters = await runtime.newsletters.list({
    profileName: "default",
  });
  console.log(newsletters);

  // Prepare an article draft
  const prepared = await runtime.articles.prepareCreate({
    profileName: "default",
    title: "My Article",
    body: "Article content here...",
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

| Code                         | When                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `ACTION_PRECONDITION_FAILED` | Invalid input (empty title, bad URL, unsupported cadence, exceeds length limit) |
| `RATE_LIMITED`               | Daily rate limit exceeded for the action type                                   |
| `AUTH_REQUIRED`              | LinkedIn session not authenticated                                              |
| `UI_CHANGED_SELECTOR_FAILED` | LinkedIn UI changed and selectors no longer match                               |
| `TIMEOUT`                    | Browser automation timed out                                                    |
| `NETWORK_ERROR`              | Network connectivity issue during automation                                    |

## Artifacts

Every publishing operation captures:

- **Screenshots**: Before and after screenshots of the LinkedIn editor
- **Traces**: Playwright browser traces (`.zip`) for debugging
- **Error screenshots**: Captured on failure for diagnostic purposes

Artifacts are stored under `~/.linkedin-buddy/linkedin-buddy/runs/<run-id>/`.

## E2E Verification

Read-only operations (`newsletter list`) can be verified against any authenticated profile. Write operations (article create/publish, newsletter create/publish-issue) require manual E2E testing against an approved test account per the [E2E testing safety rules](./e2e-testing.md).
