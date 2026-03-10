# Profile image generation workflow

Issue #211 adds a reusable OpenAI-backed workflow for generating a cohesive
LinkedIn profile photo, banner, and reusable post images for the seeded test
persona.

## Requirements

- `OPENAI_API_KEY` must be set in the environment.
- For `--upload-profile-media`, the target LinkedIn profile must already be
  authenticated in the chosen browser profile.

## CLI command

```bash
npm exec -w @linkedin-assistant/cli -- linkedin assets generate-profile-images \
  --profile <profile> \
  --spec docs/profile-seeds/issue-210-signikant-test-profile.json \
  --post-count 6 \
  --upload-profile-media \
  --upload-delay-ms 4500 \
  --output reports/profile-images.json
```

What the command does:

1. Reads the persona from the JSON spec.
2. Generates:
   - one square profile photo (`800x800`)
   - one LinkedIn banner (`1584x396`)
   - a set of post images in mixed LinkedIn-friendly aspect ratios
3. Stores the generated files plus `manifest.json` under:
   `artifacts/<run-id>/linkedin-ai-assets/<persona-slug>/<timestamp>/`
4. Optionally uploads the profile photo and banner through the existing
   LinkedIn profile upload actions with a paced delay between the two uploads.

## Output bundle

The generated manifest includes:

- persona metadata derived from the seed spec
- the selected OpenAI model
- the bundle directory and manifest path
- prompt metadata and hashes for every generated image
- optional upload results for the profile photo and banner

Generated file names are intentionally realistic, for example:

- `emil-sorensen-profile-photo.png`
- `emil-sorensen-banner-ai-systems.png`
- `emil-sorensen-post-01-copenhagen-workspace.png`

## MCP tool

The same workflow is available through:

- `linkedin.assets.generate_profile_images`

Example MCP args:

```json
{
  "profileName": "default",
  "specPath": "docs/profile-seeds/issue-210-signikant-test-profile.json",
  "postImageCount": 6,
  "uploadProfileMedia": true,
  "uploadDelayMs": 4500
}
```

## Notes

- The runtime defaults to `gpt-image-1.5`, but both CLI and MCP allow an
  explicit model override.
- Banner generation keeps the left side visually calmer so the LinkedIn avatar
  overlay does not obscure the composition.
- Diagram-style post images avoid dense generated text to reduce obvious
  AI-image artifacts.
