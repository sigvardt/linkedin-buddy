import {
  buildFeedbackHintMessage,
  LinkedInBuddyError,
  redactStructuredValue,
  resolvePrivacyConfig,
  toLinkedInBuddyErrorPayload,
} from "@linkedin-buddy/core";
import { type ToolArgs } from "./toolArgs.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

export type ToolErrorResult = {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
};

export type ToolHandler = (args: ToolArgs) => Promise<ToolResult>;

type FeedbackHintReason = "error" | "nth_invocation" | "session_first";

export const mcpPrivacyConfig = resolvePrivacyConfig();

export function toToolResult(payload: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          redactStructuredValue(payload, mcpPrivacyConfig, "cli"),
          null,
          2,
        ),
      },
    ],
  };
}

export function buildRecoveryHint(error: unknown): string | undefined {
  if (!(error instanceof LinkedInBuddyError)) {
    return "An unexpected error occurred. Check linkedin.session.status to verify your session is active.";
  }

  switch (error.code) {
    case "AUTH_REQUIRED":
      return "Your LinkedIn session has expired or is not authenticated. Run linkedin.session.open_login to start a new session, then retry.";
    case "CAPTCHA_OR_CHALLENGE":
      return "LinkedIn is showing a security challenge. Open your browser manually, complete the challenge, then retry the operation.";
    case "RATE_LIMITED":
      return "You have exceeded the rate limit for this action. Wait for the current rate-limit window to reset before retrying. Check the rate_limit details for timing.";
    case "UI_CHANGED_SELECTOR_FAILED":
      return "A LinkedIn page element could not be found — the page layout may have changed. Try running linkedin.session.health to check browser connectivity, then retry.";
    case "NETWORK_ERROR":
      return "A network error occurred. Verify your internet connection, then check linkedin.session.health. If the browser process is unresponsive, restart it with linkedin.session.open_login.";
    case "TIMEOUT":
      return "The operation timed out. The page may be loading slowly or the browser may be unresponsive. Try running linkedin.session.health, then retry with a simpler query if possible.";
    case "TARGET_NOT_FOUND":
      return "The requested target (profile, post, thread, job, etc.) was not found. Verify the URL or identifier is correct and the content still exists on LinkedIn.";
    case "ACTION_PRECONDITION_FAILED":
      return "A precondition for this action was not met. Check the error details for specifics — you may need to correct input parameters or complete a prerequisite step first.";
    default:
      return undefined;
  }
}

export function toErrorResult(error: unknown): ToolErrorResult {
  const payload = toLinkedInBuddyErrorPayload(error, mcpPrivacyConfig);
  const hint = buildRecoveryHint(error);
  const enrichedPayload = hint ? { ...payload, recovery_hint: hint } : payload;

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(enrichedPayload, null, 2),
      },
    ],
  };
}

export function shouldTrackMcpFeedback(toolName: string): boolean {
  return toolName !== "submit_feedback";
}

export function addFeedbackHintToResult<T extends ToolResult | ToolErrorResult>(
  result: T,
  reason?: FeedbackHintReason,
): T {
  const firstContent = result.content[0];
  if (!firstContent || firstContent.type !== "text") {
    return result;
  }

  try {
    const parsed = JSON.parse(firstContent.text) as Record<string, unknown>;
    const buildHintMessage = buildFeedbackHintMessage as (
      hintReason?: FeedbackHintReason,
    ) => string;
    parsed.feedback_hint = buildHintMessage(reason);

    return {
      ...result,
      content: [
        {
          type: "text",
          text: JSON.stringify(parsed, null, 2),
        },
      ],
    };
  } catch {
    return result;
  }
}
