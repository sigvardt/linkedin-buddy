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
  normalizeFiniteNumber
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

/**
 * Apply navigator and canvas fingerprint hardening to `page` by injecting
 * JavaScript into the current page context.
 *
 * Hardening levels:
 * - `minimal`: no-op.
 * - `moderate`: Applies core browser signal fixes and per-session fingerprint
 *   noise across webdriver, window dimensions, WebRTC, canvas, and audio.
 * - `paranoid`: Currently matches `moderate` behavior.
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
  level: EvasionLevel = "moderate"
): Promise<void> {
  if (level === "minimal") {
    return;
  }

  // Applied at moderate+: core browser signal fixes
  await applyWebdriverHardening(page);
  await applyOuterDimensionsFix(page);
  await applyWebRTCProtection(page);

  // Applied at moderate+: fingerprint noise to break tracking
  const noiseSalt = Math.floor(Math.random() * 256);
  await applyCanvasNoise(page, noiseSalt);
  await applyAudioContextNoise(page, noiseSalt);
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
  steps = 6
): Promise<void> {
  const safePixels = normalizeFiniteNumber(pixels, 0);
  if (safePixels === 0) {
    return;
  }

  const totalSteps = Math.round(clamp(steps, MIN_SCROLL_STEPS, MAX_SCROLL_STEPS));
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
  radius = 5
): Promise<void> {
  const basePoint: MousePoint = {
    x: normalizeFiniteNumber(currentX, 0),
    y: normalizeFiniteNumber(currentY, 0)
  };
  const clampedCount = Math.round(clamp(driftCount, MIN_DRIFT_COUNT, MAX_DRIFT_COUNT));
  const clampedRadius = clamp(radius, 0, MAX_DRIFT_RADIUS_PX);
  const viewportBounds = resolveViewportBounds(page);

  for (let index = 0; index < clampedCount; index++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * clampedRadius;
    const targetPoint = clampPointToViewport(
      {
        x: basePoint.x + Math.cos(angle) * distance,
        y: basePoint.y + Math.sin(angle) * distance
      },
      viewportBounds
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
export async function simulateTabBlur(page: Page, blurDurationMs = 2_000): Promise<void> {
  const duration = Math.round(clamp(blurDurationMs, MIN_BLUR_DURATION_MS, MAX_BLUR_DURATION_MS));

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
 *
 * @example
 * ```ts
 * const selectors = await findHoneypotFields(page);
 * ```
 */
export async function findHoneypotFields(page: Page): Promise<readonly string[]> {
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
  behavior: ScrollBehavior = "auto"
): Promise<void> {
  const safePixels = normalizeFiniteNumber(pixels, 0);
  if (safePixels === 0) {
    return;
  }

  const scrollInstruction: ScrollInstruction = {
    top: safePixels,
    behavior: behavior === "smooth" ? "smooth" : "auto"
  };
  await safeEvaluate(page, executeScrollBy, scrollInstruction);
}

async function applyWebdriverHardening(page: Page): Promise<void> {
  await safeAddInitScript(page, installWebdriverHardening);
  await safeEvaluate(page, installWebdriverHardening);
}

async function applyOuterDimensionsFix(page: Page): Promise<void> {
  await safeAddInitScript(page, installOuterDimensionsFix);
  await safeEvaluate(page, installOuterDimensionsFix);
}

async function applyWebRTCProtection(page: Page): Promise<void> {
  await safeAddInitScript(page, installWebRTCProtection);
  await safeEvaluate(page, installWebRTCProtection);
}

async function applyCanvasNoise(page: Page, salt: number): Promise<void> {
  const safeSalt = Math.round(clamp(salt, 0, 255));
  await safeAddInitScript(page, installCanvasNoise, safeSalt);
  await safeEvaluate(page, installCanvasNoise, safeSalt);
}

async function applyAudioContextNoise(page: Page, salt: number): Promise<void> {
  const safeSalt = Math.round(clamp(salt, 0, 255));
  await safeAddInitScript(page, installAudioContextNoise, safeSalt);
  await safeEvaluate(page, installAudioContextNoise, safeSalt);
}

