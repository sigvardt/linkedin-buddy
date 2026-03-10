import { afterEach, describe, expect, it } from "vitest";
import {
  LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS_ENV,
  LINKEDIN_ASSISTANT_EVASION_LEVEL_ENV,
  resolveActivityWebhookConfig,
  resolveEvasionConfig
} from "../config.js";
import { LinkedInAssistantError } from "../errors.js";

const ACTIVITY_ENV_KEYS = [
  "LINKEDIN_ASSISTANT_ACTIVITY_ENABLED",
  "LINKEDIN_ASSISTANT_ACTIVITY_INITIAL_BACKOFF_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_MAX_BACKOFF_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_MAX_CONCURRENT_WATCHES",
  "LINKEDIN_ASSISTANT_ACTIVITY_MIN_POLL_INTERVAL_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH",
  "LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS",
  "LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS"
] as const;

const EVASION_ENV_KEYS = [
  LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS_ENV,
  LINKEDIN_ASSISTANT_EVASION_LEVEL_ENV
] as const;

const ORIGINAL_ACTIVITY_ENV = new Map(
  ACTIVITY_ENV_KEYS.map((key) => [key, process.env[key]] as const)
);
const ORIGINAL_EVASION_ENV = new Map(
  EVASION_ENV_KEYS.map((key) => [key, process.env[key]] as const)
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

function restoreEvasionEnv(): void {
  for (const key of EVASION_ENV_KEYS) {
    const originalValue = ORIGINAL_EVASION_ENV.get(key);
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
  restoreEvasionEnv();
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
    expect(error.details).toMatchObject({
      default_value: "true",
      env: "LINKEDIN_ASSISTANT_ACTIVITY_ENABLED",
      example: "LINKEDIN_ASSISTANT_ACTIVITY_ENABLED=false"
    });
    expect(String(error.details.suggestion)).toContain("true or false");
  });

  it("rejects delivery lease settings that do not cover timeout plus clock skew", () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS = "15";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS = "19";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS = "5";

    const error = captureLinkedInError(() => resolveActivityWebhookConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS must be greater than or equal to LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_TIMEOUT_SECONDS plus LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS."
    );
    expect(error.details).toMatchObject({
      env: "LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS",
      example: "LINKEDIN_ASSISTANT_ACTIVITY_DELIVERY_LEASE_SECONDS=20"
    });
    expect(String(error.details.suggestion)).toContain("at least 20");
  });

  it("rejects watch lease settings that do not exceed clock skew", () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS = "5";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS = "5";

    const error = captureLinkedInError(() => resolveActivityWebhookConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS must be greater than LINKEDIN_ASSISTANT_ACTIVITY_CLOCK_SKEW_SECONDS."
    );
    expect(error.details).toMatchObject({
      env: "LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS",
      example: "LINKEDIN_ASSISTANT_ACTIVITY_WATCH_LEASE_SECONDS=6"
    });
    expect(String(error.details.suggestion)).toContain("more than 5");
  });

  it("rejects malformed queue-depth values with a concrete example", () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH = "many";

    const error = captureLinkedInError(() => resolveActivityWebhookConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH must be a whole number greater than 0. Unset it to use the default value."
    );
    expect(error.details).toMatchObject({
      default_value: "250",
      env: "LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH",
      example: "LINKEDIN_ASSISTANT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH=500",
      value: "many"
    });
  });

  it("rejects max backoff settings that are below the initial backoff", () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_INITIAL_BACKOFF_SECONDS = "90";
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_MAX_BACKOFF_SECONDS = "60";

    const error = captureLinkedInError(() => resolveActivityWebhookConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_ACTIVITY_MAX_BACKOFF_SECONDS must be greater than or equal to LINKEDIN_ASSISTANT_ACTIVITY_INITIAL_BACKOFF_SECONDS."
    );
    expect(error.details).toMatchObject({
      env: "LINKEDIN_ASSISTANT_ACTIVITY_MAX_BACKOFF_SECONDS",
      example: "LINKEDIN_ASSISTANT_ACTIVITY_MAX_BACKOFF_SECONDS=90"
    });
    expect(String(error.details.suggestion)).toContain("at least 90");
  });
});

describe("resolveEvasionConfig", () => {
  it("returns the documented defaults when no overrides are configured", () => {
    expect(resolveEvasionConfig()).toMatchObject({
      diagnosticsEnabled: false,
      enabledFeatures: [
        "bezier_mouse_movement",
        "momentum_scroll",
        "idle_drift",
        "reading_pauses",
        "poisson_timing",
        "fingerprint_hardening"
      ],
      level: "moderate",
      source: "default"
    });
  });

  it("parses env overrides for the evasion level and diagnostics flag", () => {
    process.env[LINKEDIN_ASSISTANT_EVASION_LEVEL_ENV] = "paranoid";
    process.env[LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS_ENV] = "true";

    expect(resolveEvasionConfig()).toMatchObject({
      diagnosticsEnabled: true,
      enabledFeatures: expect.arrayContaining([
        "tab_blur_simulation",
        "viewport_resize_simulation"
      ]),
      level: "paranoid",
      source: "env"
    });
  });

  it("rejects invalid env evasion levels with a concrete example", () => {
    process.env[LINKEDIN_ASSISTANT_EVASION_LEVEL_ENV] = "aggressive";

    const error = captureLinkedInError(() => resolveEvasionConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_EVASION_LEVEL must be one of minimal, moderate, paranoid. Unset it to use the default value."
    );
    expect(error.details).toMatchObject({
      default_value: "moderate",
      env: LINKEDIN_ASSISTANT_EVASION_LEVEL_ENV,
      example: `${LINKEDIN_ASSISTANT_EVASION_LEVEL_ENV}=paranoid`,
      value: "aggressive"
    });
    expect(String(error.details.suggestion)).toContain("minimal");
  });

  it("rejects malformed diagnostics booleans with clear guidance", () => {
    process.env[LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS_ENV] = "verbose";

    const error = captureLinkedInError(() => resolveEvasionConfig());

    expect(error.message).toBe(
      "LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS must use a boolean value: 1, 0, true, false, yes, no, on, or off. Unset it to use the default value."
    );
    expect(error.details).toMatchObject({
      default_value: "false",
      env: LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS_ENV,
      example: `${LINKEDIN_ASSISTANT_EVASION_DIAGNOSTICS_ENV}=true`
    });
  });
});
