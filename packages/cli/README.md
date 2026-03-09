# `@linkedin-assistant/cli`

Operator CLI for LinkedIn Assistant.

## Tier 3 write validation

Use the CLI for the Tier 3 live write-validation harness:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --write-validation --account secondary
```

This workflow performs real LinkedIn writes against approved targets on a
registered secondary account, requires typed confirmation before every action,
uses the core human-like typing simulation for composer-based actions, and
writes JSON plus HTML reports for review.

See `../../docs/write-validation.md` for the full setup guide, account-registry
shape, safety rules, output formats, and examples.
