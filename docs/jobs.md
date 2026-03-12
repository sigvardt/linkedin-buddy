# Jobs

LinkedIn Buddy supports searching, saving, and managing job alerts, as well as preparing Easy Apply submissions through the CLI, MCP server, and TypeScript API.

## Overview

| Action           | CLI                  | MCP Tool                           | Two-Phase |
| ---------------- | -------------------- | ---------------------------------- | --------- |
| Search jobs      | `jobs search`        | `linkedin.jobs.search`             | No        |
| View job details | `jobs view`          | `linkedin.jobs.view`               | No        |
| Save job         | `jobs save`          | `linkedin.jobs.save`               | Yes       |
| Unsave job       | `jobs unsave`        | `linkedin.jobs.unsave`             | Yes       |
| List job alerts  | `jobs alerts list`   | `linkedin.jobs.alerts.list`        | No        |
| Create job alert | `jobs alerts create` | `linkedin.jobs.alerts.create`      | Yes       |
| Remove job alert | `jobs alerts remove` | `linkedin.jobs.alerts.remove`      | Yes       |
| Easy Apply       | `jobs easy-apply`    | `linkedin.jobs.prepare_easy_apply` | Yes       |

All write operations follow the two-phase commit pattern: **prepare** returns a confirm token, then **confirm** executes the action.

## CLI Usage

### Search jobs

```bash
npm exec -w @linkedin-buddy/cli -- linkedin jobs search "product manager" \
  --location Copenhagen --limit 10
```

Returns structured results with `job_id`, `title`, `company`, `location`, `posted_at`, `salary_range`, and `employment_type`.

### View job details

```bash
npm exec -w @linkedin-buddy/cli -- linkedin jobs view --job-id 1234567890
```

Returns full details including `description`, `company_url`, `seniority_level`, `applicant_count`, and `is_remote`.

### Save and unsave jobs

```bash
npm exec -w @linkedin-buddy/cli -- linkedin jobs save --job-id 1234567890
npm exec -w @linkedin-buddy/cli -- linkedin actions confirm --token ct_...

npm exec -w @linkedin-buddy/cli -- linkedin jobs unsave --job-id 1234567890
npm exec -w @linkedin-buddy/cli -- linkedin actions confirm --token ct_...
```

### Manage job alerts

```bash
npm exec -w @linkedin-buddy/cli -- linkedin jobs alerts list --limit 20
npm exec -w @linkedin-buddy/cli -- linkedin jobs alerts create --query "staff engineer" --location Remote
npm exec -w @linkedin-buddy/cli -- linkedin actions confirm --token ct_...

npm exec -w @linkedin-buddy/cli -- linkedin jobs alerts remove --query "staff engineer"
npm exec -w @linkedin-buddy/cli -- linkedin actions confirm --token ct_...
```

Alerts can also be removed by `--alert-id` (from `alerts list`) or `--search-url`.

### Easy Apply

```bash
npm exec -w @linkedin-buddy/cli -- linkedin jobs easy-apply --job-id 1234567890 \
  --email candidate@example.com \
  --phone "+45 1234 5678" \
  --resume /path/to/resume.pdf \
  --answers-file /path/to/answers.json
npm exec -w @linkedin-buddy/cli -- linkedin actions confirm --token ct_...
```

The answers file is a JSON object keyed by field label:

```json
{
  "Years of experience": 5,
  "Need visa sponsorship": false,
  "Preferred work arrangement": "Remote"
}
```

### Common options

All commands support:

- `-p, --profile <profile>` — LinkedIn profile name (default: `default`)
- `-o, --operator-note <note>` — Optional note attached to prepared actions
- `--cdp-url <url>` — Connect to an existing Chrome DevTools Protocol session

## MCP Usage

### linkedin.jobs.search

Search for LinkedIn job postings by keyword and optional location.

**Parameters:**

| Name          | Type   | Required | Description                         |
| ------------- | ------ | -------- | ----------------------------------- |
| `query`       | string | Yes      | Search keywords (max 400 chars)     |
| `location`    | string | No       | Location filter                     |
| `limit`       | number | No       | Max results (default: 10, max: 100) |
| `profileName` | string | No       | Profile name (default: `default`)   |

**Returns:** `{ results: [{ job_id, title, company, location, posted_at, job_url, salary_range, employment_type }], count }`

### linkedin.jobs.view

View details of a specific LinkedIn job posting.

**Parameters:**

| Name          | Type   | Required | Description  |
| ------------- | ------ | -------- | ------------ |
| `jobId`       | string | Yes      | Job ID       |
| `profileName` | string | No       | Profile name |

**Returns:** `{ job_id, title, company, company_url, location, description, salary_range, employment_type, seniority_level, applicant_count, is_remote }`

### linkedin.jobs.save

Prepare to save a LinkedIn job for later (low risk).

**Parameters:**

| Name           | Type   | Required | Description  |
| -------------- | ------ | -------- | ------------ |
| `jobId`        | string | Yes      | Job ID       |
| `profileName`  | string | No       | Profile name |
| `operatorNote` | string | No       | Audit note   |

### linkedin.jobs.unsave

Prepare to unsave a previously saved LinkedIn job (low risk).

**Parameters:**

| Name           | Type   | Required | Description  |
| -------------- | ------ | -------- | ------------ |
| `jobId`        | string | Yes      | Job ID       |
| `profileName`  | string | No       | Profile name |
| `operatorNote` | string | No       | Audit note   |

### linkedin.jobs.alerts.list

List LinkedIn job alerts for the current account.

**Parameters:**

| Name          | Type   | Required | Description                        |
| ------------- | ------ | -------- | ---------------------------------- |
| `limit`       | number | No       | Max alerts (default: 20, max: 100) |
| `profileName` | string | No       | Profile name                       |

