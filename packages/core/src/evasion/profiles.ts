import type { EvasionLevel, EvasionProfile } from "./types.js";

/**
 * Predefined detection-evasion profiles ordered by intensity.
 *
 * Most production workflows should use `"moderate"`. Reserve `"paranoid"` for
 * environments with aggressive bot detection.
 */
export const EVASION_PROFILES: Readonly<Record<EvasionLevel, EvasionProfile>> = {
  minimal: {
    bezierMouseMovement: false,
    mouseOvershootFactor: 0,
    mouseJitterRadius: 0,
    momentumScroll: false,
    simulateTabBlur: false,
    simulateViewportResize: false,
    idleDriftEnabled: false,
    readingPauseWpm: 0,
    poissonIntervals: false,
    fingerprintHardening: false
  },
  moderate: {
    bezierMouseMovement: true,
    mouseOvershootFactor: 0.15,
    mouseJitterRadius: 3,
    momentumScroll: true,
    simulateTabBlur: false,
    simulateViewportResize: false,
    idleDriftEnabled: true,
    readingPauseWpm: 230,
    poissonIntervals: true,
    fingerprintHardening: true
  },
  paranoid: {
    bezierMouseMovement: true,
    mouseOvershootFactor: 0.25,
    mouseJitterRadius: 6,
    momentumScroll: true,
    simulateTabBlur: true,
    simulateViewportResize: true,
    idleDriftEnabled: true,
    readingPauseWpm: 200,
    poissonIntervals: true,
    fingerprintHardening: true
  }
};
