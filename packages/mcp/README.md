# `@linkedin-assistant/mcp`

MCP stdio server for LinkedIn Assistant.

## Activity polling tools

The MCP server exposes the poll-based LinkedIn activity management and
inspection surfaces, including:

- activity watch create / list / pause / resume / remove
- activity webhook create / list / pause / resume / remove
- activity event history listing
- activity delivery history listing
- one-off polling with `linkedin.activity_poller.run_once`

Daemon lifecycle stays CLI-only. Use the CLI when you need to start, inspect,
or stop the local background activity daemon.

See `../../docs/activity-webhooks.md` for command workflows and
`../../docs/activity-webhooks-architecture.md` for the implementation details.

## Tier 3 write validation boundary

Tier 3 live write validation is intentionally not exposed as an MCP surface.
That workflow requires a visible browser window and typed per-action
confirmations, and it exercises the CLI-side human-like typing diagnostics used
for message and post composition, so it stays CLI-only.

Use the CLI for Tier 3:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --write-validation --account secondary
```

See `../../docs/write-validation.md` for the full Tier 3 guide.
