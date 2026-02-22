export const LINKEDIN_ASSISTANT_ERROR_CODES = [
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

export type LinkedInAssistantErrorCode =
  (typeof LINKEDIN_ASSISTANT_ERROR_CODES)[number];

export interface LinkedInAssistantErrorPayload {
  code: LinkedInAssistantErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export class LinkedInAssistantError extends Error {
  readonly code: LinkedInAssistantErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: LinkedInAssistantErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "LinkedInAssistantError";
    this.code = code;
    this.details = details;
  }
}

function summarizeUnknownError(error: unknown): Record<string, unknown> {
  if (error instanceof LinkedInAssistantError) {
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

export function toLinkedInAssistantErrorPayload(
  error: unknown
): LinkedInAssistantErrorPayload {
  if (error instanceof LinkedInAssistantError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      code: "UNKNOWN",
      message: error.message,
      details: summarizeUnknownError(error)
    };
  }

  return {
    code: "UNKNOWN",
    message: String(error),
    details: summarizeUnknownError(error)
  };
}

export { toLinkedInAssistantErrorPayload as toAssistantErrorPayload };

export function asLinkedInAssistantError(
  error: unknown,
  fallbackCode: LinkedInAssistantErrorCode = "UNKNOWN",
  fallbackMessage: string = "Unexpected LinkedIn assistant error."
): LinkedInAssistantError {
  if (error instanceof LinkedInAssistantError) {
    return error;
  }

  if (error instanceof Error) {
    return new LinkedInAssistantError(
      fallbackCode,
      error.message || fallbackMessage,
      summarizeUnknownError(error),
      { cause: error }
    );
  }

  return new LinkedInAssistantError(
    fallbackCode,
    fallbackMessage,
    summarizeUnknownError(error)
  );
}
