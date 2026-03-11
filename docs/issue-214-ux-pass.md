# Issue 214 UX Pass Status

Date: 2026-03-11  
Issue: #214

## Summary

The local persistent `default` profile now resolves to the dedicated Joi Ascend
test account, and the session preflight is more trustworthy than it was on
March 10. The full live CLI + MCP pass is still blocked, however, because the
attached CDP browser at `http://localhost:18800` is not authenticated, so the
live E2E runner cannot exercise the thin CLI/MCP suites yet.

This branch also hardens the operator UX around that blocker:

- `session.status` / `session.health` no longer treat `/in/me/` as a resolved
  public identity
- login redirects are now classified as login walls instead of checkpoint
  false-positives
- the issue-214 MCP helper registry now stays in sync with the exported MCP
  tool constants via a unit test
- the live E2E runner now tells operators to verify the attached browser with
  `linkedin --cdp-url ... status` when CDP auth is missing

## What Was Verified

### Local persistent profile preflight

Command:

```bash
node packages/cli/dist/bin/linkedin.js status --profile default
```

Observed result on March 11, 2026:

- `authenticated: true`
- `currentUrl: https://www.linkedin.com/feed/`
- `identity.profileUrl: https://www.linkedin.com/in/joi-ascend-a534b73b6/`
- `identity.vanityName: joi-ascend-a534b73b6`

This is sufficient to confirm that the local persistent profile now points to
the dedicated issue-214 test account instead of the wrong personal account seen
on March 10.

### Attached CDP browser preflight

Command:

```bash
node packages/cli/dist/bin/linkedin.js --cdp-url http://localhost:18800 status --profile default
```

Observed result on March 11, 2026:

- `authenticated: false`
- `currentUrl: https://www.linkedin.com/uas/login?session_redirect=...`
- `reason: LinkedIn login wall detected.`
- `checkpointDetected: false`
- `loginWallDetected: true`

This confirms the live E2E runner failure is an environment-state problem on
the attached browser session, not a misleading checkpoint classification bug.

### Live CLI + MCP thin suites

Command:

```bash
npm run test:e2e -- --require-session \
  packages/core/src/__tests__/e2e/cli.e2e.test.ts \
  packages/core/src/__tests__/e2e/mcp.e2e.test.ts
```

Observed result:

- the runner stopped before Vitest launched
- prerequisite failure reported the CDP session as unauthenticated
- no live CLI/MCP tool pass was attempted after that guard failed

## Current Result Matrix

| Workflow | Result | Notes |
| --- | --- | --- |
| `session.status` on local persistent profile | improvement | now resolves the Joi Ascend public profile slug instead of reporting vanity `me` |
| `session.health` on local persistent profile | improvement | shares the safer identity resolution path |
| `session.status --cdp-url http://localhost:18800` | fail | attached browser is at LinkedIn login wall, not authenticated |
| `npm run test:e2e -- --require-session ...` | blocked | runner correctly refuses to proceed while the CDP browser is unauthenticated |
| MCP issue-214 helper inventory | improvement | helper registry now covers the full exported MCP tool constant set |

## Safe Next Step

Resume the full live issue-214 CLI + MCP pass only after the browser attached to
`http://localhost:18800` is authenticated as Joi Ascend and the attached-session
preflight confirms it:

```bash
node packages/cli/dist/bin/linkedin.js --cdp-url http://localhost:18800 status --profile default
```

Once that reports the Joi Ascend identity, rerun the thin live suites:

```bash
npm run test:e2e -- --require-session \
  packages/core/src/__tests__/e2e/cli.e2e.test.ts \
  packages/core/src/__tests__/e2e/mcp.e2e.test.ts
```
