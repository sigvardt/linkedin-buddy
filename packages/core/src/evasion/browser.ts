import type { Page } from "playwright-core";
import { computeMomentumSteps } from "./math.js";
import {
  CAPTCHA_SELECTORS,
  HONEYPOT_SELECTORS,
  MAX_BLUR_DURATION_MS,
  MAX_DRIFT_COUNT,
  MAX_DRIFT_RADIUS_PX,
  MAX_SCROLL_STEPS,
  MIN_BLUR_DURATION_MS,
  MIN_DRIFT_COUNT,
  MIN_SCROLL_STEPS,
  clamp
} from "./shared.js";
import type { EvasionLevel } from "./types.js";

type ScrollBehavior = "auto" | "smooth";

/**
 * Apply navigator and canvas fingerprint hardening to `page` by injecting
 * JavaScript into the current page context.
 *
 * Hardening levels:
 * - `minimal`: no-op.
 * - `moderate`: Removes the `navigator.webdriver` flag.
 * - `paranoid`: All `moderate` hardening plus per-session canvas pixel noise
 *   to reduce canvas fingerprint stability across sessions.
 *
 * @param page - Playwright Page to harden.
 * @param level - Desired evasion level (defaults to `"moderate"`).
 */
export async function applyFingerprintHardening(
  page: Page,
  level: EvasionLevel = "moderate"
): Promise<void> {
  if (level === "minimal") {
    return;
  }

  await applyWebdriverHardening(page);

  if (level === "paranoid") {
    await applyCanvasNoise(page, (Math.random() * 256) | 0);
  }
}

/**
 * Simulate a momentum-based scroll that decelerates over several steps,
 * matching the inertia of a real mouse-wheel or trackpad gesture.
 *
 * @param page - Playwright Page to scroll.
 * @param pixels - Total scroll distance in pixels (positive = down,
 *   negative = up).
 * @param steps - Number of deceleration steps (2–20, default 6).
 */
export async function simulateMomentumScroll(
  page: Page,
  pixels: number,
  steps = 6
): Promise<void> {
  if (pixels === 0) {
    return;
  }

  const totalSteps = clamp(steps, MIN_SCROLL_STEPS, MAX_SCROLL_STEPS);
  for (const amount of computeMomentumSteps(pixels, totalSteps)) {
    await scrollPageBy(page, amount);
    await waitWithRandomJitter(page, 20, 30);
  }
}

/**
 * Simulate idle cursor micro-jitter — the involuntary hand movement that
 * keeps a real cursor from ever being perfectly still.
 *
 * @param page - Playwright Page.
 * @param currentX - Current mouse X coordinate.
 * @param currentY - Current mouse Y coordinate.
 * @param driftCount - Number of micro-moves to perform (1–20, default 3).
 * @param radius - Maximum drift radius in pixels (0–100, default 5).
 */
export async function simulateIdleDrift(
  page: Page,
  currentX: number,
  currentY: number,
  driftCount = 3,
  radius = 5
): Promise<void> {
  const clampedCount = clamp(driftCount, MIN_DRIFT_COUNT, MAX_DRIFT_COUNT);
  const clampedRadius = clamp(radius, 0, MAX_DRIFT_RADIUS_PX);

  for (let i = 0; i < clampedCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * clampedRadius;
    await page.mouse.move(currentX + Math.cos(angle) * distance, currentY + Math.sin(angle) * distance, {
      steps: 1
    });
    await waitWithRandomJitter(page, 80, 120);
  }
}

/**
 * Fire synthetic `blur` / `focus` and `visibilitychange` events to simulate
 * the user briefly switching to another tab before returning.
 *
 * Some platforms track focus events and flag sessions that never blur as
 * potential automation.
 *
 * @param page - Playwright Page.
 * @param blurDurationMs - Duration of the simulated blur in milliseconds
 *   (100–30 000, default 2 000).
 */
export async function simulateTabBlur(page: Page, blurDurationMs = 2_000): Promise<void> {
  const duration = clamp(blurDurationMs, MIN_BLUR_DURATION_MS, MAX_BLUR_DURATION_MS);

  await dispatchWindowEvents(page, ["blur", "visibilitychange"]);
  await page.waitForTimeout(duration);
  await dispatchWindowEvents(page, ["focus", "visibilitychange"]);
}

