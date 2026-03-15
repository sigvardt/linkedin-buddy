# Brand Guidelines

<p align="center">
  <img src="../assets/brand/mascot-clean.png" alt="LinkedIn Buddy chameleon mascot" width="200" />
</p>

LinkedIn Buddy should feel like a capable teammate: calm, sharp, confident, and
a little playful. The chameleon mascot — a green chameleon in a business suit
with headphones — is the visual embodiment of the product: it blends in, gets
the job done, and looks good doing it.

## Brand essence

- Tone: confident, developer-native, slightly irreverent
- Personality: sharp edge, friendly face — the mascot is approachable, the copy
  is direct
- Visual anchor: green chameleon mascot in a business suit
- Design rule: always prefer clarity at small sizes over extra detail

## Mascot identity

The LinkedIn Buddy chameleon is a professional who blends in. Six poses cover
the full product surface:

| Pose | Description | Usage |
|------|-------------|-------|
| Laptop (typing) | Chameleon at a laptop | Hero section, Quick Start |
| Writing (notepad) | Chameleon writing notes | Feed & Posts, Publishing |
| Phone (showing LinkedIn) | Chameleon holding a phone | Search, Notifications |
| Coffee + phone | Chameleon relaxing with coffee | Activity Polling, casual sections |
| Briefcase + filing | Chameleon in business mode | Jobs section |
| Thumbs up at desk | Chameleon celebrating | MCP Server, footer, success states |

### Mascot files

| File | Purpose |
|------|---------|
| `assets/brand/chameleon-poses.png` | All 6 poses on one sheet — reference for section illustrations |
| `assets/brand/mascot-clean.png` | Clean mascot on white/transparent background — inline README use, docs headers |
| `assets/brand/app-icon.png` | Chameleon on blue rounded-square — favicon source, repo avatar |
| `assets/brand/banner.png` | Chameleon on blue gradient + "linkedin-buddy" text — README hero image |
| `assets/brand/social-preview-v2.png` | Full marketing card with MCP/CLI/TS badges — GitHub social preview |

## Color palette

| Role | Hex | Usage |
|------|-----|-------|
| Primary Blue | `#0077B5` | Banner gradient, app icon background, LinkedIn-adjacent accent |
| Chameleon Green | `#2ECC71` | Mascot fill, active accents, highlights |
| Primary Ink | `#0F172A` | Headlines, icon strokes, terminal surfaces |
| Primary Mint | `#14B8A6` | Secondary highlights, code accents |
| Secondary Coral | `#FF7A59` | Callouts, warm emphasis |
| Soft Cream | `#FFF7ED` | Light backplates, soft backgrounds |
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

- Source: `assets/brand/social-preview-v2.png`
- Canvas: `1280x640`
- Safe margin: `64px` minimum on all sides
- Upload to: GitHub → Settings → Social preview

Composition rules:

- feature the chameleon mascot prominently
- include product name and one-line tagline
- include surface badges (MCP, CLI, TypeScript)
- use the blue gradient background consistent with the banner
- keep background texture soft so link-preview compression does not muddy the text

## App icon and favicons

The app icon (`assets/brand/app-icon.png`) is the chameleon on a blue
rounded-square background. Generate favicons from this source:

| File | Size | Purpose |
|------|------|---------|
| `assets/brand/favicon.ico` | 16, 32, 48 multi-size | Browser favicon |
| `assets/brand/favicon-32.png` | 32×32 | PNG favicon fallback |
| `assets/brand/favicon.svg` | scalable | SVG favicon (keep as fallback if not regenerated) |
| `assets/brand/png/app-icon-64.png` | 64×64 | Small raster icon |
| `assets/brand/png/app-icon-128.png` | 128×128 | Medium raster icon |
| `assets/brand/png/app-icon-256.png` | 256×256 | Large raster icon |
| `assets/brand/png/app-icon-512.png` | 512×512 | XL raster icon |

## Usage rules

Do:

- use the chameleon mascot on brand-colored or transparent fields
- preserve the green chameleon fill when space allows
- use the app icon for small square contexts (favicons, avatars)
- use the banner for README and marketing hero areas
- use `mascot-clean.png` for inline documentation illustrations
- use the social preview card for GitHub social preview settings

Do not:

- recolor the chameleon to LinkedIn blue (it's intentionally green — it blends in)
- add gradients inside the mascot itself
- stretch or distort the mascot proportions
- use the full detailed mascot below `32px` — switch to the app icon or favicon

## Asset inventory

### Chameleon mascot files

- `assets/brand/chameleon-poses.png` — all 6 poses reference sheet
- `assets/brand/mascot-clean.png` — clean mascot, white/transparent background
- `assets/brand/app-icon.png` — app icon, blue rounded-square
- `assets/brand/banner.png` — README hero banner
- `assets/brand/social-preview-v2.png` — GitHub social preview card

### Favicons and raster icons

- `assets/brand/favicon.ico` — multi-size ICO
- `assets/brand/favicon-32.png` — 32px PNG
- `assets/brand/favicon.svg` — SVG fallback
- `assets/brand/png/app-icon-64.png`
- `assets/brand/png/app-icon-128.png`
- `assets/brand/png/app-icon-256.png`
- `assets/brand/png/app-icon-512.png`

## Regenerating assets

Once the app icon source is available, generate favicon variants:

```bash
npm run brand:generate
```

That script rasterizes the committed sources into the PNG and ICO outputs
tracked in this repository.
