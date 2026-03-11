# Repository SEO Playbook

Last updated: 2026-03-11

Issue: [#245](https://github.com/sigvardt/linkedin-buddy/issues/245)

## Primary Keywords

- `linkedin mcp`
- `linkedin mcp server`
- `linkedin api`
- `linkedin cli`

## Secondary Keywords

- `linkedin automation`
- `linkedin toolkit`
- `linkedin agent tools`
- `linkedin typescript`
- `linkedin playwright`
- `linkedin browser automation`
- `model context protocol linkedin`
- `linkedin jobs automation`
- `linkedin messaging automation`
- `linkedin developer tools`

## Metadata To Keep In Sync

### GitHub / root package description

`Open-source LinkedIn MCP server, LinkedIn CLI, and TypeScript automation toolkit for inbox, search, feed, jobs, profile, and safe confirmed actions.`

### Suggested homepage URL

`https://github.com/sigvardt/linkedin-buddy/tree/main/docs`

### Suggested topics

- `linkedin`
- `linkedin-api`
- `linkedin-automation`
- `linkedin-cli`
- `linkedin-mcp`
- `linkedin-toolkit`
- `mcp`
- `mcp-server`
- `model-context-protocol`
- `playwright`
- `browser-automation`
- `typescript`
- `nodejs`
- `ai-agents`

### Social preview asset

Use `assets/brand/social-preview.png` for the GitHub social preview image.

GitHub CLI and the public `updateRepository` GraphQL mutation support description and homepage updates, but not social preview uploads, so this image currently has to be set in the GitHub repository settings UI.

## README Search Surfaces

The root README should continue to emphasize:

- "LinkedIn MCP server" in the hero and early paragraphs.
- "LinkedIn CLI" and "TypeScript API" in section headings.
- "LinkedIn API" language with a clear note that this is a Playwright-backed toolkit, not LinkedIn's official partner API.
- Copy-paste quick start commands.
- Comparison language that helps evaluators understand the repo quickly.
- Internal links to docs for advanced workflows.

## GitHub Search Baseline

Snapshot captured on 2026-03-11 with:

```bash
gh search repos "<query>" --limit 10 --json name,description,url
```

| Query | linkedin-buddy in top 10? | Example top result |
| --- | --- | --- |
| `linkedin mcp` | No | `stickerdaniel/linkedin-mcp-server` |
| `linkedin mcp server` | No | `stickerdaniel/linkedin-mcp-server` |
| `linkedin cli` | No | `tigillo/linkedin-cli` |
| `linkedin api` | No | `alabarga/linkedin-api` |

This baseline is intentionally lightweight. Re-run it after major README or metadata changes to see whether GitHub repo search visibility improves.

## npm Metadata Targets

Root and package-level `package.json` files should keep these ideas aligned:

- `linkedin-mcp`
- `linkedin-mcp-server`
- `linkedin-cli`
- `linkedin-api`
- `linkedin-automation`
- `model-context-protocol`
- `playwright`
- `browser-automation`
- `typescript`
- `nodejs`

## Release Checklist For Discoverability

- Update `README.md` hero copy if the product surface changes.
- Keep `package.json` descriptions and keywords aligned.
- Keep GitHub description, topics, and homepage aligned with this file.
- Verify the README badges still render.
- Verify the social preview image file still matches the current brand.
