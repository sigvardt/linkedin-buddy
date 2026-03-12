import { describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_BUDDY_ERROR_CODES,
  LinkedInBuddyError,
  asLinkedInBuddyError,
  toLinkedInBuddyErrorPayload,
} from "../errors.js";

describe("errors", () => {
  it("exports all supported LinkedIn Buddy error codes", () => {
    expect(LINKEDIN_BUDDY_ERROR_CODES).toEqual([
      "AUTH_REQUIRED",
      "CAPTCHA_OR_CHALLENGE",
      "RATE_LIMITED",
      "UI_CHANGED_SELECTOR_FAILED",
      "NETWORK_ERROR",
      "TIMEOUT",
      "TARGET_NOT_FOUND",
      "ACTION_PRECONDITION_FAILED",
      "UNKNOWN",
    ]);
  });

  it("constructs LinkedInBuddyError for every known code", () => {
    for (const code of LINKEDIN_BUDDY_ERROR_CODES) {
      const error = new LinkedInBuddyError(code, `message-${code}`, {
        marker: code,
      });

      expect(error.name).toBe("LinkedInBuddyError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(`message-${code}`);
      expect(error.details).toEqual({ marker: code });
    }
  });

  it("preserves Error cause when provided", () => {
    const cause = new Error("root cause");
    const error = new LinkedInBuddyError(
      "NETWORK_ERROR",
      "network blew up",
      {},
      { cause },
    );

    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("uses empty details by default", () => {
    const error = new LinkedInBuddyError("UNKNOWN", "fallback");
    expect(error.details).toEqual({});
  });

  it("converts LinkedInBuddyError payload without redaction in off mode", () => {
    const error = new LinkedInBuddyError(
      "AUTH_REQUIRED",
      "Email me at owner@example.com",
      {
        participant_name: "Jane Doe",
        contact_email: "owner@example.com",
      },
    );

    const payload = toLinkedInBuddyErrorPayload(error, {
      redactionMode: "off",
      storageMode: "full",
      hashSalt: "salt",
      messageExcerptLength: 10,
    });

    expect(payload).toEqual({
      code: "AUTH_REQUIRED",
      message: "Email me at owner@example.com",
      details: {
        participant_name: "Jane Doe",
        contact_email: "owner@example.com",
      },
    });
  });

  it("redacts LinkedInBuddyError payload in partial mode", () => {
    const error = new LinkedInBuddyError(
      "RATE_LIMITED",
      "Reach me at owner@example.com and /in/jane-doe",
      {
        participant_name: "Jane Doe",
        body: "Hello Jane Doe from message body",
      },
    );

    const payload = toLinkedInBuddyErrorPayload(error, {
      redactionMode: "partial",
      storageMode: "full",
      hashSalt: "salt",
      messageExcerptLength: 5,
    });

    expect(payload.code).toBe("RATE_LIMITED");
    expect(payload.message).toContain("email#");
    expect(payload.message).toContain("profile#");
    expect(String(payload.details.participant_name)).toMatch(
      /^person#[A-Za-z0-9_-]{12}$/,
    );
    expect(String(payload.details.body)).toContain("… [len=");
    expect(String(payload.details.body)).toContain("hash=");
  });

  it("redacts LinkedInBuddyError payload in full mode", () => {
    const error = new LinkedInBuddyError(
      "CAPTCHA_OR_CHALLENGE",
      "owner@example.com",
      {
        body: "Very sensitive message content",
      },
    );

    const payload = toLinkedInBuddyErrorPayload(error, {
      redactionMode: "full",
      storageMode: "full",
      hashSalt: "salt",
      messageExcerptLength: 20,
    });

    expect(payload.message).toContain("email#");
    expect(String(payload.details.body)).toMatch(
      /^\[redacted len=\d+ hash=[A-Za-z0-9_-]{12}\]$/,
    );
  });

  it("converts native Error payload to UNKNOWN code", () => {
    const payload = toLinkedInBuddyErrorPayload(
      new TypeError("Bad email owner@example.com"),
      {
        redactionMode: "partial",
        storageMode: "full",
        hashSalt: "salt",
        messageExcerptLength: 20,
      },
    );

    expect(payload.code).toBe("UNKNOWN");
    expect(payload.message).toContain("email#");
    expect(payload.details).toEqual({
      cause_name: "TypeError",
    });
  });

  it("converts non-Error payloads to UNKNOWN code with raw details", () => {
    const payload = toLinkedInBuddyErrorPayload(404, {
      redactionMode: "off",
      storageMode: "full",
      hashSalt: "salt",
      messageExcerptLength: 20,
    });

    expect(payload).toEqual({
      code: "UNKNOWN",
      message: "404",
      details: {
        raw: "404",
      },
    });
  });

  it("returns the original LinkedInBuddyError in asLinkedInBuddyError", () => {
    const original = new LinkedInBuddyError("TIMEOUT", "timed out", {
      attempt: 2,
    });
    expect(asLinkedInBuddyError(original)).toBe(original);
  });

  it("converts Error into LinkedInBuddyError with fallback code and cause", () => {
    const source = new Error("network timeout");
    const converted = asLinkedInBuddyError(source, "NETWORK_ERROR", "fallback");

    expect(converted).toBeInstanceOf(LinkedInBuddyError);
    expect(converted.code).toBe("NETWORK_ERROR");
    expect(converted.message).toBe("network timeout");
    expect(converted.details).toEqual({ cause_name: "Error" });
    expect((converted as Error & { cause?: unknown }).cause).toBe(source);
  });

  it("uses fallback message when converting Error with empty message", () => {
    const source = new Error("");
    const converted = asLinkedInBuddyError(
      source,
      "ACTION_PRECONDITION_FAILED",
      "fallback message",
    );

    expect(converted.message).toBe("fallback message");
  });

  it("converts non-Error values into LinkedInBuddyError", () => {
    const mapper = vi.fn((value: unknown) =>
      asLinkedInBuddyError(value, "TARGET_NOT_FOUND", "missing target"),
    );

    const converted = mapper({ id: 123 });

    expect(converted.code).toBe("TARGET_NOT_FOUND");
    expect(converted.message).toBe("missing target");
    expect(converted.details).toEqual({ raw: "[object Object]" });
    expect(mapper).toHaveBeenCalledOnce();
  });
});
