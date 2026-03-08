import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSchedulerConfig } from "../src/index.js";

const SCHEDULER_ENV_KEYS = [
  "LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE",
  "LINKEDIN_ASSISTANT_SCHEDULER_MAX_JOBS_PER_TICK",
  "LINKEDIN_ASSISTANT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE"
] as const;

describe("resolveSchedulerConfig", () => {
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    previousEnv.clear();
    for (const key of SCHEDULER_ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SCHEDULER_ENV_KEYS) {
      const previousValue = previousEnv.get(key);
      if (typeof previousValue === "string") {
        process.env[key] = previousValue;
      } else {
        delete process.env[key];
      }
    }
  });

  it("rejects invalid scheduler timezones", () => {
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE = "Mars/Olympus";

    expect(() => resolveSchedulerConfig()).toThrowError(
      /must be a valid IANA timezone/i
    );
  });

  it("rejects per-tick limits that exceed the per-profile active job cap", () => {
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_MAX_JOBS_PER_TICK = "5";
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE = "4";

    expect(() => resolveSchedulerConfig()).toThrowError(
      /must not exceed the per-profile active job limit/i
    );
  });

  it("parses the per-profile active job cap from the environment", () => {
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE = "7";

    expect(resolveSchedulerConfig().maxActiveJobsPerProfile).toBe(7);
  });
});
