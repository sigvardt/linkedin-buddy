# Contributing to LinkedIn Buddy

Thanks for considering a contribution. LinkedIn Buddy is a local-first LinkedIn automation toolkit, so good contributions balance developer ergonomics, operator safety, and clear documentation.

## Good First Contributions

- Improve docs, examples, or onboarding.
- Add or tighten unit tests.
- Expand CLI or MCP coverage for existing core services.
- Improve selector resilience, observability, or error messages.
- Tighten type safety, logging, or quality gates.

## Local Setup

```bash
npm install
npx playwright install chromium
npm run build
```

Node.js 22+ is required.

## Daily Workflow

1. Start from a fresh branch.
2. Make focused changes.
3. Run the quality gates.
4. Open a PR with clear context and screenshots or terminal output when useful.

Use conventional commit messages when possible:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `test: ...`
- `chore: ...`

## Quality Gates

Run these before opening or updating a PR:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

If you touch replay fixtures or live validation flows, also read:

- [`docs/e2e-testing.md`](./docs/e2e-testing.md)
- [`docs/write-validation.md`](./docs/write-validation.md)

## LinkedIn Safety Expectations

Read-only changes are the easiest to review and safest to validate.

If you touch outbound LinkedIn actions:

- Follow the existing two-phase commit pattern: prepare first, confirm later.
- Prefer replay fixtures and unit tests before any live validation.
- Use the dedicated test account and approved targets only.
- Never bypass manual confirmation flows without a strong test reason.

## Docs and Product Surface

This repo has three public surfaces that should stay in sync:

- `linkedin` CLI (also available as `linkedin-buddy` and `lbud`)
- `linkedin-mcp`
- `@linkedin-buddy/core`

If you add, rename, or materially change a user-facing command or tool:

- Update [`README.md`](./README.md)
- Update the relevant doc in [`docs/`](./docs/)
- Update package metadata when discoverability changes

## Pull Requests

Helpful PRs usually include:

- A short summary of the problem.
- Why this approach was chosen.
- Testing notes.
- Any follow-up work or known limitations.

Use the PR template in [`.github/pull_request_template.md`](./.github/pull_request_template.md) as a guide.

## Community Standards

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

If you have a security concern, please use the process in [SECURITY.md](./SECURITY.md) instead of opening a public issue.