async function dispatchWindowEvents(page: Page, eventNames: readonly string[]): Promise<void> {
  if (eventNames.length === 0) {
    return;
  }

  await safeEvaluate(page, emitWindowEvents, [...eventNames]);
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
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

async function waitWithRandomJitter(page: Page, baseMs: number, jitterMs: number): Promise<void> {
  const safeBaseMs = Math.max(0, Math.round(normalizeFiniteNumber(baseMs, 0)));
  const safeJitterMs = Math.max(0, Math.round(normalizeFiniteNumber(jitterMs, 0)));
  const delayMs = safeBaseMs + Math.floor(Math.random() * (safeJitterMs + 1));

  await safeWaitForTimeout(page, delayMs);
}

async function safeWaitForTimeout(page: Page, delayMs: number): Promise<boolean> {
  const safeDelayMs = Math.max(0, Math.round(normalizeFiniteNumber(delayMs, 0)));

  try {
    await page.waitForTimeout(safeDelayMs);
    return true;
  } catch {
    return false;
  }
}

async function safeMouseMove(page: Page, point: Readonly<MousePoint>, steps: number): Promise<boolean> {
  try {
    await page.mouse.move(point.x, point.y, { steps });
    return true;
  } catch {
    return false;
  }
}

async function safeAddInitScript(page: Page, callback: unknown, arg?: unknown): Promise<boolean> {
  const pageWithInitScript = page as PageWithInitScript;
  const addInitScript = pageWithInitScript.addInitScript as PageScriptInvoker | undefined;
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

async function safeEvaluate(page: Page, callback: unknown, arg?: unknown): Promise<boolean> {
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
      height: Math.max(0, viewportSize.height)
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
  viewportBounds: ViewportBounds | null
): MousePoint {
  if (viewportBounds === null) {
    return {
      x: normalizeFiniteNumber(point.x, 0),
      y: normalizeFiniteNumber(point.y, 0)
    };
  }

  return {
    x: clamp(point.x, 0, viewportBounds.width),
    y: clamp(point.y, 0, viewportBounds.height)
  };
}

/**
 * Remove a detectable own `navigator.webdriver` property only when it is
 * explicitly `true`, allowing browser-level AutomationControlled behavior to
 * expose a native prototype getter instead.
 */
function installWebdriverHardening(): void {
  try {
    const nav = globalThis.navigator;
    const navRecord = nav as unknown as Record<string, unknown>;
    if (nav && typeof nav === "object" && navRecord["webdriver"] === true) {
      delete navRecord["webdriver"];
    }
  } catch {
    // Already handled by browser flags; skip.
  }
}

/**
 * Ensure `window.outerWidth` / `window.outerHeight` are plausible in headless
 * contexts where they may otherwise report zero.
 */
function installOuterDimensionsFix(): void {
  try {
    if (
      typeof globalThis.outerWidth === "number" &&
      globalThis.outerWidth === 0 &&
      typeof globalThis.innerWidth === "number" &&
      globalThis.innerWidth > 0
    ) {
      Object.defineProperty(globalThis, "outerWidth", {
        get: () => globalThis.innerWidth,
        configurable: true
      });
      // Real Chrome typically includes browser chrome above viewport height.
      Object.defineProperty(globalThis, "outerHeight", {
        get: () => globalThis.innerHeight + 85,
        configurable: true
      });
    }
  } catch {
    // Outer dimensions unavailable or non-configurable; skip.
  }
}

/**
 * Force relay-only ICE policy on WebRTC peer connections to reduce accidental
 * local IP disclosure via candidate gathering.
 */
function installWebRTCProtection(): void {
  try {
    const globalRecord = globalThis as Record<string, unknown>;
    const RTCPeerConnectionCtor = globalRecord["RTCPeerConnection"] as
      | (new (...args: unknown[]) => unknown)
      | undefined;
    if (typeof RTCPeerConnectionCtor !== "function") {
      return;
    }

    const stateKey = "__linkedinAssistantEvasionState__";
    const existingState = globalRecord[stateKey];
    const state =
      typeof existingState === "object" && existingState !== null
        ? (existingState as Record<string, unknown>)
        : {};
    if (globalRecord[stateKey] !== state) {
      globalRecord[stateKey] = state;
    }
    if (state["webrtcPatched"] === true) {
      return;
    }

    const OriginalRTC = RTCPeerConnectionCtor;
    const PatchedRTC = function (this: unknown, ...args: unknown[]) {
      const config =
        typeof args[0] === "object" && args[0] !== null
          ? { ...(args[0] as Record<string, unknown>) }
          : {};
      config["iceTransportPolicy"] = "relay";
      return new OriginalRTC(config);
    } as unknown as typeof RTCPeerConnectionCtor;

    PatchedRTC.prototype = OriginalRTC.prototype;
    globalRecord["RTCPeerConnection"] = PatchedRTC;

    if (typeof globalRecord["webkitRTCPeerConnection"] === "function") {
      globalRecord["webkitRTCPeerConnection"] = PatchedRTC;
    }

    state["webrtcPatched"] = true;
  } catch {
    // WebRTC API unavailable; skip.
  }
}

/**
 * Add stable per-session noise to canvas pixel reads to reduce deterministic
 * canvas hash stability while preserving visual fidelity.
 */
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
      typeof noiseSalt === "number" && Number.isFinite(noiseSalt) ? noiseSalt : 0;
    canvasState["salt"] = Math.round(safeNoiseSalt) & 255;

    const contextConstructor = globalRecord["CanvasRenderingContext2D"];
    if (typeof contextConstructor !== "function") {
      return;
    }

    const prototype = (contextConstructor as { prototype: Record<string, unknown> }).prototype;
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
      sh: number
    ) => { data?: { length?: number; [index: number]: number | undefined } };

    prototype["getImageData"] = function (
      this: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number
    ): unknown {
      const imageData = typedGetImageData.call(this, sx, sy, sw, sh);
      const imageDataRecord = imageData as { data?: { length?: number; [index: number]: number | undefined } };
      const data = imageDataRecord.data;
      if (data && typeof data.length === "number" && data.length > 0) {
        const rawActiveSalt = canvasState["salt"];
        const activeSalt =
          typeof rawActiveSalt === "number" && Number.isFinite(rawActiveSalt)
            ? Math.round(rawActiveSalt) & 255
            : 0;

        // Apply noise to multiple pixels with a tiny deterministic drift.
        let prngState = activeSalt | 1;
        const pixelCount = Math.floor(data.length / 4);
        const noisyPixels = Math.min(10, pixelCount);
        const step = Math.max(1, Math.floor(pixelCount / Math.max(1, noisyPixels)));

        for (let px = 0; px < pixelCount && px < noisyPixels * step; px += step) {
          const baseIndex = px * 4;
          const channel = prngState % 3;
          const currentValue = data[baseIndex + channel];
          if (typeof currentValue === "number" && currentValue > 0 && currentValue < 255) {
            data[baseIndex + channel] =
              (prngState & 2) !== 0
                ? Math.min(currentValue + 1, 255)
                : Math.max(currentValue - 1, 0);
          }
          prngState = ((prngState * 1664525 + 1013904223) >>> 0) & 0xffffffff;
        }
      }
      return imageData;
    };

    canvasState["patched"] = true;
  } catch {
    // Canvas API unavailable or blocked; skip.
  }
}

