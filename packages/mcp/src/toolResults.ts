import {
  buildFeedbackHintMessage,
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

function getRecoveryHint(code: string): string | undefined {
  const hints: Record<string, string> = {
    AUTH_REQUIRED:
      "Run linkedin.session.open_login to authenticate, then retry.",
    CAPTCHA_OR_CHALLENGE:
      "LinkedIn detected unusual activity. Wait 5-10 minutes, then run linkedin.session.health to check status.",
    RATE_LIMITED:
      "Daily rate limit reached for this action type. Check the rate_limit details for remaining quota and window reset time.",
    UI_CHANGED_SELECTOR_FAILED:
      "LinkedIn's UI may have changed. Run the CLI selector audit (linkedin audit selectors) and report the issue.",
    NETWORK_ERROR:
      "Network request failed. Check your internet connection and retry. If persistent, check linkedin.session.health.",
    TIMEOUT:
      "Operation timed out. The browser may be slow. Try: 1) Check linkedin.session.health, 2) Reduce operation scope, 3) Retry.",
    TARGET_NOT_FOUND:
      "The requested LinkedIn resource was not found. Verify the URL or identifier is correct and the target exists.",
    ACTION_PRECONDITION_FAILED:
      "Input validation failed. Check the error details for the specific field and expected format.",
  };

  return hints[code];
}

export function toErrorResult(error: unknown): ToolErrorResult {
  const payload = toLinkedInBuddyErrorPayload(error, mcpPrivacyConfig);
  const hint = getRecoveryHint(payload.code);

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { ...payload, ...(hint ? { recovery_hint: hint } : {}) },
          null,
          2,
        ),
      },
    ],
  };
}

export function shouldTrackMcpFeedback(toolName: string): boolean {
  return toolName !== "submit_feedback";
}

export function addFeedbackHintToResult<T extends ToolResult | ToolErrorResult>(
  result: T,
): T {
  const firstContent = result.content[0];
  if (!firstContent || firstContent.type !== "text") {
    return result;
  }

  try {
    const parsed = JSON.parse(firstContent.text) as Record<string, unknown>;
    parsed.feedback_hint = buildFeedbackHintMessage();

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
