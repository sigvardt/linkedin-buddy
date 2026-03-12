import { debuglog } from "node:util";
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
  clamp,
  isFiniteNumber,
  normalizeFiniteNumber,
} from "./shared.js";
import type { EvasionLevel } from "./types.js";

type ScrollBehavior = "auto" | "smooth";

interface MousePoint {
  x: number;
  y: number;
}

interface ViewportBounds {
  width: number;
  height: number;
}

type PageWithInitScript = Page & Partial<Pick<Page, "addInitScript">>;
type PageWithViewportSize = Page & Partial<Pick<Page, "viewportSize">>;
type PageScriptInvoker = (script: unknown, arg?: unknown) => Promise<unknown>;

type ScrollInstruction = {
  top: number;
  behavior: ScrollBehavior;
};

const evasionDebugLog = debuglog("linkedin-evasion");

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
 * The hardening is intentionally fail-open: if a browser blocks one technique,
 * the helper silently falls back to any remaining techniques or a no-op.
 *
 * @param page - Playwright Page to harden.
 * @param level - Desired evasion level (defaults to `"moderate"`).
 *
 * @example
 * ```ts
 * await applyFingerprintHardening(page, "paranoid");
 * ```
 */
export async function applyFingerprintHardening(
  page: Page,
  level: EvasionLevel = "moderate",
): Promise<void> {
  if (level === "minimal") {
    return;
  }

  await applyWebdriverHardening(page);

  if (level === "paranoid") {
    await applyCanvasNoise(page, Math.floor(Math.random() * 256));
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
 *
 * @example
 * ```ts
 * await simulateMomentumScroll(page, 320);
 * ```
 */
export async function simulateMomentumScroll(
  page: Page,
  pixels: number,
  steps = 6,
): Promise<void> {
  const safePixels = normalizeFiniteNumber(pixels, 0);
  if (safePixels === 0) {
    return;
  }

  const totalSteps = Math.round(
    clamp(steps, MIN_SCROLL_STEPS, MAX_SCROLL_STEPS),
  );
  for (const amount of computeMomentumSteps(safePixels, totalSteps)) {
    if (amount === 0) {
      continue;
    }

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
 *
 * @example
 * ```ts
 * await simulateIdleDrift(page, 240, 160, 4, 6);
 * ```
 */
export async function simulateIdleDrift(
  page: Page,
  currentX: number,
  currentY: number,
  driftCount = 3,
  radius = 5,
): Promise<void> {
  const basePoint: MousePoint = {
    x: normalizeFiniteNumber(currentX, 0),
    y: normalizeFiniteNumber(currentY, 0),
  };
  const clampedCount = Math.round(
    clamp(driftCount, MIN_DRIFT_COUNT, MAX_DRIFT_COUNT),
  );
  const clampedRadius = clamp(radius, 0, MAX_DRIFT_RADIUS_PX);
  const viewportBounds = resolveViewportBounds(page);

  for (let index = 0; index < clampedCount; index++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * clampedRadius;
    const targetPoint = clampPointToViewport(
      {
        x: basePoint.x + Math.cos(angle) * distance,
        y: basePoint.y + Math.sin(angle) * distance,
      },
      viewportBounds,
    );

    const moved = await safeMouseMove(page, targetPoint, 1);
    if (!moved) {
      return;
    }

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
 *
 * @example
 * ```ts
 * await simulateTabBlur(page, 1_500);
 * ```
 */
export async function simulateTabBlur(
  page: Page,
  blurDurationMs = 2_000,
): Promise<void> {
  const duration = Math.round(
    clamp(blurDurationMs, MIN_BLUR_DURATION_MS, MAX_BLUR_DURATION_MS),
  );

  await dispatchWindowEvents(page, ["blur", "visibilitychange"]);
  await safeWaitForTimeout(page, duration);
  await dispatchWindowEvents(page, ["focus", "visibilitychange"]);
}

/**
 * Fire a synthetic `resize` event to simulate a minor viewport dimension
 * change. Real browsers resize occasionally; platforms that never see a
 * resize event may flag the session.
 *
 * @param page - Playwright Page.
 *
 * @example
 * ```ts
 * await simulateViewportJitter(page);
 * ```
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
 *
 * @example
 * ```ts
 * if (await detectCaptcha(page)) {
 *   throw new Error("Operator intervention required");
 * }
 * ```
 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  const matches = await findMatchingSelectors(page, CAPTCHA_SELECTORS, true);
  const matchedSelector = matches[0] ?? null;
  if (matchedSelector) {
    evasionDebugLog("detectCaptcha matched selector: %s", matchedSelector);
  }

  return matchedSelector !== null;
}

/**
 * Find likely honeypot form fields on `page`.
 *
 * Honeypot fields are hidden inputs that bots tend to fill but real users
 * never interact with. Filling them sends a bot signal to the server. Returns
 * an array of CSS selectors for any suspected honeypot fields found.
 *
 * @param page - Playwright Page to inspect.
 *
 * @example
 * ```ts
 * const selectors = await findHoneypotFields(page);
 * ```
 */
export async function findHoneypotFields(
  page: Page,
): Promise<readonly string[]> {
  return findMatchingSelectors(page, HONEYPOT_SELECTORS);
}

/**
 * Scrolls the page by a fixed distance using the requested browser scroll
 * behavior.
 *
 * @param page - Playwright Page to scroll.
 * @param pixels - Distance in pixels (positive = down, negative = up).
 * @param behavior - Native browser scroll behavior to request.
 */
export async function scrollPageBy(
  page: Page,
  pixels: number,
  behavior: ScrollBehavior = "auto",
): Promise<void> {
  const safePixels = normalizeFiniteNumber(pixels, 0);
  if (safePixels === 0) {
    return;
  }

  const scrollInstruction: ScrollInstruction = {
    top: safePixels,
    behavior: behavior === "smooth" ? "smooth" : "auto",
  };
  await safeEvaluate(page, executeScrollBy, scrollInstruction);
}

async function applyWebdriverHardening(page: Page): Promise<void> {
  await safeAddInitScript(page, installWebdriverHardening);
  await safeEvaluate(page, installWebdriverHardening);
}

async function applyCanvasNoise(page: Page, salt: number): Promise<void> {
  const safeSalt = Math.round(clamp(salt, 0, 255));
  await safeAddInitScript(page, installCanvasNoise, safeSalt);
  await safeEvaluate(page, installCanvasNoise, safeSalt);
}

async function dispatchWindowEvents(
  page: Page,
  eventNames: readonly string[],
): Promise<void> {
  if (eventNames.length === 0) {
    return;
  }

  await safeEvaluate(page, emitWindowEvents, [...eventNames]);
}

async function findMatchingSelectors(
  page: Page,
  selectors: readonly string[],
  stopAfterFirstMatch = false,
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
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

async function waitWithRandomJitter(
  page: Page,
  baseMs: number,
  jitterMs: number,
): Promise<void> {
  const safeBaseMs = Math.max(0, Math.round(normalizeFiniteNumber(baseMs, 0)));
  const safeJitterMs = Math.max(
    0,
    Math.round(normalizeFiniteNumber(jitterMs, 0)),
  );
  const delayMs = safeBaseMs + Math.floor(Math.random() * (safeJitterMs + 1));

  await safeWaitForTimeout(page, delayMs);
}

async function safeWaitForTimeout(
  page: Page,
  delayMs: number,
): Promise<boolean> {
  const safeDelayMs = Math.max(
    0,
    Math.round(normalizeFiniteNumber(delayMs, 0)),
  );

  try {
    await page.waitForTimeout(safeDelayMs);
    return true;
  } catch {
    return false;
  }
}

async function safeMouseMove(
  page: Page,
  point: Readonly<MousePoint>,
  steps: number,
): Promise<boolean> {
  try {
    await page.mouse.move(point.x, point.y, { steps });
    return true;
  } catch {
    return false;
  }
}

async function safeAddInitScript(
  page: Page,
  callback: unknown,
  arg?: unknown,
): Promise<boolean> {
  const pageWithInitScript = page as PageWithInitScript;
  const addInitScript = pageWithInitScript.addInitScript as
    | PageScriptInvoker
    | undefined;
  if (typeof addInitScript !== "function") {
    return false;
  }

  try {
    await addInitScript(callback, arg);
    return true;
  } catch {
    return false;
  }
}

async function safeEvaluate(
  page: Page,
  callback: unknown,
  arg?: unknown,
): Promise<boolean> {
  const evaluate = page.evaluate as unknown as PageScriptInvoker;

  try {
    await evaluate.call(page, callback, arg);
    return true;
  } catch {
    return false;
  }
}

function resolveViewportBounds(page: Page): ViewportBounds | null {
  const pageWithViewportSize = page as PageWithViewportSize;
  if (typeof pageWithViewportSize.viewportSize !== "function") {
    return null;
  }

  try {
    const viewportSize = pageWithViewportSize.viewportSize();
    if (!isViewportSize(viewportSize)) {
      return null;
    }

    return {
      width: Math.max(0, viewportSize.width),
      height: Math.max(0, viewportSize.height),
    };
  } catch {
    return null;
  }
}

function isViewportSize(value: unknown): value is ViewportBounds {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return isFiniteNumber(record["width"]) && isFiniteNumber(record["height"]);
}

function clampPointToViewport(
  point: Readonly<MousePoint>,
  viewportBounds: ViewportBounds | null,
): MousePoint {
  if (viewportBounds === null) {
    return {
      x: normalizeFiniteNumber(point.x, 0),
      y: normalizeFiniteNumber(point.y, 0),
    };
  }

  return {
    x: clamp(point.x, 0, viewportBounds.width),
    y: clamp(point.y, 0, viewportBounds.height),
  };
}

function installWebdriverHardening(): void {
  try {
    const globalRecord = globalThis as Record<string, unknown>;
    const stateKey = "__linkedinAssistantEvasionState__";
    const existingState = globalRecord[stateKey];
    const state =
      typeof existingState === "object" && existingState !== null
        ? (existingState as Record<string, unknown>)
        : {};

    if (globalRecord[stateKey] !== state) {
      globalRecord[stateKey] = state;
    }

    const navigatorObject = globalRecord["navigator"];
    if (!navigatorObject || typeof navigatorObject !== "object") {
      return;
    }

    Object.defineProperty(navigatorObject, "webdriver", {
      get: () => undefined,
      configurable: true,
    });
    state["webdriverApplied"] = true;
  } catch {
    // Already defined non-configurably or unavailable; skip.
  }
}

function installCanvasNoise(noiseSalt: number): void {
  try {
    const globalRecord = globalThis as Record<string, unknown>;
    const stateKey = "__linkedinAssistantEvasionState__";
    const existingState = globalRecord[stateKey];
    const state =
      typeof existingState === "object" && existingState !== null
        ? (existingState as Record<string, unknown>)
        : {};

    if (globalRecord[stateKey] !== state) {
      globalRecord[stateKey] = state;
    }

    const existingCanvasState = state["canvas"];
    const canvasState =
      typeof existingCanvasState === "object" && existingCanvasState !== null
        ? (existingCanvasState as Record<string, unknown>)
        : {};

    if (state["canvas"] !== canvasState) {
      state["canvas"] = canvasState;
    }

    const safeNoiseSalt =
      typeof noiseSalt === "number" && Number.isFinite(noiseSalt)
        ? noiseSalt
        : 0;
    canvasState["salt"] = Math.round(safeNoiseSalt) & 255;

    const contextConstructor = globalRecord["CanvasRenderingContext2D"];
    if (typeof contextConstructor !== "function") {
      return;
    }

    const prototype = (
      contextConstructor as { prototype: Record<string, unknown> }
    ).prototype;
    const originalGetImageData = prototype["getImageData"];
    if (typeof originalGetImageData !== "function") {
      return;
    }

    if (canvasState["patched"] === true) {
      return;
    }

    const typedGetImageData = originalGetImageData as (
      this: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
    ) => { data?: { length?: number; [index: number]: number | undefined } };

    prototype["getImageData"] = function (
      this: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
    ): unknown {
      const imageData = typedGetImageData.call(this, sx, sy, sw, sh);
      const imageDataRecord = imageData as {
        data?: { length?: number; [index: number]: number | undefined };
      };
      const data = imageDataRecord.data;
      if (data && typeof data.length === "number" && data.length > 0) {
        const rawActiveSalt = canvasState["salt"];
        const activeSalt =
          typeof rawActiveSalt === "number" && Number.isFinite(rawActiveSalt)
            ? Math.round(rawActiveSalt) & 255
            : 0;
        data[0] = ((data[0] ?? 0) + (activeSalt & 1)) & 255;
      }
      return imageData;
    };

    canvasState["patched"] = true;
  } catch {
    // Canvas API unavailable or blocked; skip.
  }
}

function executeScrollBy(instruction: ScrollInstruction): void {
  try {
    globalThis.scrollBy({
      top: instruction.top,
      behavior: instruction.behavior,
    });
  } catch {
    // Browser scrolling unavailable; skip.
  }
}

function emitWindowEvents(eventNames: readonly string[]): void {
  try {
    for (const name of eventNames) {
      globalThis.dispatchEvent(new Event(name));
    }
  } catch {
    // Event constructors or dispatch may be unavailable during partial loads.
  }
}