/**
 * Add minimal per-session perturbation to offline audio sample buffers so
 * audio fingerprint hashes are not perfectly stable across sessions.
 */
function installAudioContextNoise(noiseSalt: number): void {
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

    const existingAudioState = state["audio"];
    const audioState =
      typeof existingAudioState === "object" && existingAudioState !== null
        ? (existingAudioState as Record<string, unknown>)
        : {};
    if (state["audio"] !== audioState) {
      state["audio"] = audioState;
    }

    const safeSalt =
      typeof noiseSalt === "number" && Number.isFinite(noiseSalt)
        ? Math.round(noiseSalt) & 255
        : 0;
    audioState["salt"] = safeSalt;

    const audioBufferConstructor = globalRecord["AudioBuffer"];
    if (typeof audioBufferConstructor !== "function") {
      return;
    }

    const prototype = (audioBufferConstructor as { prototype: Record<string, unknown> }).prototype;
    const originalGetChannelData = prototype["getChannelData"];
    if (typeof originalGetChannelData !== "function") {
      return;
    }

    if (audioState["patched"] === true) {
      return;
    }

    const typedGetChannelData = originalGetChannelData as (
      this: unknown,
      channel: number
    ) => { length: number; [index: number]: number };

    prototype["getChannelData"] = function (this: unknown, channel: number): unknown {
      const data = typedGetChannelData.call(this, channel);
      if (typeof data.length === "number" && data.length > 0) {
        const activeRawSalt = audioState["salt"];
        const activeSalt =
          typeof activeRawSalt === "number" && Number.isFinite(activeRawSalt)
            ? Math.round(activeRawSalt) & 255
            : 0;
        const delta = (activeSalt & 1) !== 0 ? 0.0000001 : -0.0000001;
        const sampleCount = Math.min(10, data.length);
        for (let index = 0; index < sampleCount; index++) {
          const sample = data[index];
          if (typeof sample === "number") {
            data[index] = sample + delta;
          }
        }
      }
      return data;
    };

    audioState["patched"] = true;
  } catch {
    // AudioContext API unavailable; skip.
  }
}

function executeScrollBy(instruction: ScrollInstruction): void {
  try {
    globalThis.scrollBy({ top: instruction.top, behavior: instruction.behavior });
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
