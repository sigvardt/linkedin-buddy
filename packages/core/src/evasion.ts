export { applyFingerprintHardening, detectCaptcha, findHoneypotFields, simulateIdleDrift, simulateMomentumScroll, simulateTabBlur, simulateViewportJitter } from "./evasion/browser.js";
export { computeBezierPath, computeReadingPauseMs, samplePoissonInterval } from "./evasion/math.js";
export { EVASION_PROFILES } from "./evasion/profiles.js";
export { EvasionSession } from "./evasion/session.js";
export type {
  BezierPathOptions,
  EvasionLevel,
  EvasionProfile,
  IntervalSampleOptions,
  Point2D
} from "./evasion/types.js";
