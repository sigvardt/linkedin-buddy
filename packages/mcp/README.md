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

## Anti-bot evasion visibility

The MCP server does not expose a dedicated `linkedin.evasion.*` tool family.

Instead, MCP clients inspect the resolved evasion snapshot through the existing
session tools:

- `linkedin.session.status` returns `status.evasion`
- `linkedin.session.health` returns `session.evasion`

Important details:

- tool inputs do not accept evasion-specific args today
- the MCP process inherits evasion defaults from
  `LINKEDIN_ASSISTANT_EVASION_LEVEL` and
  `LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS` when the server starts
- enabling diagnostics affects the run log, not the MCP tool schema

See `../../docs/evasion.md` for the JSON path reference, configuration model,
and troubleshooting guide.

## Member safety and privacy tools

The MCP server now exposes:

- `linkedin.profile.prepare_update_settings`
- `linkedin.profile.prepare_update_public_profile`
- `linkedin.members.prepare_block`
- `linkedin.members.prepare_unblock`
- `linkedin.members.prepare_report`
- `linkedin.privacy.get_settings`
- `linkedin.privacy.prepare_update_setting`

Current privacy-setting coverage focuses on:

- `profile_viewing_mode`
- `connections_visibility`
- `last_name_visibility`

All member-safety writes and privacy-setting updates use the existing
two-phase prepare/confirm flow through `linkedin.actions.confirm`.

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
