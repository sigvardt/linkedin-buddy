# README Media Research

Issue `#246` asked for a short research phase before generating the README visuals. This note captures the decisions behind the shipped media set in `assets/media/`.

## Inspiration audit

These projects were useful references for how high-signal developer tools present themselves on GitHub:

- [`astral-sh/uv`](https://github.com/astral-sh/uv) — concise hero copy, fast install path, and command-first documentation.
- [`ollama/ollama`](https://github.com/ollama/ollama) — simple visual hierarchy with a strong product story and quick-start emphasis.
- [`charmbracelet/gum`](https://github.com/charmbracelet/gum) — polished terminal-first presentation that makes CLI workflows feel approachable.

The common pattern across strong READMEs was:

1. lead with a clear value proposition,
2. show the product quickly with motion or screenshots,
3. keep diagrams lightweight,
4. use command examples that are legible without scrolling forever.

## Format choices

| Format | Where it works best | Why it was chosen here |
| --- | --- | --- |
| `GIF` | One short hero/demo moment | GitHub READMEs reliably render animated GIFs inline, so one lightweight loop is the safest way to show install → auth → use without sending readers off-platform. |
| `SVG` | Diagrams, mockups, terminal cards | SVG stays crisp on GitHub, compresses extremely well, and keeps the total payload tiny while still supporting brand styling. |
| `PNG` / `WebP` | Photo-like screenshots | Not needed for this issue because the shipped visuals are diagrams and mockups rather than photographic UI captures. |

## CLI demo tooling notes

The most relevant tools for terminal media were:

- [`charmbracelet/vhs`](https://github.com/charmbracelet/vhs) — excellent when a repo wants scriptable terminal recordings with repeatable output.
- [`asciinema/agg`](https://github.com/asciinema/agg) — strong option for converting terminal recordings into sharp animated output.
- [`terminalizer`](https://github.com/faressoft/terminalizer) — still useful as a reference point, though the more modern workflows above felt more aligned with current OSS tooling.

For LinkedIn Buddy, the final assets intentionally use branded SVG terminal cards plus a small generated GIF instead of recording a live session. That keeps the README deterministic, safe for account handling, and free of environment-specific noise.

## Final direction for issue #246

The shipped media set follows these rules:

- one hero demo GIF,
- diagrams and static product illustrations as SVG,
- terminal cards with dark surfaces and brand accents,
- safe mock data only,
- total embedded README media kept comfortably under the issue budget.
