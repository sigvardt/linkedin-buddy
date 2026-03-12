# Analytics and insights

LinkedIn Buddy exposes four read-only analytics surfaces through the MCP server and the TypeScript API. These surfaces normalize metric data from LinkedIn's profile analytics pages and individual post engagement counters.

| Surface            | MCP tool                                | Description                                        |
| ------------------ | --------------------------------------- | -------------------------------------------------- |
| Profile views      | `linkedin.analytics.profile_views`      | Who viewed your profile — counts, trend, and delta |
| Search appearances | `linkedin.analytics.search_appearances` | How often you appeared in LinkedIn search          |
| Content metrics    | `linkedin.analytics.content_metrics`    | Impressions, engagement, and creator analytics     |
| Post metrics       | `linkedin.analytics.post_metrics`       | Reactions, comments, reposts for a single post     |

## MCP usage

The analytics tools allow you to retrieve snapshots of your performance data. The `profile_views`, `search_appearances`, and `content_metrics` tools all accept an optional `profileName` parameter (defaults to "default"). The `post_metrics` tool requires a `postUrl`.

Example MCP call for profile views:

```json
{
  "name": "linkedin.analytics.profile_views",
  "arguments": {
    "profileName": "default"
  }
}
```

Example MCP call for post metrics:

```json
{
  "name": "linkedin.analytics.post_metrics",
  "arguments": {
    "postUrl": "https://www.linkedin.com/feed/update/urn:li:activity:1234567890/"
  }
}
```

## TypeScript API

You can access analytics services directly through the core runtime.

```ts
import { createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime();

try {
  const views = await runtime.analytics.getProfileViews({
    profileName: "default",
  });
  console.log(views.metrics);
} finally {
  runtime.close();
}
```

## Return shape

The analytics services return structured summaries containing normalized metrics and the original UI cards they were extracted from.

### LinkedInAnalyticsSummary

- `surface`: The analytics surface name
- `source_url`: The LinkedIn URL where the data was found
- `observed_at`: ISO timestamp of the observation
- `metrics[]`: Array of normalized metrics
- `cards[]`: Array of source UI cards

### LinkedInPostMetricsSummary

Includes all fields from `LinkedInAnalyticsSummary` plus a `post` object:

- `post_id`: Unique identifier for the post
- `post_url`: Canonical URL of the post
- `author_name`: Name of the post author
- `author_headline`: Headline of the post author
- `posted_at`: When the post was published
- `text`: The text content of the post

### LinkedInAnalyticsMetric

- `metric_key`: Stable identifier for the metric (e.g., `profile_views`)
- `label`: The display label from the UI
- `value`: Numeric value if parsable, otherwise null
- `value_text`: Raw text value from the UI
- `delta_value`: Numeric change value if available
- `delta_text`: Raw change text (e.g., "+12% past 7 days")
- `unit`: `count`, `percent`, or `unknown`
- `trend`: `up`, `down`, `flat`, or `unknown`
- `observed_at`: ISO timestamp

### LinkedInAnalyticsCard

- `card_key`: Stable identifier for the card
- `title`: Card title
- `description`: Card description or subtitle
- `href`: Link to the detailed analytics page
- `metrics[]`: Metrics contained within this specific card

## Limits

The `content_metrics` surface accepts an optional `limit` parameter (1–50, default 4) to cap the number of returned cards. This is useful for focusing on the most prominent creator analytics cards.

## Error handling

Analytics tools throw `LinkedInBuddyError` in specific failure scenarios:

- `UI_CHANGED_SELECTOR_FAILED`: Thrown when LinkedIn's UI has changed and the expected analytics cards cannot be located.
- `UNKNOWN`: Thrown for unexpected browser or network failures.

Both error types include the `surface` and `profileName` in their error details to help with debugging.
