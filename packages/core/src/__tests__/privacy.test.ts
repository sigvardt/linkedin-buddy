import { describe, expect, it, vi } from "vitest";
import {
  redactFreeformText,
  redactStructuredValue,
  resolvePrivacyConfig,
  type PrivacyConfig,
} from "../privacy.js";

function config(
  redactionMode: PrivacyConfig["redactionMode"],
  storageMode: PrivacyConfig["storageMode"] = "full",
): PrivacyConfig {
  return {
    redactionMode,
    storageMode,
    hashSalt: "unit-test-salt",
    messageExcerptLength: 10,
  };
}

describe("privacy", () => {
  describe("resolvePrivacyConfig", () => {
    it("uses defaults from env and applies partial overrides", () => {
      const resolved = resolvePrivacyConfig(
        {
          redactionMode: "full",
        },
        {
          LINKEDIN_BUDDY_REDACTION_MODE: "partial",
          LINKEDIN_BUDDY_STORAGE_MODE: "excerpt",
          LINKEDIN_BUDDY_REDACTION_HASH_SALT: "env-salt",
          LINKEDIN_BUDDY_MESSAGE_EXCERPT_LENGTH: "99",
        },
      );

      expect(resolved).toEqual({
        redactionMode: "full",
        storageMode: "excerpt",
        hashSalt: "env-salt",
        messageExcerptLength: 99,
      });
    });

    it("falls back to documented defaults for invalid env values", () => {
      const resolved = resolvePrivacyConfig(
        {},
        {
          LINKEDIN_BUDDY_REDACTION_MODE: "invalid",
          LINKEDIN_BUDDY_STORAGE_MODE: "archive",
          LINKEDIN_BUDDY_MESSAGE_EXCERPT_LENGTH: "NaN",
        },
      );

      expect(resolved.redactionMode).toBe("off");
      expect(resolved.storageMode).toBe("full");
      expect(resolved.messageExcerptLength).toBe(80);
    });

    it("clamps messageExcerptLength override to allowed bounds", () => {
      const low = resolvePrivacyConfig({ messageExcerptLength: -5 }, {});
      const high = resolvePrivacyConfig({ messageExcerptLength: 9_999 }, {});

      expect(low.messageExcerptLength).toBe(8);
      expect(high.messageExcerptLength).toBe(512);
    });

    it("normalizes env casing and trims whitespace", () => {
      const resolved = resolvePrivacyConfig(
        {},
        {
          LINKEDIN_BUDDY_REDACTION_MODE: "  PARTIAL  ",
          LINKEDIN_BUDDY_STORAGE_MODE: " ExCerPt ",
        },
      );

      expect(resolved.redactionMode).toBe("partial");
      expect(resolved.storageMode).toBe("excerpt");
    });
  });

  describe("redactFreeformText", () => {
    it("redacts emails and LinkedIn profile URLs", () => {
      const redacted = redactFreeformText(
        "Contact me at owner@example.com or https://www.linkedin.com/in/jane-doe/",
        config("partial"),
      );

      expect(redacted).toContain("email#");
      expect(redacted).toContain("profile#");
      expect(redacted).not.toContain("owner@example.com");
      expect(redacted).not.toContain("jane-doe");
    });

    it("redacts supported action-summary subjects", () => {
      const redacted = redactFreeformText(
        'Send message to "Jane Doe"',
        config("partial"),
      );
      expect(redacted).toMatch(/^Send message to "person#[A-Za-z0-9_-]{12}"$/);
    });

    it("redacts profile quoted names in generic messages", () => {
      const redacted = redactFreeformText(
        'Failed to load profile "Jane Doe"',
        config("partial"),
      );
      expect(redacted).toMatch(
        /^Failed to load profile "person#[A-Za-z0-9_-]{12}"$/,
      );
    });

    it("leaves plain text unchanged when no sensitive patterns are present", () => {
      const source = "System ready for health check.";
      expect(redactFreeformText(source, config("partial"))).toBe(source);
    });
  });

  describe("redactStructuredValue", () => {
    it("applies key-specific redaction rules even in off mode", () => {
      const input = {
        full_name: "Jane Doe",
        email: "owner@example.com",
        messages: [{ text: "Hello Jane Doe" }],
      };

      const output = redactStructuredValue(input, config("off"), "log");

      expect(output.full_name).toBe("Jane Doe");
      expect(String(output.email)).toMatch(/^email#[A-Za-z0-9_-]{12}$/);
      expect(String(output.messages[0]?.text)).toContain("person#");
    });

    it("hashes explicit name keys in partial mode", () => {
      const output = redactStructuredValue(
        {
          author_name: "Jane Doe",
          target_profile: "Jane Doe",
        },
        config("partial"),
        "cli",
      );

      expect(String(output.author_name)).toMatch(/^person#[A-Za-z0-9_-]{12}$/);
      expect(String(output.target_profile)).toMatch(
        /^person#[A-Za-z0-9_-]{12}$/,
      );
    });

    it("hashes inbox thread title and name contextually", () => {
      const output = redactStructuredValue(
        {
          thread_id: "thread-1",
          title: "Jane Doe",
          participant: {
            profile_url: "https://www.linkedin.com/in/jane-doe/",
            name: "Jane Doe",
          },
        },
        config("partial"),
        "artifact",
      );

      expect(String(output.title)).toMatch(/^person#[A-Za-z0-9_-]{12}$/);
      expect(String((output.participant as { name: string }).name)).toMatch(
        /^person#[A-Za-z0-9_-]{12}$/,
      );
      expect(
        String((output.participant as { profile_url: string }).profile_url),
      ).toContain("profile#");
    });

    it("redacts notification message text as excerpt in partial mode", () => {
      const output = redactStructuredValue(
        {
          notifications: [
            {
              timestamp: "now",
              is_read: false,
              link: "https://www.linkedin.com/notifications/1/",
              message: "Hi Jane Doe, contact jane@example.com",
            },
          ],
        },
        config("partial"),
        "error",
      );

      const message = (output.notifications as Array<{ message: string }>)[0]
        ?.message;
      expect(message).toContain("… [len=");
      expect(message).toContain("hash=");
      expect(message).not.toContain("jane@example.com");
    });

    it("fully redacts message body in full mode", () => {
      const output = redactStructuredValue(
        {
          body: "This is very sensitive body text",
        },
        config("full"),
        "storage",
      );

      expect(String(output.body)).toMatch(
        /^\[redacted len=\d+ hash=[A-Za-z0-9_-]{12}\]$/,
      );
    });

    it("uses excerpt redaction for storage mode excerpt even when redaction mode is off", () => {
      const output = redactStructuredValue(
        {
          body: "Message body still needs excerpting",
        },
        config("off", "excerpt"),
        "storage",
      );

      expect(String(output.body)).toContain("… [len=");
      expect(String(output.body)).toContain("hash=");
    });

    it("redacts nested arrays and keeps non-string values intact", () => {
      const transform = vi.fn(() =>
        redactStructuredValue(
          {
            outbound: {
              messages: [
                {
                  author: "Jane Doe",
                  text: "Hello jane@example.com",
                  attempts: 3,
                  success: false,
                },
              ],
            },
          },
          config("partial"),
          "cli",
        ),
      );

      const output = transform();
      const firstMessage = (
        output.outbound as { messages: Array<Record<string, unknown>> }
      ).messages[0];

      expect(String(firstMessage.author)).toMatch(/^person#[A-Za-z0-9_-]{12}$/);
      expect(String(firstMessage.text)).toContain("… [len=");
      expect(firstMessage.attempts).toBe(3);
      expect(firstMessage.success).toBe(false);
      expect(transform).toHaveBeenCalledOnce();
    });
  });

  describe("false-positive name detection (issue #477)", () => {
    /**
     * Helper: run text through the message-text redaction path by wrapping it
     * in a structure whose key ("text") is in MESSAGE_KEYS.  Using
     * redactionMode "off" avoids excerpt truncation so we can inspect the
     * full sanitised string.
     */
    function redactMessageText(text: string): string {
      const output = redactStructuredValue(
        { messages: [{ text }] },
        config("off"),
        "cli",
      );
      return String(
        (output.messages as Array<{ text: string }>)[0]?.text,
      );
    }

    it("does not redact common words that look like capitalised pairs", () => {
      const result = redactMessageText(
        "Between AI startups and sustainable innovation",
      );
      expect(result).not.toContain("person#");
      expect(result).toContain("Between AI");
    });

    it("does not redact greeting + city name", () => {
      const result = redactMessageText(
        "Fellow Copenhagen tech enthusiast here",
      );
      expect(result).not.toContain("person#");
      expect(result).toContain("Fellow Copenhagen");
    });

    it("does not redact ALL-CAPS acronyms paired with other words", () => {
      const result = redactMessageText(
        "The CEO announced an AI Strategy today",
      );
      expect(result).not.toContain("person#");
      expect(result).toContain("CEO");
      expect(result).toContain("AI Strategy");
    });

    it("does not redact professional terms paired with capitalised words", () => {
      const result = redactMessageText(
        "Senior Engineer at Global Marketing",
      );
      expect(result).not.toContain("person#");
    });

    it("does not redact geographic names paired with other words", () => {
      const result = redactMessageText(
        "Based Stockholm with Looking Forward attitude",
      );
      expect(result).not.toContain("person#");
    });

    it("still redacts actual person names", () => {
      const result = redactMessageText("Contact Jane Doe for details");
      expect(result).toContain("person#");
      expect(result).not.toContain("Jane Doe");
    });

    it("redacts real name after skipping a false-positive first word", () => {
      const result = redactMessageText("Hello Jane Doe from Copenhagen");
      expect(result).toContain("person#");
      expect(result).not.toContain("Jane Doe");
      // "Hello" should survive — it is NOT a name
      expect(result).toContain("Hello");
      // "Copenhagen" should survive — it is a city, not a name
      expect(result).toContain("Copenhagen");
    });

    it("redacts multiple real names in the same text", () => {
      const result = redactMessageText(
        "Met Jane Doe and Simon Miller at the event",
      );
      expect(result).not.toContain("Jane Doe");
      expect(result).not.toContain("Simon Miller");
      // Two separate person# tokens
      const personTokens = result.match(/person#/g);
      expect(personTokens).toHaveLength(2);
    });

    it("does not redact when both words are false positives", () => {
      const result = redactMessageText(
        "Looking Forward to our next meeting",
      );
      expect(result).not.toContain("person#");
    });
  });

});
