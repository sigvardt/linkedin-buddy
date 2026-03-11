# Security Policy

LinkedIn Buddy is a local-first automation toolkit that interacts with real LinkedIn sessions. Security reports are welcome and taken seriously.

## Supported Versions

This project is still pre-1.0. Security fixes land on `main` first.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest tagged release | Best effort |
| Older commits and branches | No |

## Reporting a Vulnerability

Please report vulnerabilities privately through GitHub's private advisory flow:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Include enough detail for reproduction and impact assessment.

If GitHub private reporting is unavailable for any reason, contact the maintainer through GitHub at https://github.com/sigvardt and request a private follow-up channel.

Please do **not** open a public issue for security vulnerabilities.

## What to Include

Helpful reports usually include:

- A short summary of the issue and why it matters.
- Affected files, commands, or workflows.
- Reproduction steps or a minimal proof of concept.
- Any environment details needed to reproduce.
- Suggested mitigations if you have them.

## Response Expectations

- Initial acknowledgment target: within 48 hours.
- Triage target: within 5 business days.
- Fix timeline: depends on severity and release risk, but critical issues are prioritized immediately.

## Safe Research Expectations

When investigating this project, please avoid:

- Running destructive actions against real LinkedIn accounts.
- Accessing data that does not belong to you.
- Triggering writes against public LinkedIn targets without explicit approval.

Prefer replay fixtures, local test data, and the dedicated test account described in the contributor and test docs.

## Disclosure

Please allow time for a fix before any public disclosure. Once a fix is available, we will coordinate a responsible disclosure note in the changelog or release materials when appropriate.
