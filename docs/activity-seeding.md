# Activity seeding workflow

Issue #212 adds a reusable CLI workflow for populating the dedicated test
account with paced LinkedIn activity after the profile itself is seeded (#210)
and the image bundle is generated (#211).

## Requirements

- The target LinkedIn browser profile must already be authenticated.
- For longer runs, start the keep-alive daemon first:
  ```bash
  npm exec -w @linkedin-buddy/cli -- linkedin keepalive start --profile <profile>
  ```
- If you want image-backed posts, run issue #211 first and keep its JSON report
  available so the activity seed can reuse the generated post images.

## CLI command

```bash
npm exec -w @linkedin-buddy/cli -- linkedin seed activity \
  --profile <profile> \
  --spec docs/profile-seeds/issue-212-signikant-test-activity.json \
  --delay-ms 4500 \
  --yes \
  --output reports/activity-seed.json
```

## Intended issue-212 flow

1. Complete the issue-210 profile seeding workflow.
2. Generate the issue-211 image bundle and save the report, for example:
   `reports/profile-images.json`
3. Open `docs/profile-seeds/issue-212-signikant-test-activity.json` and
   replace the operator-curated social targets before running:
   - `connections.invites`
   - `feed.likes`
   - `feed.comments`
   - `messaging.replies`
4. Start keep-alive in another terminal.
5. Run `linkedin seed activity`.
6. Verify the resulting state with either the CLI or the existing MCP read
   tools:
   - `linkedin.connections.list`
   - `linkedin.feed.list`
   - `linkedin.inbox.list_threads`
   - `linkedin.notifications.list`
   - `linkedin.jobs.search`
   - `linkedin.jobs.view`

## What the command does

`seed activity` reads the JSON spec and then:

1. accepts up to the configured number of pending invitations
2. sends any curated connection invites that are not already connected or
   already pending
3. publishes the configured posts, defaulting to `connections` visibility when
   a post omits `visibility`
4. reuses issue-211 post images when a post references
   `generatedImageIndex`
5. confirms likes, comments, new threads, and replies one action at a time
6. runs the configured read-only job and notification checks
7. emits a final JSON report with end-of-run verification for connections,
   feed, and inbox threads

## Notes

- This workflow is intentionally CLI-only because it batches multiple real
  outbound actions in one run.
- Every write still goes through the existing two-phase action surface under
  the hood and is confirmed sequentially.
- The configured delay is randomized slightly between write actions so the run
  does not fire a rigid fixed cadence.
- Image-backed posts only require the issue-211 report path; the command reads
  `post_images[*].absolute_path` from that report or manifest automatically.
