import { describe, expect, it } from "vitest";
import { EVASION_LEVELS, EVASION_PROFILES } from "../evasion.js";

const EVASION_PROFILE_KEYS = [
  "bezierMouseMovement",
  "mouseOvershootFactor",
  "mouseJitterRadius",
  "momentumScroll",
  "simulateTabBlur",
  "simulateViewportResize",
  "idleDriftEnabled",
  "readingPauseWpm",
  "poissonIntervals",
  "fingerprintHardening"
] as const;

describe("evasion runtime contracts", () => {
  it("keeps the runtime profile map aligned with the supported levels", () => {
    expect(Object.keys(EVASION_PROFILES)).toEqual([...EVASION_LEVELS]);
  });

  it("gives every profile the full public contract surface", () => {
    const expectedKeys = [...EVASION_PROFILE_KEYS].sort();

    for (const profile of Object.values(EVASION_PROFILES)) {
      expect(Object.keys(profile).sort()).toEqual(expectedKeys);
    }
  });
});
