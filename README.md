<p align="center">
  <img src="./assets/brand/banner.png" alt="LinkedIn Buddy — the chameleon that blends in" width="720" />
</p>

<p align="center">
  <strong>LinkedIn automation that doesn't get you banned.</strong><br>
  <em>CLI · MCP Server · TypeScript API — one runtime, three surfaces.</em>
</p>

<p align="center">
  <a href="https://github.com/sigvardt/linkedin-buddy/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/sigvardt/linkedin-buddy/ci.yml?branch=main&label=CI" alt="CI status" /></a>
  <a href="https://www.npmjs.com/"><img src="https://img.shields.io/badge/npm-publish--ready-CB3837?logo=npm&logoColor=white" alt="npm publish ready" /></a>
  <a href="https://github.com/sigvardt/linkedin-buddy/stargazers"><img src="https://img.shields.io/github/stars/sigvardt/linkedin-buddy?style=flat" alt="GitHub stars" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-compatible-1f6feb" alt="MCP compatible" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white" alt="Node.js 22+" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript strict" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-pending-lightgrey" alt="License pending" /></a>
</p>

<p align="center">
  <a href="#get-running-in-60-seconds">Install</a> ·
  <a href="#plug-into-your-ai">MCP Setup</a> ·
  <a href="#go-deeper">Features</a> ·
  <a href="#use-the-typescript-api">TypeScript API</a> ·
  <a href="#docs">Docs</a>
</p>

---

## You've been doing LinkedIn wrong.

Scraping with Python scripts that break every Tuesday. Rate-limited by APIs that don't actually exist. Copy-pasting from the web UI like it's 2015. Running Chrome extensions that sell your session cookies to whoever's buying.

Stop.

LinkedIn Buddy is a local-first Playwright runtime that operates LinkedIn the way you would — just faster, safer, and without the RSI. Anti-bot evasion, persistent browser profiles, and a two-phase commit system that previews every single write before it fires. Nothing touches LinkedIn until you say so.

<!-- chameleon at laptop pose -->

- **Three surfaces. One runtime.** CLI for operators, MCP server for AI agents, TypeScript API for builders. Same services, same safety guarantees, zero duplication.
- **Every write previews first.** Two-phase commit. Prepare, inspect, confirm. No accidental DMs. No "oops, wrong connection request."
- **The chameleon blends in.** Human-like typing, Poisson-distributed pauses, Bézier mouse paths. LinkedIn sees a person, not a bot.
- **Your machine. Your data.** SQLite state, persistent profiles, structured logs, screenshots. Nothing leaves your laptop. No cloud. No telemetry. No accounts.
- **100+ MCP tools.** Claude Desktop, Cursor, Cline — your agent gets full LinkedIn access through structured tool calls, not brittle prompt hacks.

<p align="center">
  <img src="./assets/media/demo/core-workflow.gif" alt="Terminal demo: install, authenticate, search LinkedIn" width="720" />
</p>

---

## Get running in 60 seconds.

You're a developer. You've done this before.

```bash
git clone https://github.com/sigvardt/linkedin-buddy.git
cd linkedin-buddy
npm install
npx playwright install chromium
npm run build
```

Authenticate and verify:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin login --profile default
npm exec -w @linkedin-buddy/cli -- linkedin status --profile default
```

Run your first search:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin search "developer relations" --category people --limit 5
```

That's it. You're in.

> **Tip:** The CLI installs three equivalent binaries — `linkedin`, `lbud`, and `linkedin-buddy`. After a global install (once published), drop the `npm exec` prefix entirely:
>
> ```bash
> lbud search "developer relations" --category people --limit 5
> ```

Prefer manual encrypted session capture over browser-based login?

```bash
npm exec -w @linkedin-buddy/cli -- linkedin auth session --session default
```

![Install and build terminal](./assets/media/terminals/install-and-build.svg)

---

## Plug into your AI.

Paste this into your MCP client config. Done.

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

Works with Claude Desktop, Cursor, Cline, and every MCP-compatible client. 100+ tools. Zero boilerplate. Your AI agent interacts with LinkedIn through structured tool calls — not screen-scraping, not prompt engineering, not prayer.

**Tools to start with:**
`linkedin.session.status` · `linkedin.search` · `linkedin.inbox.list_threads` · `linkedin.feed.list` · `linkedin.jobs.search` · `linkedin.notifications.list` · `linkedin.actions.confirm` · `linkedin.activity_poller.run_once`

![MCP quick connect terminal](./assets/media/terminals/mcp-quick-connect.svg)

![MCP client integration diagram](./assets/media/diagrams/mcp-client-integration.svg)

---

## Go deeper.

### 🔍 Search everything.

<!-- chameleon with phone pose -->

People, companies, posts, jobs, groups, events. One unified surface, structured results.

```bash
npm exec -w @linkedin-buddy/cli -- linkedin search "staff engineer" --category people --limit 5
npm exec -w @linkedin-buddy/cli -- linkedin search "open source ai" --category posts --limit 5
npm exec -w @linkedin-buddy/cli -- linkedin jobs search "product manager" --location Copenhagen --limit 10
```

