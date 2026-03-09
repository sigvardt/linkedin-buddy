import { afterEach, describe, expect, it } from "vitest";
import { resolveActivityWebhookConfig } from "../config.js";
import { LinkedInAssistantError } from "../errors.js";

const ACTIVITY_ENV_KEYS = [
  "LINKEDIN_ASSISTANT_ACTIVITY_ENABLED",
  "LINKEDIN_ASSISTANT_ACTIVITY_MAX_CONCURRENT_WATCHES",
  "LINKEDIN_ASSISTANT_ACTIVITY_MIN_POLL_INTERVAL_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH",
  "LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS"
] as const;

const ORIGINAL_ACTIVITY_ENV = new Map(
  ACTIVITY_ENV_KEYS.map((key) => [key, process.env[key]] as const)
);

function restoreActivityEnv(): void {
  for (const key of ACTIVITY_ENV_KEYS) {
    const originalValue = ORIGINAL_ACTIVITY_ENV.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
}

function captureLinkedInError(action: () => unknown): LinkedInAssistantError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedInAssistantError);
    return error as LinkedInAssistantError;
  }

  throw new Error("Expected LinkedInAssistantError to be thrown.");
}

afterEach(() => {
  restoreActivityEnv();
});

describe("resolveActivityWebhookConfig", () => {
  it("parses hardening env vars for polling resilience", () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_MAX_CONCURRENT_WATCHES = "7";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_MIN_POLL_INTERVAL_SECONDS = "90";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH = "33";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS = "12";

    expect(resolveActivityWebhookConfig()).toMatchObject({
      maxConcurrentWatches: 7,
      minPollIntervalMs: 90_000,
      maxEventQueueDepth: 33,
      clockSkewAllowanceMs: 12_000
    });
  });

  it("rejects invalid activity boolean env values with a clear message", () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_ENABLED = "sometimes";

    const error = captureLinkedInError(() => resolveActivityWebhookConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_ACTIVITY_ENABLED must use a boolean value: 1, 0, true, false, yes, no, on, or off. Unset it to use the default value."
    );
  });

  it("rejects delivery lease settings that do not cover timeout plus clock skew", () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS = "15";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS = "19";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS = "5";

    const error = captureLinkedInError(() => resolveActivityWebhookConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS must be greater than or equal to LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS plus LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS."
    );
  });

  it("rejects watch lease settings that do not exceed clock skew", () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS = "5";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS = "5";

    const error = captureLinkedInError(() => resolveActivityWebhookConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS must be greater than LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS."
    );
  });
});
