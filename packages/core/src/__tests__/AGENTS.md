# packages/core/src/__tests__ — Test Suite

## Structure

```
__tests__/
  *.test.ts              — Unit tests (65 files, one per core module)
  e2e/                   — E2E tests against real LinkedIn (see e2e/AGENTS.md)
  rateLimiterTestUtils.ts — Rate limiter test helpers
  evasionTestUtils.ts     — Evasion test helpers
  selectorAuditTestUtils.ts — Selector audit test helpers
```

## Test Framework

- **Vitest** — config in root `vitest.config.ts`
- Pattern: `packages/**/src/__tests__/**/*.test.ts` (excludes `*.e2e.test.ts`)
- Path alias: `@linkedin-buddy/core` resolves to `packages/core/src`

## Adding a New Unit Test

1. Create `__tests__/<moduleName>.test.ts`
2. Import from `../moduleName.js` (use `.js` extension — ESM convention)
3. Mock Playwright page/context using Vitest's `vi.fn()` and `vi.mock()`
4. Test service methods: both read-only and prepare/confirm flows
5. For prepare tests: verify PreparedAction structure, token generation, preview content
6. For executor tests: mock page interactions, verify execution result

## Test Utilities

| File | Purpose |
|------|---------|
| `rateLimiterTestUtils.ts` | Creates mock rate limiter state, simulates window transitions |
| `evasionTestUtils.ts` | Creates mock evasion configs, profiles for different levels |
| `selectorAuditTestUtils.ts` | Creates mock selector registries, simulates audit results |

## Conventions

- Test file mirrors source file name: `linkedinFeed.ts` → `linkedinFeed.test.ts`
- Group tests with `describe()` blocks matching method names
- Mock the runtime object — never instantiate real services in unit tests
- Use `vi.useFakeTimers()` for time-dependent tests (rate limiting, token expiry)
- Test error paths: verify `LinkedInBuddyError` codes, not just "throws"
