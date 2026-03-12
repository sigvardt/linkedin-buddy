# Joi Ascend — Profile Seeding Runbook

Manual execution guide for populating the Joi Ascend test account. Run these
commands in order on a machine with a display (headless login is blocked by
LinkedIn CAPTCHA, see #367).

## Prerequisites

- Node 22+
- `npm install && npm run build` completed
- Environment variables set: `LINKEDIN_TEST_EMAIL`, `LINKEDIN_TEST_PASSWORD`

## Step 1: Authenticate (manual browser)

```bash
npm exec -w @linkedin-buddy/cli -- linkedin login --profile default
```

This opens a visible Chromium window. Complete any CAPTCHA manually, then wait
for the CLI to confirm authentication.

Verify:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin status --profile default
```

Expected: `"authenticated": true`. Check `identity.fullName` is **Joi Ascend**.
If identity is anything other than Joi Ascend, **stop all work**.

## Step 2: Inspect current editable surface

```bash
npm exec -w @linkedin-buddy/cli -- linkedin profile editable --profile default
```

Review the output to understand which profile sections are currently populated
and which are empty.

## Step 3: Apply profile spec

```bash
npm exec -w @linkedin-buddy/cli -- linkedin profile apply-spec \
  --spec docs/profile-seeds/joi-ascend-profile.json \
  --allow-partial \
  --yes \
  --delay-ms 4000 \
  --profile default
```

This applies the Joi Ascend persona: intro, about, experience, education,
certifications, languages, projects, and volunteer experience. Skills are
skipped (not exposed by the current profile edit automation).

Verify:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin profile view me --profile default
```

## Step 4: Run activity seeding

```bash
npm exec -w @linkedin-buddy/cli -- linkedin seed activity \
  --spec docs/profile-seeds/joi-ascend-activity.json \
  --delay-ms 4500 \
  --yes \
  --profile default \
  --output reports/activity-seed-joi-ascend.json
```

This publishes 5 professional posts (connections visibility), runs job
discovery searches, and checks notifications. No connection invites or targeted
engagement.

## Step 5: Final verification

```bash
npm exec -w @linkedin-buddy/cli -- linkedin profile view me --profile default
npm exec -w @linkedin-buddy/cli -- linkedin feed list --limit 5 --profile default
```

Confirm:

- Profile is populated with Joi Ascend professional identity
- Experience at Signikant is visible
- Posts are visible in the feed

## Troubleshooting

| Symptom                               | Fix                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `authenticated: false` after login    | Re-run `linkedin login`, complete CAPTCHA                                    |
| `identity.fullName` is not Joi Ascend | Wrong account. Clear cookies: `linkedin logout`, re-login with correct creds |
| `RATE_LIMITED` error                  | Run `linkedin rate-limit --clear`, wait 30 minutes, retry                    |
| Profile edit fails on a section       | Add `--allow-partial` to skip unsupported fields                             |
| Activity seed hangs                   | Check `~/.linkedin-buddy/keep-alive.log` for session expiry                  |

## References

- Profile spec: `docs/profile-seeds/joi-ascend-profile.json`
- Activity spec: `docs/profile-seeds/joi-ascend-activity.json`
- Login fix: commit `6e6e8f4` (selector + cookie consent + returning-user)
- CAPTCHA blocker: #367
- SDUI selector fix: #366