/**
 * Fire a synthetic `resize` event to simulate a minor viewport dimension
 * change. Real browsers resize occasionally; platforms that never see a
 * resize event may flag the session.
 *
 * @param page - Playwright Page.
 */
export async function simulateViewportJitter(page: Page): Promise<void> {
  await dispatchWindowEvents(page, ["resize"]);
}

/**
 * Check whether a visible CAPTCHA challenge is present on `page`.
 *
 * Returns `true` when any known CAPTCHA selector matches at least one element.
 * This library does **not** solve CAPTCHAs; callers should pause and alert an
 * operator when this returns `true`.
 *
 * @param page - Playwright Page to inspect.
 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  return (await findMatchingSelectors(page, CAPTCHA_SELECTORS, true)).length > 0;
}

/**
 * Find likely honeypot form fields on `page`.
 *
 * Honeypot fields are hidden inputs that bots tend to fill but real users
 * never interact with. Filling them sends a bot signal to the server. Returns
 * an array of CSS selectors for any suspected honeypot fields found.
 *
 * @param page - Playwright Page to inspect.
 */
export async function findHoneypotFields(page: Page): Promise<readonly string[]> {
  return findMatchingSelectors(page, HONEYPOT_SELECTORS);
}

export async function scrollPageBy(
  page: Page,
  pixels: number,
  behavior: ScrollBehavior = "auto"
): Promise<void> {
  if (behavior === "smooth") {
    await page.evaluate((scrollAmount: number) => {
      globalThis.scrollBy({ top: scrollAmount, behavior: "smooth" });
    }, pixels);
    return;
  }

  await page.evaluate((scrollAmount: number) => {
    globalThis.scrollBy({ top: scrollAmount, behavior: "auto" });
  }, pixels);
}

async function applyWebdriverHardening(page: Page): Promise<void> {
  await page.evaluate(() => {
    try {
      const navigatorObject = (globalThis as Record<string, unknown>)["navigator"];
      if (navigatorObject && typeof navigatorObject === "object") {
        Object.defineProperty(navigatorObject, "webdriver", {
          get: () => undefined,
          configurable: true
        });
      }
    } catch {
      // Already defined non-configurably; skip.
    }
  });
}

async function applyCanvasNoise(page: Page, salt: number): Promise<void> {
  await page.evaluate((noiseSalt: number) => {
    try {
      const globalRecord = globalThis as Record<string, unknown>;
      const contextConstructor = globalRecord["CanvasRenderingContext2D"];
      if (typeof contextConstructor !== "function") {
        return;
      }

      const prototype = (contextConstructor as { prototype: Record<string, unknown> }).prototype;
      const originalGetImageData = prototype["getImageData"];
      if (typeof originalGetImageData !== "function") {
        return;
      }

      const typedGetImageData = originalGetImageData as (
        this: unknown,
        sx: number,
        sy: number,
        sw: number,
        sh: number
      ) => { data: { length: number; [index: number]: number } };

      prototype["getImageData"] = function (
        this: unknown,
        sx: number,
        sy: number,
        sw: number,
        sh: number
      ): unknown {
        const imageData = typedGetImageData.call(this, sx, sy, sw, sh);
        if (imageData.data.length > 0) {
          imageData.data[0] = ((imageData.data[0] ?? 0) + (noiseSalt & 1)) & 255;
        }
        return imageData;
      };
    } catch {
      // Canvas API unavailable; skip.
    }
  }, salt);
}

async function dispatchWindowEvents(page: Page, eventNames: readonly string[]): Promise<void> {
  await page.evaluate((names: readonly string[]) => {
    for (const name of names) {
      globalThis.dispatchEvent(new Event(name));
    }
  }, [...eventNames]);
}

async function findMatchingSelectors(
  page: Page,
  selectors: readonly string[],
  stopAfterFirstMatch = false
): Promise<string[]> {
  const matches: string[] = [];

  for (const selector of selectors) {
    if (await selectorMatches(page, selector)) {
      matches.push(selector);
      if (stopAfterFirstMatch) {
        break;
      }
    }
  }

  return matches;
}

async function selectorMatches(page: Page, selector: string): Promise<boolean> {
  return (await page.locator(selector).count()) > 0;
}

async function waitWithRandomJitter(page: Page, baseMs: number, jitterMs: number): Promise<void> {
  await page.waitForTimeout(baseMs + Math.floor(Math.random() * jitterMs));
}
