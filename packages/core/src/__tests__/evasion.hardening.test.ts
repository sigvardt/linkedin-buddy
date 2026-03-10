import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFingerprintHardening,
  computeBezierPath,
  detectCaptcha,
  EVASION_PROFILES,
  EvasionSession,
  findHoneypotFields,
  samplePoissonInterval,
  simulateIdleDrift
} from "../evasion.js";
import { MAX_SCROLL_DISTANCE_PX } from "../evasion/shared.js";
import { createPageMock } from "./evasionTestUtils.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("evasion hardening", () => {
  it("keeps Bezier paths finite for invalid coordinates and options", () => {
    const path = computeBezierPath(
      { x: Number.NaN, y: 10 },
      { x: 25, y: Number.POSITIVE_INFINITY },
      { steps: Number.NaN, overshootFactor: Number.NaN, seed: 7 }
    );

    expect(path.length).toBeGreaterThan(0);
    for (const point of path) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
    expect(path[0]).toEqual({ x: 0, y: 10 });
    expect(path.at(-1)).toEqual({ x: 25, y: 10 });
  });

  it("backs off sampled intervals when rate limited and a keep-alive cadence exists", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999_999);

    const interval = samplePoissonInterval(250, {
      responseStatus: 429,
      keepAliveIntervalMs: 1_000,
      retryAfterMs: 800
    });

    expect(interval).toBeGreaterThanOrEqual(1_000);
  });

  it("registers init scripts when evaluate fails under restrictive environments", async () => {
    const { addInitScript, page } = createPageMock({
      includeAddInitScript: true,
      evaluateError: new Error("CSP blocked")
    });
    const navigatorStub: Record<string, unknown> = {};
    vi.stubGlobal("navigator", navigatorStub);

    await expect(applyFingerprintHardening(page, "moderate")).resolves.toBeUndefined();

    expect(addInitScript).toHaveBeenCalledOnce();
    const descriptor = Object.getOwnPropertyDescriptor(navigatorStub, "webdriver");
    expect(descriptor?.get?.()).toBeUndefined();
  });

  it("keeps paranoid canvas hardening idempotent across repeated calls", async () => {
    const { page } = createPageMock();

    class CanvasContext2DMock {
      getImageData(): { data: number[] } {
        return { data: [10, 20, 30, 40] };
      }
    }

    vi.stubGlobal("CanvasRenderingContext2D", CanvasContext2DMock);
    vi.spyOn(Math, "random").mockReturnValue(0.004);

    await applyFingerprintHardening(page, "paranoid");
    await applyFingerprintHardening(page, "paranoid");

    const context = new CanvasContext2DMock();
    expect(context.getImageData().data[0]).toBe(11);
  });

  it("clamps idle drift into tiny viewport bounds", async () => {
    const { mouseMove, page } = createPageMock({ viewportSize: { width: 1, height: 1 } });
    vi.spyOn(Math, "random").mockReturnValue(1);

    await simulateIdleDrift(page, 50, 50, 2, 100);

    for (const [x, y] of mouseMove.mock.calls as [number, number][]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it("continues selector checks after partial-load errors", async () => {
    const { locatorCounts, page } = createPageMock({
      locatorErrorSelectors: new Set(["[class*='captcha' i]", "input[style*='display:none']"])
    });
    locatorCounts.set("[data-sitekey]", 1);
    locatorCounts.set("input[tabindex='-1']", 1);

    await expect(detectCaptcha(page)).resolves.toBe(true);
    await expect(findHoneypotFields(page)).resolves.toEqual(["input[tabindex='-1']"]);
  });

  it("freezes the public evasion profiles", () => {
    expect(Object.isFrozen(EVASION_PROFILES)).toBe(true);
    for (const profile of Object.values(EVASION_PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true);
    }
  });

  it("serializes concurrent session operations", async () => {
    let releaseMove: (() => void) | undefined;
    const blockedMove = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const order: string[] = [];
    const page = {
      evaluate: vi.fn(async () => undefined),
      locator: vi.fn(() => ({ count: vi.fn(async () => 0) })),
      mouse: {
        move: vi.fn(async () => {
          order.push("move");
          await blockedMove;
        })
      },
      waitForTimeout: vi.fn(async () => {
        order.push("wait");
      })
    } as unknown as Page;
    const session = new EvasionSession(page, "minimal");

    const movePromise = session.moveMouse({ x: 0, y: 0 }, { x: 10, y: 20 });
    const idlePromise = session.idle(100);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).toEqual(["move"]);

    releaseMove?.();
    await Promise.all([movePromise, idlePromise]);

    expect(order).toEqual(["move", "wait"]);
  });

  it("deduplicates concurrent fingerprint hardening for a single session", async () => {
    const { evaluate, page } = createPageMock();
    const session = new EvasionSession(page, "paranoid");

    await Promise.all([session.hardenFingerprint(), session.hardenFingerprint()]);

    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("clamps excessive session scroll distances instead of throwing", async () => {
    const { evaluateCalls, page } = createPageMock();
    const session = new EvasionSession(page, "minimal");

    await expect(session.scroll(999_999)).resolves.toBeUndefined();

    const instruction = evaluateCalls[0]?.arg as { top: number; behavior: string } | undefined;
    expect(instruction?.top).toBe(MAX_SCROLL_DISTANCE_PX);
    expect(instruction?.behavior).toBe("smooth");
  });

  it("applies rate-limit backoff even when poisson timing is disabled", () => {
    const { page } = createPageMock();
    const session = new EvasionSession(page, "minimal");

    const interval = session.sampleInterval(500, {
      responseStatus: 429,
      keepAliveIntervalMs: 2_000
    });

    expect(interval).toBe(2_000);
  });
});
