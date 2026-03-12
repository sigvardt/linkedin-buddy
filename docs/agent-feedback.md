# Agent feedback

The feedback module lets operators and AI agents file bug reports, feature requests, and improvement suggestions as GitHub issues directly from the CLI or MCP server. PII is scrubbed automatically before submission.

## Quickstart

Use the interactive mode to file feedback:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin feedback
```

File feedback directly with flags:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin feedback \
  --type bug \
  --title "Connection request failure" \
  --description "The agent failed to send a connection request to URN 12345"
```

Flush saved feedback files:

```bash
npm exec -w @linkedin-buddy/cli -- linkedin feedback --submit-pending
```

## MCP tool

The `submit_feedback` tool allows agents to report issues or suggest improvements. It requires three parameters:

- `type`: Must be one of `bug`, `feature`, or `improvement`.
- `title`: A short summary of the feedback.
- `description`: Detailed information about the report or suggestion.

## Privacy scrubbing

The system automatically redacts sensitive information before submission. Redacted content is replaced with `[REDACTED]`. Scrubbed data includes:

- emails and IP addresses
- LinkedIn URLs and URNs
- JWT tokens, Bearer tokens, and cookies
- auth headers and secret assignments
- user-home file paths
- long base64 blobs

## Pending feedback

When `gh auth status` fails, feedback is saved as `.md` files under `~/.linkedin-buddy/pending-feedback/`. You can submit these later with `linkedin-buddy feedback --submit-pending` after running `gh auth login`. The system maintains a 50-file limit for pending feedback.

## Feedback hints

Hints appear on the first session use, every 20th invocation, and after errors. You can configure the frequency with the `LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N` environment variable. Hints are context-aware, providing different messages for errors versus regular usage. The session idle timeout defaults to 30 minutes and is configurable via `LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS`.

## GitHub issue labels

| Type        | Labels                          |
| :---------- | :------------------------------ |
| bug         | `bug`, `agent-feedback`         |
| feature     | `enhancement`, `agent-feedback` |
| improvement | `improvement`, `agent-feedback` |

## Configuration

| Variable                                  | Default | Description                            |
| :---------------------------------------- | :------ | :------------------------------------- |
| `LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N`    | 20      | Show hint every N invocations          |
| `LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS` | 1800000 | Reset session after this idle duration |

## Hardening limits

- 30s `gh` command timeout
- 50 maximum pending files
- 512KB maximum pending file size
- 12KB maximum error stack in technical context