![Search surface illustration](./assets/media/features/search-surface.svg)

---

### 💬 Inbox. Read it. Reply safely.

<!-- chameleon at laptop pose -->

List threads, read messages, stage replies. Every outbound message goes through two-phase commit — you see exactly what will send before it sends.

```bash
npm exec -w @linkedin-buddy/cli -- linkedin inbox list --limit 10
npm exec -w @linkedin-buddy/cli -- linkedin inbox show --thread <thread-url-or-id> --limit 20
npm exec -w @linkedin-buddy/cli -- linkedin inbox prepare-reply --thread <thread-url-or-id> --text "Thanks for reaching out."
npm exec -w @linkedin-buddy/cli -- linkedin actions confirm --token ct_...
```

---

### 📝 Feed and posts. Comment without regret.

<!-- chameleon writing pose -->

Browse the feed, view posts, stage comments. The confirm flow means you see exactly what will post before it posts. Create text posts, media posts, and polls through the same two-phase pipeline.

```bash
npm exec -w @linkedin-buddy/cli -- linkedin feed list --limit 5
npm exec -w @linkedin-buddy/cli -- linkedin feed view <post-url>
npm exec -w @linkedin-buddy/cli -- linkedin feed comment <post-url> --text "Insightful breakdown. Thanks for sharing."
npm exec -w @linkedin-buddy/cli -- linkedin actions confirm --token ct_...
```

![Confirmed actions illustration](./assets/media/features/confirmed-actions.svg)

---

### 💼 Jobs. Search, save, apply.

<!-- chameleon with briefcase pose -->

Full job search with location filters and Easy Apply support. Save jobs, manage alerts, track everything locally in SQLite.

```bash
npm exec -w @linkedin-buddy/cli -- linkedin jobs search "product manager" --location Copenhagen --limit 10
```

---

### 👤 Profiles, companies, and notifications.

Inspect any profile, browse company pages, manage your notification feed.

```bash
npm exec -w @linkedin-buddy/cli -- linkedin profile view me
npm exec -w @linkedin-buddy/cli -- linkedin company view openai
npm exec -w @linkedin-buddy/cli -- linkedin notifications list --limit 20
```

---

### ☕ Activity polling. Webhooks that actually work.

<!-- chameleon with coffee pose -->

Set up watches on LinkedIn activity. Get notified when things change. Fan out webhooks with HMAC-signed payloads and automatic retry logic.

```bash
npm exec -w @linkedin-buddy/cli -- linkedin activity watch add --profile default --kind notifications --interval-seconds 600
npm exec -w @linkedin-buddy/cli -- linkedin activity webhook add --watch <watch-id> --url https://example.com/hooks/linkedin
npm exec -w @linkedin-buddy/cli -- linkedin activity run-once --profile default
```

![Activity webhooks illustration](./assets/media/features/activity-webhooks.svg)

---

## Every write previews before it executes. No accidents.

<!-- chameleon thumbs up pose -->

This isn't a YOLO automation tool. Every outbound action — messages, connection requests, comments, profile edits, posts — goes through two-phase commit:

1. **Prepare** → Action stored in SQLite, preview returned, confirm token generated.
2. **Review** → You (or your AI agent) inspect exactly what will happen.
3. **Confirm** → Token validated, action executed, result recorded.

Tokens expire in 30 minutes. HMAC-SHA256 sealed with entropy. No confirmation, no execution. Period.

![Confirm before write terminal](./assets/media/terminals/confirm-before-write.svg)

---

## The chameleon blends in.

LinkedIn's bot detection is aggressive. LinkedIn Buddy doesn't fight it — it disappears.

- **Human-like typing** with configurable typo rates and correction pauses
- **Poisson-distributed delays** between actions — not fixed sleeps, real statistical distributions
- **Bézier curve mouse paths** — smooth, natural movement with overshoot and correction
- **Fingerprint hardening** — WebGL, canvas, timezone, locale, all consistent per profile
- **Four evasion levels** — `off` · `light` · `moderate` (default) · `aggressive`

Configure via `--evasion-level`, `LINKEDIN_BUDDY_EVASION_LEVEL` env var, or runtime options. See [`docs/evasion.md`](./docs/evasion.md) for the full breakdown.

---

## Use the TypeScript API.

Skip the CLI. Embed the full runtime in your own apps.

```ts
import { createCoreRuntime } from "@linkedin-buddy/core";

const runtime = createCoreRuntime();

try {
  const result = await runtime.search.search({
    profileName: "default",
    category: "people",
    query: "developer relations",
    limit: 5,
  });

  console.log(result.results.map((person) => person.name));
} finally {
  runtime.close();
}
```

Same services, same two-phase commit safety, same evasion layer. Everything the CLI and MCP server use, exposed as clean TypeScript APIs with full type definitions.

---

## Architecture.

Local-first. No cloud. No third-party servers. Everything runs on your machine.

