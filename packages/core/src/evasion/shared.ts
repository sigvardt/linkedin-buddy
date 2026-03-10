export const MIN_BEZIER_STEPS = 2;
export const MAX_BEZIER_STEPS = 200;
export const MIN_SCROLL_STEPS = 2;
export const MAX_SCROLL_STEPS = 20;
export const MIN_DRIFT_COUNT = 1;
export const MAX_DRIFT_COUNT = 20;
export const MAX_DRIFT_RADIUS_PX = 100;
export const MIN_BLUR_DURATION_MS = 100;
export const MAX_BLUR_DURATION_MS = 30_000;
export const MAX_SCROLL_DISTANCE_PX = 20_000;
export const MAX_READING_WPM = 1_000;
export const CHARS_PER_WORD = 5;

export const CAPTCHA_SELECTORS = [
  "[class*='captcha' i]",
  "[id*='captcha' i]",
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "[class*='hcaptcha' i]",
  "[data-sitekey]"
] as const;

export const HONEYPOT_SELECTORS = [
  "input[style*='display:none']",
  "input[style*='display: none']",
  "input[style*='visibility:hidden']",
  "input[style*='visibility: hidden']",
  "input[tabindex='-1']",
  "input[aria-hidden='true']"
] as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
