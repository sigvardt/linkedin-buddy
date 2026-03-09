# `@linkedin-assistant/core`

Core runtime and automation library for LinkedIn Assistant.

## Tier 3 write validation

Tier 3 live write validation is exported from the core package through
`packages/core/src/writeValidation.ts` and `packages/core/src/writeValidationAccounts.ts`.
The main entry points are:

- `runLinkedInWriteValidation()`
- `getWriteValidationActionDefinitions()`
- `loadWriteValidationAccounts()`
- `resolveWriteValidationAccount()`
- `upsertWriteValidationAccount()`

Use the CLI when you need the operator-facing prompt flow. Use the Core API when
you need custom orchestration around the fixed Tier 3 scenario suite.

See `../../docs/write-validation.md` for the complete operator and integration
guide.
