import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRateLimitState,
  isInRateLimitCooldown,
  readRateLimitState,
  recordRateLimit,
  writeRateLimitState,
  type RateLimitState
} from "../src/index.js";

const HOUR_MS = 60 * 60 * 1_000;
const BACKOFF_TOLERANCE_MS = 10_000;

function getBackoffMs(state: RateLimitState): number {
  return (
    new Date(state.rateLimitedUntil).getTime() -
    new Date(state.detectedAt).getTime()
  );
}

function expectBackoffHours(state: RateLimitState, hours: number): void {
  const expectedMs = hours * HOUR_MS;
  const actualMs = getBackoffMs(state);
  expect(actualMs).toBeGreaterThanOrEqual(expectedMs - BACKOFF_TOLERANCE_MS);
  expect(actualMs).toBeLessThanOrEqual(expectedMs + BACKOFF_TOLERANCE_MS);
}

describe("rate limit state", () => {
  let tempDir = "";
  let stateFilePath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-rate-limit-"));
    stateFilePath = path.join(tempDir, "nested", "rate-limit-state.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("readRateLimitState returns null when file does not exist", async () => {
    const state = await readRateLimitState(stateFilePath);
    expect(state).toBeNull();
  });

  it("writeRateLimitState creates the file and readRateLimitState returns it", async () => {
    const expected: RateLimitState = {
      detectedAt: "2026-02-23T00:00:00.000Z",
      rateLimitedUntil: "2026-02-23T02:00:00.000Z",
      consecutiveRateLimits: 1
    };

    await writeRateLimitState(expected, stateFilePath);
    const actual = await readRateLimitState(stateFilePath);
    expect(actual).toEqual(expected);
  });

  it("clearRateLimitState removes the state file", async () => {
    const expected: RateLimitState = {
      detectedAt: "2026-02-23T00:00:00.000Z",
      rateLimitedUntil: "2026-02-23T02:00:00.000Z",
      consecutiveRateLimits: 1
    };

    await writeRateLimitState(expected, stateFilePath);
    await clearRateLimitState(stateFilePath);
    const cleared = await readRateLimitState(stateFilePath);
    expect(cleared).toBeNull();
  });

  it("isInRateLimitCooldown returns active false when no state exists", async () => {
    const result = await isInRateLimitCooldown(stateFilePath);
    expect(result).toEqual({
      active: false,
      state: null
    });
  });

  it("isInRateLimitCooldown returns active true when rateLimitedUntil is in the future", async () => {
    const state: RateLimitState = {
      detectedAt: new Date(Date.now() - HOUR_MS).toISOString(),
      rateLimitedUntil: new Date(Date.now() + HOUR_MS).toISOString(),
      consecutiveRateLimits: 1
    };

    await writeRateLimitState(state, stateFilePath);
    const result = await isInRateLimitCooldown(stateFilePath);
    expect(result.active).toBe(true);
    expect(result.state).toEqual(state);
  });

  it("isInRateLimitCooldown returns active false when rateLimitedUntil is in the past", async () => {
    const state: RateLimitState = {
      detectedAt: new Date(Date.now() - 4 * HOUR_MS).toISOString(),
      rateLimitedUntil: new Date(Date.now() - HOUR_MS).toISOString(),
      consecutiveRateLimits: 1
    };

    await writeRateLimitState(state, stateFilePath);
    const result = await isInRateLimitCooldown(stateFilePath);
    expect(result.active).toBe(false);
    expect(result.state).toEqual(state);
  });

  it("recordRateLimit creates state with first-call 2 hour backoff", async () => {
    const state = await recordRateLimit(stateFilePath);
    expect(state.consecutiveRateLimits).toBe(1);
    expectBackoffHours(state, 2);
  });

  it("recordRateLimit increments consecutive count and increases backoff", async () => {
    const first = await recordRateLimit(stateFilePath);
    const second = await recordRateLimit(stateFilePath);

    expect(first.consecutiveRateLimits).toBe(1);
    expect(second.consecutiveRateLimits).toBe(2);
    expectBackoffHours(second, 4);
    expect(getBackoffMs(second)).toBeGreaterThan(getBackoffMs(first));
  });

  it("recordRateLimit caps backoff at 8 hours after 3+ calls", async () => {
    const first = await recordRateLimit(stateFilePath);
    const second = await recordRateLimit(stateFilePath);
    const third = await recordRateLimit(stateFilePath);
    const fourth = await recordRateLimit(stateFilePath);

    expect(first.consecutiveRateLimits).toBe(1);
    expect(second.consecutiveRateLimits).toBe(2);
    expect(third.consecutiveRateLimits).toBe(3);
    expect(fourth.consecutiveRateLimits).toBe(4);
    expectBackoffHours(third, 8);
    expectBackoffHours(fourth, 8);
  });

  it("clearRateLimitState does not throw when file does not exist", async () => {
    await expect(clearRateLimitState(stateFilePath)).resolves.toBeUndefined();
  });

  it("readRateLimitState returns null for corrupted JSON", async () => {
    await writeRateLimitState(
      {
        detectedAt: "2026-02-23T00:00:00.000Z",
        rateLimitedUntil: "2026-02-23T02:00:00.000Z",
        consecutiveRateLimits: 1
      },
      stateFilePath
    );

    // Overwrite with garbage
    const { writeFile } = await import("node:fs/promises");
    await writeFile(stateFilePath, "not valid json{{{", "utf8");

    const state = await readRateLimitState(stateFilePath);
    expect(state).toBeNull();
  });

  it("readRateLimitState returns null for valid JSON with missing fields", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = path.dirname(stateFilePath);
    await mkdir(dir, { recursive: true });
    await writeFile(
      stateFilePath,
      JSON.stringify({ rateLimitedUntil: "2026-02-23T02:00:00.000Z" }),
      "utf8"
    );

    const state = await readRateLimitState(stateFilePath);
    expect(state).toBeNull();
  });

  it("readRateLimitState returns null for zero consecutiveRateLimits", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = path.dirname(stateFilePath);
    await mkdir(dir, { recursive: true });
    await writeFile(
      stateFilePath,
      JSON.stringify({
        rateLimitedUntil: "2026-02-23T02:00:00.000Z",
        detectedAt: "2026-02-23T00:00:00.000Z",
        consecutiveRateLimits: 0
      }),
      "utf8"
    );

    const state = await readRateLimitState(stateFilePath);
    expect(state).toBeNull();
  });
});
