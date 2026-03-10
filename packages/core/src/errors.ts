import {
  redactFreeformText,
  redactStructuredValue,
  resolvePrivacyConfig,
  type PrivacyConfig
} from "./privacy.js";

export const LINKEDIN_BUDDY_ERROR_CODES = [
  "AUTH_REQUIRED",
  "CAPTCHA_OR_CHALLENGE",
  "RATE_LIMITED",
  "UI_CHANGED_SELECTOR_FAILED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "TARGET_NOT_FOUND",
  "ACTION_PRECONDITION_FAILED",
  "UNKNOWN"
] as const;

export type LinkedInBuddyErrorCode =
  (typeof LINKEDIN_BUDDY_ERROR_CODES)[number];

export interface LinkedInBuddyErrorPayload {
  code: LinkedInBuddyErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export class LinkedInBuddyError extends Error {
  readonly code: LinkedInBuddyErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: LinkedInBuddyErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "LinkedInBuddyError";
    this.code = code;
    this.details = details;
  }
}

function summarizeUnknownError(error: unknown): Record<string, unknown> {
  if (error instanceof LinkedInBuddyError) {
    return error.details;
  }

  if (error instanceof Error) {
    return {
      cause_name: error.name
    };
  }

  return {
    raw: String(error)
  };
}

export function toLinkedInBuddyErrorPayload(
  error: unknown,
  privacy?: Partial<PrivacyConfig>
): LinkedInBuddyErrorPayload {
  const privacyConfig = resolvePrivacyConfig(privacy);

  if (error instanceof LinkedInBuddyError) {
    return {
      code: error.code,
      message:
        privacyConfig.redactionMode === "off"
          ? error.message
          : redactFreeformText(error.message, privacyConfig),
      details: redactStructuredValue(error.details, privacyConfig, "error")
    };
  }

  if (error instanceof Error) {
    return {
      code: "UNKNOWN",
      message:
        privacyConfig.redactionMode === "off"
          ? error.message
          : redactFreeformText(error.message, privacyConfig),
      details: redactStructuredValue(
        summarizeUnknownError(error),
        privacyConfig,
        "error"
      )
    };
  }

  return {
    code: "UNKNOWN",
    message:
      privacyConfig.redactionMode === "off"
        ? String(error)
        : redactFreeformText(String(error), privacyConfig),
    details: redactStructuredValue(
      summarizeUnknownError(error),
      privacyConfig,
      "error"
    )
  };
}

export { toLinkedInBuddyErrorPayload as toAssistantErrorPayload };

export function asLinkedInBuddyError(
  error: unknown,
  fallbackCode: LinkedInBuddyErrorCode = "UNKNOWN",
  fallbackMessage: string = "Unexpected LinkedIn Buddy error."
): LinkedInBuddyError {
  if (error instanceof LinkedInBuddyError) {
    return error;
  }

  if (error instanceof Error) {
    return new LinkedInBuddyError(
      fallbackCode,
      error.message || fallbackMessage,
      summarizeUnknownError(error),
      { cause: error }
    );
  }

  return new LinkedInBuddyError(
    fallbackCode,
    fallbackMessage,
    summarizeUnknownError(error)
  );
}
