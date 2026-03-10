import { describe, expect, it } from "vitest";
import {
  CAPTCHA_SELECTORS,
  CHARS_PER_WORD,
  HONEYPOT_SELECTORS,
  MAX_BEZIER_STEPS,
  MAX_BLUR_DURATION_MS,
  MAX_DRIFT_COUNT,
  MAX_DRIFT_RADIUS_PX,
  MAX_READING_WPM,
  MAX_SCROLL_DISTANCE_PX,
  MAX_SCROLL_STEPS,
  MIN_BEZIER_STEPS,
  MIN_BLUR_DURATION_MS,
  MIN_DRIFT_COUNT,
  MIN_SCROLL_STEPS,
  clamp
} from "../evasion/shared.js";

describe("shared evasion constants", () => {
  it("clamps values into inclusive bounds", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("defines sane numeric guardrails", () => {
    expect(MIN_BEZIER_STEPS).toBeLessThan(MAX_BEZIER_STEPS);
    expect(MIN_SCROLL_STEPS).toBeLessThan(MAX_SCROLL_STEPS);
    expect(MIN_DRIFT_COUNT).toBeLessThan(MAX_DRIFT_COUNT);
    expect(MIN_BLUR_DURATION_MS).toBeLessThan(MAX_BLUR_DURATION_MS);
    expect(MAX_DRIFT_RADIUS_PX).toBeGreaterThan(0);
    expect(MAX_SCROLL_DISTANCE_PX).toBeGreaterThan(0);
    expect(MAX_READING_WPM).toBeGreaterThan(0);
    expect(CHARS_PER_WORD).toBeGreaterThan(0);
  });

  it("keeps captcha and honeypot selectors unique and populated", () => {
    expect(CAPTCHA_SELECTORS.length).toBeGreaterThan(0);
    expect(HONEYPOT_SELECTORS.length).toBeGreaterThan(0);
    expect(new Set(CAPTCHA_SELECTORS).size).toBe(CAPTCHA_SELECTORS.length);
    expect(new Set(HONEYPOT_SELECTORS).size).toBe(HONEYPOT_SELECTORS.length);
    expect(CAPTCHA_SELECTORS).toContain("[data-sitekey]");
    expect(HONEYPOT_SELECTORS).toContain("input[tabindex='-1']");
  });
});
