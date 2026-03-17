# packages/mcp/src — MCP Server Package

## Overview

Model Context Protocol stdio server exposing all core services as AI-consumable tools.
100+ tools across 15 categories. Entry point: `bin/linkedin-mcp.ts` (7,555+ lines).

## Files

| File | Purpose |
|------|---------|
| `bin/linkedin-mcp.ts` | All MCP tool handlers — mirrors CLI surface for AI agents |
| `index.ts` | Tool name constants (157 exports) — `TOOL_SESSION_STATUS`, `TOOL_SEARCH`, etc. |

## Tool Handler Pattern

```typescript
async function handleToolName(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);
  try {
    const profileName = readString(args, "profileName", "default");
    const requiredField = readRequiredString(args, "field");

    runtime.logger.log("info", "mcp.domain.operation.start", { profileName });
    const result = await runtime.service.method({ profileName, requiredField });
    runtime.logger.log("info", "mcp.domain.operation.done", { ... });

    return toToolResult({ run_id: runtime.runId, profile_name: profileName, ...result });
  } finally {
    runtime.close();
  }
}
```

## Input Validation Helpers

| Helper | Purpose |
|--------|---------|
| `readString(args, key, default)` | Optional string with default |
| `readRequiredString(args, key)` | Required string — throws if missing |
| `readPositiveNumber(args, key, default)` | Positive integer with validation |
| `readBoolean(args, key, default)` | Boolean with default |
| `readSearchCategory(args, key, default)` | Enum validation for search categories |

## Adding a New MCP Tool

1. Add tool name constant in `index.ts`: `export const TOOL_FEATURE_ACTION = "linkedin.feature.action";`
2. Add tool definition in `bin/linkedin-mcp.ts` with input schema (JSON Schema format)
3. Add handler function following the pattern above
4. Register in the tool router switch statement
5. Use `toToolResult()` for success, `toErrorResult()` for errors
6. Log with `mcp.domain.operation.start/done` event naming

## Tool Categories

| Prefix | Domain | Example |
|--------|--------|---------|
| `linkedin.session.*` | Auth | `session.status`, `session.health` |
| `linkedin.search` | Search | Universal search |
| `linkedin.inbox.*` | Messaging | `inbox.list_threads`, `inbox.prepare_reply` |
| `linkedin.feed.*` | Feed | `feed.list`, `feed.like`, `feed.comment` |
| `linkedin.profile.*` | Profile | `profile.view`, `profile.prepare_update_intro` |
| `linkedin.connections.*` | Network | `connections.list`, `connections.invite` |
| `linkedin.jobs.*` | Jobs | `jobs.search`, `jobs.view` |
| `linkedin.notifications.*` | Alerts | `notifications.list` |
| `linkedin.post.*` | Publishing | `post.prepare_create` |
| `linkedin.activity_*` | Polling | `activity_watch.create`, `activity_poller.run_once` |
| `linkedin.actions.*` | Confirm | `actions.confirm` |

## MCP Client Configuration

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npm",
      "args": ["exec", "-w", "@linkedin-buddy/mcp", "--", "linkedin-mcp"]
    }
  }
}
```

## Anti-Patterns

- NEVER skip input validation — always use `readString`/`readRequiredString` helpers
- NEVER return raw errors — wrap in `toErrorResult()` with `LinkedInBuddyError`
- NEVER forget `runtime.close()` — always use try/finally
- Tool names follow `linkedin.<domain>.<action>` convention — never deviate
- All tools include optional `cdpUrl` and `selectorLocale` parameters


## Core Principle

**GitHub is our source of truth.** Always check issue history, commits, and comments before starting implementation.
