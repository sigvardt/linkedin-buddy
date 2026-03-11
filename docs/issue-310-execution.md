# Issue 310 execution notes

This branch prepares the live Joi Ascend seeding run and records the current
external blocker encountered during execution.

## Included changes

- added `docs/profile-seeds/issue-310-joi-ascend-profile.json`
- added `docs/profile-seeds/issue-310-joi-ascend-activity.json`
- hardened headless login so the CLI can handle LinkedIn's remembered-account
  login surface before typing credentials

## Live execution attempts

On March 11, 2026, the CLI was exercised against the dedicated Joi Ascend test
account using the required headless login command.

- the saved `default` profile was unauthenticated and landed on LinkedIn's
  remembered-account/login-wall surfaces instead of a stable credential form
- fresh isolated profiles were able to reach the credential form, but LinkedIn
  responded with a `checkpoint/lg/login-submit` CAPTCHA challenge immediately
  after submit

Because the issue requires authenticating as **Joi Ascend** before any live
profile or feed mutations, execution was intentionally stopped at the auth gate
once LinkedIn demanded manual verification.

## Next operator step

Retry the Joi Ascend login once LinkedIn stops presenting the CAPTCHA
checkpoint, then continue with:

1. `node packages/cli/dist/bin/linkedin.js status --profile <profile>` and
   confirm the identity is `Joi Ascend`
2. `node packages/cli/dist/bin/linkedin.js profile editable --profile <profile>`
3. `node packages/cli/dist/bin/linkedin.js profile apply-spec --profile <profile> --spec docs/profile-seeds/issue-310-joi-ascend-profile.json --allow-partial --yes --delay-ms 4000`
4. `node packages/cli/dist/bin/linkedin.js seed activity --profile <profile> --spec docs/profile-seeds/issue-310-joi-ascend-activity.json --delay-ms 4500 --yes`

If live feed likes or comments should be included inside the seed run, enrich
`feed.likes` and `feed.comments` with operator-curated live targets first.
