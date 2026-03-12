import { LinkedInBuddyError } from "@linkedin-buddy/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toolResultsCoreMocks = vi.hoisted(() => ({
  buildFeedbackHintMessage: vi.fn(),
  redactStructuredValue: vi.fn(),
  resolvePrivacyConfig: vi.fn(),
  toLinkedInBuddyErrorPayload: vi.fn(),
}));

vi.mock("@linkedin-buddy/core", async () => {
  const actual = await vi.importActual<typeof import("@linkedin-buddy/core")>(
    "@linkedin-buddy/core",
  );

  return {
    ...actual,
    buildFeedbackHintMessage: toolResultsCoreMocks.buildFeedbackHintMessage,
    redactStructuredValue: toolResultsCoreMocks.redactStructuredValue,
    resolvePrivacyConfig: toolResultsCoreMocks.resolvePrivacyConfig,
    toLinkedInBuddyErrorPayload:
      toolResultsCoreMocks.toLinkedInBuddyErrorPayload,
  };
});

import {
  addFeedbackHintToResult,
  buildRecoveryHint,
  mcpPrivacyConfig,
  shouldTrackMcpFeedback,
  toErrorResult,
  toToolResult,
  type ToolErrorResult,
  type ToolResult,
} from "../toolResults.js";

describe("toolResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolResultsCoreMocks.resolvePrivacyConfig.mockReturnValue({
      redact: true,
    });
    toolResultsCoreMocks.redactStructuredValue.mockImplementation(
      (value: unknown) => value,
    );
    toolResultsCoreMocks.toLinkedInBuddyErrorPayload.mockReturnValue({
      code: "UNKNOWN_ERROR",
      message: "oops",
    });
    toolResultsCoreMocks.buildFeedbackHintMessage.mockReturnValue(
      "share feedback",
    );
  });

  describe("toToolResult", () => {
    it("returns text content with JSON stringified redacted payload", () => {
      const payload = { ok: true, nested: { count: 2 } };
      toolResultsCoreMocks.redactStructuredValue.mockReturnValue({
        ok: true,
        nested: { count: 2 },
        redacted: true,
      });

      const result = toToolResult(payload);

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                nested: { count: 2 },
                redacted: true,
              },
              null,
              2,
            ),
          },
        ],
      });
      expect(toolResultsCoreMocks.redactStructuredValue).toHaveBeenCalledWith(
        payload,
        mcpPrivacyConfig,
        "cli",
      );
    });
  });

  describe("buildRecoveryHint", () => {
    it("returns a generic hint for non-LinkedInBuddyError errors", () => {
      const hint = buildRecoveryHint(new Error("something"));
      expect(hint).toBe(
        "An unexpected error occurred. Check linkedin.session.status to verify your session is active.",
      );
    });

    it("returns specific hints for known error codes", () => {
      expect(
        buildRecoveryHint(
          new LinkedInBuddyError("AUTH_REQUIRED", "auth needed"),
        ),
      ).toContain("linkedin.session.open_login");

      expect(
        buildRecoveryHint(
          new LinkedInBuddyError("CAPTCHA_OR_CHALLENGE", "captcha"),
        ),
      ).toContain("security challenge");

      expect(
        buildRecoveryHint(
          new LinkedInBuddyError("RATE_LIMITED", "rate limited"),
        ),
      ).toContain("rate limit");

      expect(
        buildRecoveryHint(
          new LinkedInBuddyError(
            "UI_CHANGED_SELECTOR_FAILED",
            "selector failed",
          ),
        ),
      ).toContain("page layout");

      expect(
        buildRecoveryHint(
          new LinkedInBuddyError("NETWORK_ERROR", "network issue"),
        ),
      ).toContain("internet connection");

      expect(
        buildRecoveryHint(new LinkedInBuddyError("TIMEOUT", "timed out")),
      ).toContain("timed out");

      expect(
        buildRecoveryHint(
          new LinkedInBuddyError("TARGET_NOT_FOUND", "not found"),
        ),
      ).toContain("not found");

      expect(
        buildRecoveryHint(
          new LinkedInBuddyError(
            "ACTION_PRECONDITION_FAILED",
            "precondition failed",
          ),
        ),
      ).toContain("precondition");
    });

    it("returns undefined for unknown LinkedInBuddyError codes", () => {
      expect(
        buildRecoveryHint(
          new LinkedInBuddyError(
            "SOME_UNKNOWN_CODE" as "AUTH_REQUIRED",
            "unknown",
          ),
        ),
      ).toBeUndefined();
    });
  });

  describe("toErrorResult", () => {
    it("returns isError result with recovery_hint for known error codes", () => {
      const sourceError = new LinkedInBuddyError(
        "AUTH_REQUIRED",
        "Authenticate",
      );
      toolResultsCoreMocks.toLinkedInBuddyErrorPayload.mockReturnValue({
        code: "AUTH_REQUIRED",
        message: "Authenticate",
      });

      const result = toErrorResult(sourceError);
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<
        string,
        unknown
      >;

      expect(result.isError).toBe(true);
      expect(payload.code).toBe("AUTH_REQUIRED");
      expect(payload.recovery_hint).toContain("linkedin.session.open_login");
      expect(
        toolResultsCoreMocks.toLinkedInBuddyErrorPayload,
      ).toHaveBeenCalledWith(sourceError, mcpPrivacyConfig);
    });

    it("includes recovery_hint for non-LinkedInBuddyError instances", () => {
      toolResultsCoreMocks.toLinkedInBuddyErrorPayload.mockReturnValue({
        code: "UNKNOWN_ERROR",
        message: "Unhandled",
      });

      const result = toErrorResult(new Error("Unhandled"));
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<
        string,
        unknown
      >;

      expect(result.isError).toBe(true);
      expect(payload.recovery_hint).toBe(
        "An unexpected error occurred. Check linkedin.session.status to verify your session is active.",
      );
    });

    it("omits recovery_hint for unknown LinkedInBuddyError codes", () => {
      const unknownError = new LinkedInBuddyError(
        "SOME_UNKNOWN_CODE" as "AUTH_REQUIRED",
        "Unknown",
      );
      toolResultsCoreMocks.toLinkedInBuddyErrorPayload.mockReturnValue({
        code: "SOME_UNKNOWN_CODE",
        message: "Unknown",
      });

      const result = toErrorResult(unknownError);
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<
        string,
        unknown
      >;

      expect(result.isError).toBe(true);
      expect(payload.recovery_hint).toBeUndefined();
    });
  });

  describe("shouldTrackMcpFeedback", () => {
    it("returns false for submit_feedback and true for other tools", () => {
      expect(shouldTrackMcpFeedback("submit_feedback")).toBe(false);
      expect(shouldTrackMcpFeedback("linkedin.session.health")).toBe(true);
    });
  });

  describe("addFeedbackHintToResult", () => {
    it("adds feedback_hint to text JSON payload", () => {
      const result: ToolResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true }),
          },
        ],
      };

      const updated = addFeedbackHintToResult(result);
      const payload = JSON.parse(updated.content[0]?.text ?? "{}") as Record<
        string,
        unknown
      >;

      expect(payload.ok).toBe(true);
      expect(payload.feedback_hint).toBe("share feedback");
      expect(
        toolResultsCoreMocks.buildFeedbackHintMessage,
      ).toHaveBeenCalledTimes(1);
    });

    it("returns original result for non-text content", () => {
      const nonTextResult = {
        content: [{ type: "image", text: "ignored" }],
      } as unknown as ToolErrorResult;

      const updated = addFeedbackHintToResult(nonTextResult);

      expect(updated).toBe(nonTextResult);
      expect(
        toolResultsCoreMocks.buildFeedbackHintMessage,
      ).not.toHaveBeenCalled();
    });

    it("returns original result when content text is invalid JSON", () => {
      const result: ToolResult = {
        content: [{ type: "text", text: "not json" }],
      };

      const updated = addFeedbackHintToResult(result);

      expect(updated).toBe(result);
      expect(
        toolResultsCoreMocks.buildFeedbackHintMessage,
      ).not.toHaveBeenCalled();
    });
  });
});
