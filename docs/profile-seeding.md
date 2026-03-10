# Profile seeding workflow

This repo now includes CLI support for inspecting the editable LinkedIn profile
surface and applying a paced JSON profile spec through the existing two-phase
profile edit actions.

## Commands

```bash
npm exec -w @linkedin-assistant/cli -- linkedin profile editable --profile <profile>
npm exec -w @linkedin-assistant/cli -- linkedin profile apply-spec --profile <profile> --spec docs/profile-seeds/sample-automation-profile.json --allow-partial --yes --delay-ms 4000 --output reports/profile-seed.json
```

## Intended issue-210 flow

1. Authenticate a dedicated browser profile for the test account.
2. Inspect the current editable profile surface:
   ```bash
   npm exec -w @linkedin-assistant/cli -- linkedin profile editable --profile <profile>
   ```
3. Apply the seeded profile spec:
   ```bash
   npm exec -w @linkedin-assistant/cli -- linkedin profile apply-spec --profile <profile> --spec docs/profile-seeds/sample-automation-profile.json --allow-partial --yes --delay-ms 4000
   ```
4. Verify the rendered profile:
   ```bash
   npm exec -w @linkedin-assistant/cli -- linkedin profile view me --profile <profile>
   ```

## Current blockers

- Skills are still unsupported by the MCP/CLI profile editing surface: #228.
- The current AO workspace does not yet have a provisioned authenticated session
  for the dedicated `linkedin-mcp@example.test` test account: #253.

Because of those gaps, the example issue-210 spec includes the full desired
state, but `linkedin profile apply-spec` currently requires `--allow-partial`
to ignore unsupported skills while still applying the supported intro/settings/
public-profile/about/experience/education/certifications/languages/projects/
volunteer sections.

## Notes

- `apply-spec` uses the existing profile prepare/confirm flow internally and
  confirms one change at a time.
- The command inserts a randomized delay around the configured `--delay-ms`
  value between confirmed actions so large profile edits do not fire in a single
  burst.
- `--replace` removes unmatched items for sections included in the spec. This is
  best suited for a fresh or intentionally reset test profile.
