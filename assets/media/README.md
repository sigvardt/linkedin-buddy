# Media Assets

This directory holds the README-ready visuals for LinkedIn Buddy.

## Principles

- Prefer lightweight `SVG` for static diagrams and illustrations.
- Keep animated content to a single optimized `GIF` so the README stays fast.
- Use the repository brand palette from `docs/brand-guidelines.md`.
- Favor self-contained cards and high-contrast labels that read well in both GitHub themes.
- Use safe mock data only — no live LinkedIn content should be embedded in README media.

## Layout

| Path | Purpose |
| --- | --- |
| `assets/media/demo/` | Animated product walkthroughs |
| `assets/media/diagrams/` | Architecture, workflow, and integration diagrams |
| `assets/media/features/` | Feature illustrations and annotated mockups |
| `assets/media/terminals/` | Terminal-style examples for install, config, and write previews |

## Inventory

| Asset | Format | Size | Purpose |
| --- | --- | ---: | --- |
| `assets/media/demo/core-workflow.gif` | GIF | `50.7 KB` | Install → auth → use walkthrough |
| `assets/media/diagrams/system-architecture.svg` | SVG | `12.2 KB` | Local-first system architecture |
| `assets/media/diagrams/install-to-daily-use.svg` | SVG | `10.9 KB` | End-to-end onboarding and daily workflow |
| `assets/media/diagrams/mcp-client-integration.svg` | SVG | `11.5 KB` | Claude / GPT / MCP client integration map |
| `assets/media/features/search-surface.svg` | SVG | `9.4 KB` | Unified search illustration |
| `assets/media/features/confirmed-actions.svg` | SVG | `10.4 KB` | Prepare-and-confirm write flow |
| `assets/media/features/activity-webhooks.svg` | SVG | `9.7 KB` | Activity polling and webhook delivery |
| `assets/media/terminals/install-and-build.svg` | SVG | `5.6 KB` | Install and build terminal card |
| `assets/media/terminals/mcp-quick-connect.svg` | SVG | `7.9 KB` | MCP configuration terminal card |
| `assets/media/terminals/confirm-before-write.svg` | SVG | `6.7 KB` | Prepare + confirm terminal card |

## Notes

- Static visuals stay vector-based so they remain crisp on HiDPI displays while keeping the total README payload low.
- The demo GIF is intentionally short and loops cleanly to communicate the core workflow without feeling noisy.
- The combined media payload embedded in the README is about `135 KB`, comfortably below the `5 MB` target for issue `#246`.
- Edit the committed SVGs directly when iterating on the visual system; the GIF is the only raster artifact in this folder tree.