**Returns:** `{ alerts: [{ alert_id, query, location, frequency, search_url, enabled }], count }`

### linkedin.jobs.alerts.create

Prepare to create a LinkedIn job alert from a search query (low risk).

**Parameters:**

| Name           | Type   | Required | Description                     |
| -------------- | ------ | -------- | ------------------------------- |
| `query`        | string | Yes      | Search keywords (max 400 chars) |
| `location`     | string | No       | Location filter                 |
| `profileName`  | string | No       | Profile name                    |
| `operatorNote` | string | No       | Audit note                      |

### linkedin.jobs.alerts.remove

Prepare to remove a LinkedIn job alert (low risk). Provide one of `alertId`, `searchUrl`, or `query`.

**Parameters:**

| Name           | Type   | Required | Description                 |
| -------------- | ------ | -------- | --------------------------- |
| `alertId`      | string | No       | Alert ID from `alerts.list` |
| `searchUrl`    | string | No       | LinkedIn jobs search URL    |
| `query`        | string | No       | Alert query                 |
| `location`     | string | No       | Alert location (with query) |
| `profileName`  | string | No       | Profile name                |
| `operatorNote` | string | No       | Audit note                  |

### linkedin.jobs.prepare_easy_apply

Prepare a LinkedIn Easy Apply submission (high risk). Fills multi-step forms.

**Parameters:**

| Name           | Type   | Required | Description                                                |
| -------------- | ------ | -------- | ---------------------------------------------------------- |
| `jobId`        | string | Yes      | Job ID                                                     |
| `phoneNumber`  | string | No       | Phone (max 30 chars)                                       |
| `email`        | string | No       | Email (max 254 chars)                                      |
| `city`         | string | No       | City (max 200 chars)                                       |
| `resumePath`   | string | No       | Path to resume file                                        |
| `coverLetter`  | string | No       | Cover letter text (max 4,000 chars)                        |
| `answers`      | object | No       | Field answers keyed by label (string/boolean/number/array) |
| `profileName`  | string | No       | Profile name                                               |
| `operatorNote` | string | No       | Audit note                                                 |

## Rate Limits

| Action       | Counter Key                   | Limit   |
| ------------ | ----------------------------- | ------- |
| Save job     | `linkedin.jobs.save`          | 40/hour |
| Unsave job   | `linkedin.jobs.unsave`        | 40/hour |
| Create alert | `linkedin.jobs.alerts.create` | 30/hour |
| Remove alert | `linkedin.jobs.alerts.remove` | 30/hour |
| Easy Apply   | `linkedin.jobs.easy_apply`    | 6/hour  |

Rate limits are enforced at confirm time (not prepare time). The prepare response includes a `rate_limit` preview showing current usage.

## Input Validation

All inputs are validated before authentication or browser automation:

- **Job ID**: Must be non-empty after whitespace trimming
- **Search query**: Must be non-empty, max 400 characters
- **Email**: Must match basic email format, max 254 characters
- **Resume path**: Must point to an existing file (not directory)
- **Easy Apply answers**: Values must be strings, booleans, numbers, or string arrays; nested objects rejected

### Length Limits

| Field        | Max Length       |
| ------------ | ---------------- |
| Search query | 400 characters   |
| Phone number | 30 characters    |
| Email        | 254 characters   |
| City         | 200 characters   |
| Cover letter | 4,000 characters |

### Search and Alert Limits

| Parameter     | Default | Maximum |
| ------------- | ------- | ------- |
| Job search    | 10      | 100     |
| Alert listing | 20      | 100     |

## TypeScript API

```typescript
import { createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime();

try {
  // Search jobs
  const results = await runtime.jobs.searchJobs({
    query: "developer relations",
    location: "Copenhagen",
    limit: 5,
  });
  console.log(results.results.map((job) => job.title));

  // View a specific job
  const job = await runtime.jobs.viewJob({ jobId: "1234567890" });
  console.log(job.description);

  // Save a job (two-phase)
  const saved = runtime.jobs.prepareSaveJob({ jobId: "1234567890" });
  await runtime.twoPhaseCommit.confirmByToken({
    confirmToken: saved.confirmToken,
  });

  // Create a job alert (two-phase)
  const alert = runtime.jobs.prepareCreateJobAlert({
    query: "staff engineer",
    location: "Remote",
  });
  await runtime.twoPhaseCommit.confirmByToken({
    confirmToken: alert.confirmToken,
  });
} finally {
  runtime.close();
}
```

## Error Codes

| Code                         | When                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `ACTION_PRECONDITION_FAILED` | Invalid input (empty query, bad email, exceeds length limit) |
| `RATE_LIMITED`               | Hourly rate limit exceeded for the action type               |
| `AUTH_REQUIRED`              | LinkedIn session not authenticated                           |
| `TARGET_NOT_FOUND`           | Alert ID not found when removing by ID                       |
| `UI_CHANGED_SELECTOR_FAILED` | LinkedIn UI changed and selectors no longer match            |
| `TIMEOUT`                    | Browser automation timed out                                 |
| `NETWORK_ERROR`              | Network connectivity issue during automation                 |

## Artifacts

Every job write operation captures:

- **Screenshots**: After-action screenshots of the LinkedIn job page
- **Traces**: Playwright browser traces (`.zip`) for debugging
- **Error screenshots**: Captured on failure for diagnostic purposes

Artifacts are stored under `~/.linkedin-buddy/linkedin-buddy/runs/<run-id>/`.

## E2E Verification

Read-only operations (`jobs search`, `jobs view`, `jobs alerts list`) can be verified against any authenticated profile. Write operations (save, unsave, alerts, Easy Apply) require manual E2E testing against an approved test account per the [E2E testing safety rules](./e2e-testing.md).
