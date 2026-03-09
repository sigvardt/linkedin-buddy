# `@linkedin-assistant/mcp`

MCP stdio server for LinkedIn Assistant.

## Tier 3 write validation boundary

Tier 3 live write validation is intentionally not exposed as an MCP surface.
That workflow requires a visible browser window and typed per-action
confirmations, so it stays CLI-only.

Use the CLI for Tier 3:

```bash
npm exec -w @linkedin-assistant/cli -- linkedin test live --write-validation --account secondary
```

See `../../docs/write-validation.md` for the full Tier 3 guide.