| Architecture | Workflow |
|---|---|
| ![System architecture diagram](./assets/media/diagrams/system-architecture.svg) | ![Workflow: install to daily use](./assets/media/diagrams/install-to-daily-use.svg) |

The runtime wires 25+ services through constructor injection. No circular dependencies.

```
Infrastructure:  DB → Logger → Artifacts → ProfileManager → Auth → RateLimiter → TwoPhaseCommit
                                                                        ↓
LinkedIn:        Inbox, Feed, Connections, Profile, Search, Jobs, Notifications,
                 Posts, Publishing, Followups, Groups, Events, CompanyPages,
                 Members, PrivacySettings, Analytics
                                                                        ↓
Activity:        Watches → Poller → Webhooks → Scheduler
```

---

## How it compares.

| Tool | CLI | MCP | Dev API | Confirm-before-write | Best fit |
|---|---|---|---|---|---|
| **LinkedIn Buddy** | ✅ | ✅ | ✅ | ✅ | Local-first workflows for operators and AI agents |
| [`stickerdaniel/linkedin-mcp-server`](https://github.com/stickerdaniel/linkedin-mcp-server) | — | ✅ | — | — | MCP-focused LinkedIn scraping and job search |
| [`tigillo/linkedin-cli`](https://github.com/tigillo/linkedin-cli) | ✅ | — | — | — | Terminal-oriented LinkedIn usage |
| [`alabarga/linkedin-api`](https://github.com/alabarga/linkedin-api) | — | — | ✅ | — | Library-style LinkedIn integrations |

See [`docs/repository-seo.md`](./docs/repository-seo.md) for keyword targets and the GitHub-search baseline.

---

## Terminal snapshots.

| Install and build | MCP quick connect | Confirm before write |
|---|---|---|
| ![Install and build](./assets/media/terminals/install-and-build.svg) | ![MCP setup](./assets/media/terminals/mcp-quick-connect.svg) | ![Confirm flow](./assets/media/terminals/confirm-before-write.svg) |

---

## Docs.

| Need | Doc |
|---|---|
| Activity polling and webhooks | [`docs/activity-webhooks.md`](./docs/activity-webhooks.md) |
| Anti-bot evasion profiles | [`docs/evasion.md`](./docs/evasion.md) |
| E2E and replay testing | [`docs/e2e-testing.md`](./docs/e2e-testing.md) |
| Live validation and account safety | [`docs/write-validation.md`](./docs/write-validation.md) |
| Selector auditing | [`docs/selector-audit.md`](./docs/selector-audit.md) |
| Draft quality evaluation | [`docs/draft-quality-evaluation.md`](./docs/draft-quality-evaluation.md) |
| Brand and social preview assets | [`docs/brand-guidelines.md`](./docs/brand-guidelines.md) |
| README media research | [`docs/readme-media-research.md`](./docs/readme-media-research.md) |
| Media asset inventory | [`assets/media/README.md`](./assets/media/README.md) |
| Articles and newsletters | [`docs/articles-newsletters.md`](./docs/articles-newsletters.md) |
| Notifications | [`docs/notifications.md`](./docs/notifications.md) |
| Rate limiting | [`docs/rate-limiting.md`](./docs/rate-limiting.md) |
| Jobs, alerts, and Easy Apply | [`docs/jobs.md`](./docs/jobs.md) |
| SEO targets and metadata | [`docs/repository-seo.md`](./docs/repository-seo.md) |

---

## Contributing.

Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md). Be decent ([`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)). Report security issues through [`SECURITY.md`](./SECURITY.md).

If you change CLI commands, MCP tools, or write flows — update the README and the relevant docs so new users discover the feature.

---

## Star history.

[![Star History Chart](https://api.star-history.com/svg?repos=sigvardt/linkedin-buddy&type=Date)](https://star-history.com/#sigvardt/linkedin-buddy&Date)

---

## Author's note.

LinkedIn's API is locked behind partner programs most developers will never access. The web UI is designed for humans clicking buttons one at a time. Every existing tool is either a fragile Python scraper, a Chrome extension with questionable permissions, or a wrapper around endpoints that don't actually exist publicly.

I built LinkedIn Buddy because I needed LinkedIn automation that worked. Not a demo. Not a proof-of-concept that impresses on Twitter and breaks in production. A real tool that handles authentication, evades detection, previews every action before executing, and runs entirely on my own machine.

The two-phase commit system isn't a nice-to-have — it's the thing that lets AI agents use LinkedIn without accidentally messaging your CEO. The evasion layer isn't paranoia — it's the difference between a tool that works for a week and one that works for months.

100% open source. No telemetry. No cloud. No accounts. Your data stays on your machine.

Find it useful? Star the repo. Find a bug? Open an issue. Have a better approach? PRs are welcome.

---

## License

License: pending repository selection.

Built with [Playwright](https://playwright.dev/), [Commander](https://github.com/tj/commander.js), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), and the [Model Context Protocol SDK](https://modelcontextprotocol.io/).

Release notes in [`CHANGELOG.md`](./CHANGELOG.md).
