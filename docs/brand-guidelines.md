# Brand Guidelines

![LinkedIn Buddy wordmark](../assets/brand/logo-wordmark.svg)

LinkedIn Buddy should feel like a capable teammate: calm, warm, sharp, and a
little playful. The brand direction in this repository is intentionally more
approachable than corporate automation tooling and intentionally distinct from
LinkedIn's own branding.

## Brand essence

- Tone: friendly, capable, developer-native
- Personality: cute without becoming childish
- Visual anchor: rounded speech-bubble mascot with a signal spark
- Design rule: always prefer clarity at small sizes over extra detail

## Logo system

### Primary mark

- File: `assets/brand/logo-mark.svg`
- Use for: README headers, product cards, docs landing pages, and square app
  icons
- Keep clear space equal to at least the width of one eye dot on all sides

### Wordmark lockup

- File: `assets/brand/logo-wordmark.svg`
- Use for: npm listing art, README hero areas, profile banners, and slides
- Prefer the full lockup when horizontal space is available

### Badge mark

- File: `assets/brand/logo-badge.svg`
- Use for: `20px`-tall shields.io custom badge logos and monochrome surfaces
- This version is simplified to preserve the silhouette at tiny sizes

### Favicon

- File: `assets/brand/favicon.svg`
- Use for: docs sites, dashboards, browser tabs, and app manifests
- The favicon intentionally removes the smile and spark so the eye-and-bubble
  silhouette stays crisp at `16px`

## Color palette

| Role | Hex | Usage |
| --- | --- | --- |
| Primary Ink | `#0F172A` | Headlines, icon strokes, terminal surfaces |
| Primary Mint | `#14B8A6` | Logo fill, highlights, active accents |
| Secondary Coral | `#FF7A59` | Spark, callouts, warm emphasis |
| Soft Cream | `#FFF7ED` | Light backplates, logo containers, soft backgrounds |
| Night Slate | `#111827` | Dark surfaces and preview cards |
| Fog | `#E5E7EB` | Borders and muted text on dark surfaces |

### Accessibility pairings

These pairings are safe defaults for docs, badges, and social art:

- `#0F172A` on `#FFF7ED`: `16.81:1`
- `#E5E7EB` on `#111827`: `14.33:1`
- `#0F172A` on `#14B8A6`: `7.17:1`
- `#0F172A` on `#FF7A59`: `6.95:1`

Keep body text on dark surfaces at `Fog` or lighter, and avoid coral-on-cream
for long text because it is better suited to accents than dense reading.

## Typography

- Headline / brand: `Sora`, fallback `Avenir Next`, `Trebuchet MS`, `Segoe UI`,
  `sans-serif`
- UI / body: `Plus Jakarta Sans`, fallback `Avenir Next`, `Segoe UI`,
  `sans-serif`
- CLI / code: `JetBrains Mono`, fallback `SFMono-Regular`, `Menlo`,
  `Consolas`, `monospace`

### Type rules

- Use sentence case by default.
- Avoid all-caps for long labels.
- Keep tracking slightly tight on headlines and neutral on body copy.
- Favor medium and semibold weights over heavy black weights.

## Social preview

- Source: `assets/brand/social-preview.svg`
- Export: `assets/brand/social-preview.png`
- Canvas: `1280x640`
- Safe margin: `64px` minimum on all sides

Composition rules:

- keep one dominant focal mark on the left
- keep the product name and value prop on the right
- use no more than one short supporting block, such as a terminal card or chip
  row
- keep background texture soft so link-preview compression does not muddy the
  text

## Usage rules

Do:

- use the mark on a warm cream or transparent field
- preserve the mint fill and coral spark when space allows
- switch to the badge or favicon variants below `32px`
- use the wordmark lockup for README and npm-facing surfaces

Do not:

- recolor the mark to LinkedIn blue
- add gradients inside the mascot itself
- squeeze the wordmark vertically
- place the full detailed mark at `16px`

## Asset inventory

### Vector files

- `assets/brand/logo-mark.svg`
- `assets/brand/logo-wordmark.svg`
- `assets/brand/logo-badge.svg`
- `assets/brand/favicon.svg`
- `assets/brand/social-preview.svg`

### Raster files

- `assets/brand/favicon-32.png`
- `assets/brand/png/logo-mark-16.png`
- `assets/brand/png/logo-mark-32.png`
- `assets/brand/png/logo-mark-64.png`
- `assets/brand/png/logo-mark-128.png`
- `assets/brand/png/logo-mark-256.png`
- `assets/brand/png/logo-mark-512.png`
- `assets/brand/social-preview.png`

## Regenerating assets

Run:

```bash
npm run brand:generate
```

That script rasterizes the committed SVG sources into the PNG outputs tracked in
this repository.
