import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFingerprintHardening,
  scrollPageBy,
  simulateIdleDrift,
  simulateMomentumScroll,
  simulateTabBlur,
  simulateViewportJitter
} from "../evasion/browser.js";
import {
  MAX_DRIFT_COUNT,
  MAX_DRIFT_RADIUS_PX,
  MIN_BLUR_DURATION_MS,
  MIN_DRIFT_COUNT,
  MIN_SCROLL_STEPS
} from "../evasion/shared.js";
import { createPageMock } from "./evasionTestUtils.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser evasion helpers", () => {
  it("overrides navigator.webdriver when fingerprint hardening is enabled", async () => {
    const { page } = createPageMock();
    const navigatorStub: Record<string, unknown> = {};
    vi.stubGlobal("navigator", navigatorStub);

    await applyFingerprintHardening(page, "moderate");

    const descriptor = Object.getOwnPropertyDescriptor(navigatorStub, "webdriver");
    expect(descriptor?.configurable).toBe(true);
    expect(descriptor?.get?.()).toBeUndefined();
  });

  it("adds deterministic canvas pixel noise in paranoid mode when canvas APIs exist", async () => {
    const { page } = createPageMock();

    class CanvasContext2DMock {
      getImageData(): { data: number[] } {
        return { data: [10, 20, 30, 40] };
      }
    }

    vi.stubGlobal("CanvasRenderingContext2D", CanvasContext2DMock);
    vi.spyOn(Math, "random").mockReturnValue(0.004);

    await applyFingerprintHardening(page, "paranoid");

    const context = new CanvasContext2DMock();
    const imageData = context.getImageData();
    expect(imageData.data[0]).toBe(11);
  });

  it("passes smooth scrolling options through the browser context", async () => {
    const { page } = createPageMock();
    const scrollBy = vi.fn(
      (options: { top: number; behavior: "auto" | "smooth" }) => {
        void options;
        return undefined;
      }
    );
    vi.stubGlobal("scrollBy", scrollBy);

    await scrollPageBy(page, 75, "smooth");

    expect(scrollBy).toHaveBeenCalledWith({ top: 75, behavior: "smooth" });
  });

  it("defaults to automatic scrolling when no behavior is provided", async () => {
    const { page } = createPageMock();
    const scrollBy = vi.fn(
      (options: { top: number; behavior: "auto" | "smooth" }) => {
        void options;
        return undefined;
      }
    );
    vi.stubGlobal("scrollBy", scrollBy);

    await scrollPageBy(page, -30);

    expect(scrollBy).toHaveBeenCalledWith({ top: -30, behavior: "auto" });
  });

  it("clamps momentum scroll to the minimum number of steps", async () => {
    const { evaluate, page, waitForTimeout } = createPageMock();

    await simulateMomentumScroll(page, 120, 1);

    expect(evaluate).toHaveBeenCalledTimes(MIN_SCROLL_STEPS);
    expect(waitForTimeout).toHaveBeenCalledTimes(MIN_SCROLL_STEPS);
  });

  it("clamps idle drift count and radius into the supported range", async () => {
    const { mouseMove, page } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(1);

    await simulateIdleDrift(page, 10, 20, 0, MAX_DRIFT_RADIUS_PX + 50);

    expect(mouseMove).toHaveBeenCalledTimes(MIN_DRIFT_COUNT);
    const [x, y] = mouseMove.mock.calls[0] as [number, number];
    expect(Math.hypot(x - 10, y - 20)).toBeLessThanOrEqual(MAX_DRIFT_RADIUS_PX + 0.001);
  });

  it("uses the maximum drift count and clamps negative radius to zero", async () => {
    const { mouseMove, page } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    await simulateIdleDrift(page, 10, 20, MAX_DRIFT_COUNT + 5, -10);

    expect(mouseMove).toHaveBeenCalledTimes(MAX_DRIFT_COUNT);
    for (const [x, y] of mouseMove.mock.calls as [number, number][]) {
      expect(x).toBeCloseTo(10, 5);
      expect(y).toBeCloseTo(20, 5);
    }
  });

  it("dispatches blur and focus lifecycle events in order", async () => {
    const { page, waitForTimeout } = createPageMock();
    const dispatchedEvents: string[] = [];
    vi.stubGlobal(
      "dispatchEvent",
      vi.fn((event: { type: string }) => {
        dispatchedEvents.push(event.type);
        return true;
      })
    );
    vi.stubGlobal(
      "Event",
      class {
        readonly type: string;

        constructor(type: string) {
          this.type = type;
        }
      }
    );

    await simulateTabBlur(page, 0);

    expect(waitForTimeout).toHaveBeenCalledWith(MIN_BLUR_DURATION_MS);
    expect(dispatchedEvents).toEqual(["blur", "visibilitychange", "focus", "visibilitychange"]);
  });

  it("dispatches a resize event for viewport jitter", async () => {
    const { page } = createPageMock();
    const dispatchedEvents: string[] = [];
    vi.stubGlobal(
      "dispatchEvent",
      vi.fn((event: { type: string }) => {
        dispatchedEvents.push(event.type);
        return true;
      })
    );
    vi.stubGlobal(
      "Event",
      class {
        readonly type: string;

        constructor(type: string) {
          this.type = type;
        }
      }
    );

    await simulateViewportJitter(page);

    expect(dispatchedEvents).toEqual(["resize"]);
  });
});
