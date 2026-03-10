# Security Audit

Audit completed on 2026-03-10 before publication hardening for issue #247.

## Current HEAD

- `npm run scan:security`: passed
- `gitleaks detect --no-banner --no-git --source .`: passed
- Replaced the previous real-looking profile seed with the synthetic sample at
  `docs/profile-seeds/sample-automation-profile.json`
- Sanitized helper/test references that previously embedded real-looking names,
  org names, or profile slugs outside the approved Simon Miller test target
- Reviewed tracked replay fixtures and confirmed they do not contain committed
  auth headers, stored session blobs, HAR files, or screenshots with operator
  PII

## Reachable Git History

- `git log --all --diff-filter=A --name-only -- '*.env' '*.env.*'`: no results
- `gitleaks detect --no-banner --source .`: passed
- `.gitleaksignore` contains 9 reviewed fingerprints for historical false
  positives from gitleaks' LinkedIn-specific rules on earlier commits; the
  current source tree no longer reproduces those matches
- `git log --all --format='%H%x09%s%x09%b'` with targeted secret/PII regexes:
  no secret-pattern matches
- Large blob review (`git rev-list --objects --all` with a `>= 500000` byte
  threshold): no results

## Unreachable Local Objects

- `git fsck --unreachable --no-reflogs` surfaced unreachable commits in the
  local clone that are not part of any reachable branch or tag
- A gitleaks pipe scan over those unreachable patches produced one false
  positive matching the same reviewed `LinkedInFeedPost` history rule noise
- A targeted regex scan over the same patch stream found maintainer author
  metadata and historical example/test emails, but no secret-token patterns

## Remediation Added

- `.github/workflows/secret-scan.yml` for automated tracked-file and full-history scanning
- `.gitleaksignore` as the reviewed baseline for historical false positives
- `scripts/security-audit.mjs` for current-tree checks in local development and CI
- `.gitignore` additions for env files, repo-local assistant state, reports,
  session exports, and temporary security artifacts

## Credential Rotation

- No live credentials, API keys, or session secrets were found in current HEAD
  or reachable git history
- No credential rotation is currently required from this audit
