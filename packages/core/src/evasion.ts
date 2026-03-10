export { applyFingerprintHardening, detectCaptcha, findHoneypotFields, simulateIdleDrift, simulateMomentumScroll, simulateTabBlur, simulateViewportJitter } from "./evasion/browser.js";
export {
  computeBezierPath,
  computeMomentumSteps,
  computeReadingPauseMs,
  resolveIntervalMs,
  samplePoissonInterval
} from "./evasion/math.js";
export {
  createEvasionStatus,
  DEFAULT_EVASION_LEVEL,
  describeEvasionLevel,
  EVASION_LEVELS,
  EVASION_PROFILES,
  getDisabledEvasionFeatures,
  getEnabledEvasionFeatures,
  isEvasionLevel,
  resolveEvasionLevel,
  resolveEvasionProfile
} from "./evasion/profiles.js";
export { EvasionSession } from "./evasion/session.js";
export type {
  BezierPathOptions,
  EvasionConfigSource,
  EvasionDiagnosticsLogger,
  EvasionFeatureName,
  EvasionLevel,
  EvasionProfile,
  EvasionSessionOptions,
  EvasionStatus,
  IntervalSampleOptions,
  Point2D
} from "./evasion/types.js";
