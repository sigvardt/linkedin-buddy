# `@linkedin-assistant/cli`

Operator CLI for LinkedIn Assistant.

## Activity webhooks

The CLI owns the poll-based LinkedIn activity daemon, human-readable activity
summaries, and watch / webhook management commands.

Common commands:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin activity watch add --profile default --kind notifications --interval-seconds 600
npm exec -w @linkedin-assistant/cli -- linkedin activity webhook add --watch <watch-id> --url https://example.com/hooks/linkedin
npm exec -w @linkedin-assistant/cli -- linkedin activity run-once --profile default
npm exec -w @linkedin-assistant/cli -- linkedin activity status --profile default
```

Useful reminders:

- interactive terminals default to human-readable output; add `--json` for
  automation
- `run-once` has a `tick` alias
- event history lives under `linkedin activity events`
- delivery history lives under `linkedin activity deliveries`

See `../../docs/activity-webhooks.md` for the full operator guide and
`../../docs/activity-webhooks-architecture.md` for the underlying design.

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
