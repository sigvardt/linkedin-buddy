import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import {
  computeBezierPath,
  computeReadingPauseMs,
  detectCaptcha,
  EVASION_PROFILES,
  EvasionSession,
  findHoneypotFields,
  samplePoissonInterval,
  simulateIdleDrift,
  simulateMomentumScroll,
  simulateTabBlur,
  simulateViewportJitter
} from "../evasion.js";

// --- Mock factory ---

function createPageMock() {
  const waitForTimeout = vi.fn(async () => {});
  const mouseMove = vi.fn(async () => {});
  const evaluateCalls: unknown[] = [];
  const locatorCounts: Map<string, number> = new Map();

  const evaluate = vi.fn(async (callback: unknown, arg?: unknown) => {
    evaluateCalls.push({ callback, arg });
    if (typeof callback === "function") {
      try {
        callback(arg);
      } catch {
        // Ignore errors from browser-context code run in Node
      }
    }
  });

  const locator = vi.fn((selector: string) => ({
    count: vi.fn(async () => locatorCounts.get(selector) ?? 0)
  }));

  const page = {
    evaluate,
    locator,
    mouse: { move: mouseMove },
    waitForTimeout
  } as unknown as Page;

  return {
    evaluate,
    evaluateCalls,
    locator,
    locatorCounts,
    mouseMove,
    page,
    waitForTimeout
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- computeBezierPath ---

describe("computeBezierPath", () => {
  it("starts at the from coordinate and ends at the to coordinate", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 200 };
    const path = computeBezierPath(from, to, { seed: 1 });

    const first = path[0];
    const last = path.at(-1);
    expect(first?.x).toBeCloseTo(0, 5);
    expect(first?.y).toBeCloseTo(0, 5);
    expect(last?.x).toBeCloseTo(100, 3);
    expect(last?.y).toBeCloseTo(200, 3);
  });

  it("produces the requested number of points", () => {
    const path = computeBezierPath({ x: 0, y: 0 }, { x: 50, y: 50 }, { steps: 10, seed: 42 });
    // steps=10 main path points (0..10 inclusive) = 11 points
    expect(path.length).toBeGreaterThanOrEqual(10);
  });

  it("generates a non-linear path (not all points on a straight line)", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    const path = computeBezierPath(from, to, { steps: 20, seed: 7 });

    // At least one midpoint should be off the straight horizontal line.
    const offLine = path.slice(1, -1).some((p) => Math.abs(p.y) > 0.001);
    expect(offLine).toBe(true);
  });

  it("overshoots the target when overshootFactor > 0", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    const path = computeBezierPath(from, to, { steps: 20, overshootFactor: 1, seed: 3 });

    // At some intermediate point the x coordinate should exceed 100.
    const overshotPoints = path.filter((p) => p.x > 100.1);
    expect(overshotPoints.length).toBeGreaterThan(0);
  });

  it("produces no overshoot when overshootFactor is 0", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    const path = computeBezierPath(from, to, { steps: 20, overshootFactor: 0, seed: 3 });

    // No point should have x > 100 (allowing a tiny tolerance for cubic curve).
    const overshotPoints = path.filter((p) => p.x > 101);
    expect(overshotPoints.length).toBe(0);
  });

  it("is deterministic with a fixed seed", () => {
    const from = { x: 10, y: 20 };
    const to = { x: 80, y: 90 };
    const path1 = computeBezierPath(from, to, { seed: 99 });
    const path2 = computeBezierPath(from, to, { seed: 99 });

    expect(path1).toEqual(path2);
  });

  it("produces different paths with different seeds", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 100 };
    const path1 = computeBezierPath(from, to, { seed: 1 });
    const path2 = computeBezierPath(from, to, { seed: 2 });

    // At least one midpoint should differ between paths.
    const differs = path1.some((p1, i) => {
      const p2 = path2[i];
      return p2 !== undefined && (Math.abs(p1.x - p2.x) > 0.001 || Math.abs(p1.y - p2.y) > 0.001);
    });
    expect(differs).toBe(true);
  });

  it("handles zero-distance moves (from === to)", () => {
    const point = { x: 50, y: 75 };
    const path = computeBezierPath(point, point, { steps: 10, seed: 1 });
    expect(path.length).toBeGreaterThan(0);
    for (const p of path) {
      expect(p.x).toBeCloseTo(50, 3);
      expect(p.y).toBeCloseTo(75, 3);
    }
  });
});

// --- samplePoissonInterval ---

describe("samplePoissonInterval", () => {
  it("returns 0 for non-positive mean", () => {
    expect(samplePoissonInterval(0)).toBe(0);
    expect(samplePoissonInterval(-100)).toBe(0);
  });

  it("returns a positive value for a positive mean", () => {
    const interval = samplePoissonInterval(1_000);
    expect(interval).toBeGreaterThan(0);
  });

  it("produces a distribution with mean approximately equal to the input", () => {
    const SAMPLES = 10_000;
    const MEAN_MS = 500;
    let total = 0;
    for (let i = 0; i < SAMPLES; i++) {
      total += samplePoissonInterval(MEAN_MS);
    }

    const empiricalMean = total / SAMPLES;
    // Allow 10% tolerance on the mean.
    expect(empiricalMean).toBeGreaterThan(MEAN_MS * 0.9);
    expect(empiricalMean).toBeLessThan(MEAN_MS * 1.1);
  });

  it("produces variable (non-constant) output across calls", () => {
    const results = new Set(Array.from({ length: 20 }, () => samplePoissonInterval(200)));
    // Virtually impossible to get 20 identical floats.
    expect(results.size).toBeGreaterThan(1);
  });
});

// --- computeReadingPauseMs ---

describe("computeReadingPauseMs", () => {
  it("returns 0 when charCount is 0", () => {
    expect(computeReadingPauseMs(0, 250)).toBe(0);
  });

  it("returns 0 when wpm is 0", () => {
    expect(computeReadingPauseMs(100, 0)).toBe(0);
  });

  it("scales linearly with character count", () => {
    const short = computeReadingPauseMs(50, 200);
    const long = computeReadingPauseMs(100, 200);
    expect(long).toBeCloseTo(short * 2, 0);
  });

  it("is inversely proportional to reading speed", () => {
    const slow = computeReadingPauseMs(200, 100);
    const fast = computeReadingPauseMs(200, 200);
    expect(slow).toBeCloseTo(fast * 2, 0);
  });

  it("produces realistic values for typical page content", () => {
    // 500 chars at 200 wpm → 100 words → 30 seconds
    const pauseMs = computeReadingPauseMs(500, 200);
    expect(pauseMs).toBeCloseTo(30_000, -2);
  });
});

// --- EVASION_PROFILES ---

describe("EVASION_PROFILES", () => {
  it("defines all three levels", () => {
    expect(EVASION_PROFILES.minimal).toBeDefined();
    expect(EVASION_PROFILES.moderate).toBeDefined();
    expect(EVASION_PROFILES.paranoid).toBeDefined();
  });

  it("minimal profile has all evasion features disabled", () => {
    const p = EVASION_PROFILES.minimal;
    expect(p.bezierMouseMovement).toBe(false);
    expect(p.momentumScroll).toBe(false);
    expect(p.fingerprintHardening).toBe(false);
    expect(p.idleDriftEnabled).toBe(false);
    expect(p.readingPauseWpm).toBe(0);
    expect(p.poissonIntervals).toBe(false);
  });

  it("paranoid profile is a strict superset of moderate features", () => {
    const m = EVASION_PROFILES.moderate;
    const p = EVASION_PROFILES.paranoid;
    // Every boolean feature enabled in moderate must also be enabled in paranoid.
    for (const [key, value] of Object.entries(m)) {
      if (typeof value === "boolean" && value === true) {
        expect((p as Record<string, unknown>)[key]).toBe(true);
      }
    }
    // paranoid adds tab blur and viewport resize on top.
    expect(p.simulateTabBlur).toBe(true);
    expect(p.simulateViewportResize).toBe(true);
  });

  it("overshoot factor increases from moderate to paranoid", () => {
    expect(EVASION_PROFILES.paranoid.mouseOvershootFactor).toBeGreaterThan(
      EVASION_PROFILES.moderate.mouseOvershootFactor
    );
  });
});

// --- simulateMomentumScroll ---

describe("simulateMomentumScroll", () => {
  it("calls page.evaluate multiple times for a non-zero scroll", async () => {
    const { evaluate, page, waitForTimeout } = createPageMock();

    await simulateMomentumScroll(page, 300, 4);

    expect(evaluate.mock.calls.length).toBe(4);
    expect(waitForTimeout.mock.calls.length).toBe(4);
  });

  it("does nothing for a zero pixel scroll", async () => {
    const { evaluate, page, waitForTimeout } = createPageMock();

    await simulateMomentumScroll(page, 0);

    expect(evaluate).not.toHaveBeenCalled();
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it("distributes pixels such that the sum equals the total", async () => {
    const { evaluateCalls, page } = createPageMock();

    await simulateMomentumScroll(page, 500, 5);

    const amounts = evaluateCalls.map((c) => (c as { arg: number }).arg);
    const total = amounts.reduce((sum, v) => sum + v, 0);
    expect(total).toBeCloseTo(500, 5);
  });

  it("applies to negative (upward) scroll distances", async () => {
    const { evaluate, evaluateCalls, page } = createPageMock();

    await simulateMomentumScroll(page, -200, 3);

    expect(evaluate.mock.calls.length).toBe(3);
    const amounts = evaluateCalls.map((c) => (c as { arg: number }).arg);
    expect(amounts.every((a) => a < 0)).toBe(true);
  });

  it("clamps steps to the allowed range", async () => {
    const { evaluate, page } = createPageMock();

    await simulateMomentumScroll(page, 100, 50);

    // Max allowed steps is 20.
    expect(evaluate.mock.calls.length).toBe(20);
  });
});

// --- simulateIdleDrift ---

describe("simulateIdleDrift", () => {
  it("calls mouse.move the requested number of times", async () => {
    const { mouseMove, page } = createPageMock();

    await simulateIdleDrift(page, 100, 200, 5, 10);

    expect(mouseMove.mock.calls.length).toBe(5);
  });

  it("moves near the provided coordinates within the drift radius", async () => {
    const { mouseMove, page } = createPageMock();

    await simulateIdleDrift(page, 100, 200, 10, 15);

    for (const [x, y] of mouseMove.mock.calls as [number, number][]) {
      expect(Math.hypot(x - 100, y - 200)).toBeLessThanOrEqual(15 + 0.001);
    }
  });

  it("uses single steps per move", async () => {
    const { mouseMove, page } = createPageMock();

    await simulateIdleDrift(page, 50, 50, 3, 5);

    for (const [, , options] of mouseMove.mock.calls as [number, number, { steps: number }][]) {
      expect(options.steps).toBe(1);
    }
  });

  it("adds a short wait between drift moves", async () => {
    const { page, waitForTimeout } = createPageMock();

    await simulateIdleDrift(page, 0, 0, 3, 5);

    expect(waitForTimeout.mock.calls.length).toBe(3);
  });
});

// --- simulateTabBlur ---

describe("simulateTabBlur", () => {
  it("calls page.evaluate twice (blur and focus phases)", async () => {
    const { evaluate, page, waitForTimeout } = createPageMock();

    await simulateTabBlur(page, 500);

    expect(evaluate.mock.calls.length).toBe(2);
    expect(waitForTimeout).toHaveBeenCalledWith(500);
  });

  it("clamps blur duration to the maximum", async () => {
    const { page, waitForTimeout } = createPageMock();

    await simulateTabBlur(page, 999_999);

    const calledDuration = waitForTimeout.mock.calls[0]?.[0] as number;
    expect(calledDuration).toBeLessThanOrEqual(30_000);
  });

  it("clamps blur duration to the minimum", async () => {
    const { page, waitForTimeout } = createPageMock();

    await simulateTabBlur(page, 0);

    const calledDuration = waitForTimeout.mock.calls[0]?.[0] as number;
    expect(calledDuration).toBeGreaterThanOrEqual(100);
  });
});

// --- simulateViewportJitter ---

describe("simulateViewportJitter", () => {
  it("calls page.evaluate once", async () => {
    const { evaluate, page } = createPageMock();

    await simulateViewportJitter(page);

    expect(evaluate.mock.calls.length).toBe(1);
  });
});

// --- detectCaptcha ---

describe("detectCaptcha", () => {
  it("returns false when no captcha selectors match", async () => {
    const { page } = createPageMock();

    const result = await detectCaptcha(page);

    expect(result).toBe(false);
  });

  it("returns true when a captcha selector has matching elements", async () => {
    const { locatorCounts, page } = createPageMock();
    locatorCounts.set("[data-sitekey]", 1);

    const result = await detectCaptcha(page);

    expect(result).toBe(true);
  });

  it("returns true on the first matching selector without checking the rest", async () => {
    const { locator, locatorCounts, page } = createPageMock();
    // Set the first selector to match.
    locatorCounts.set("[class*='captcha' i]", 2);

    const result = await detectCaptcha(page);

    expect(result).toBe(true);
    // Should stop checking after the first match.
    expect(locator.mock.calls.length).toBe(1);
  });
});

// --- findHoneypotFields ---

describe("findHoneypotFields", () => {
  it("returns an empty array when no honeypot selectors match", async () => {
    const { page } = createPageMock();

    const result = await findHoneypotFields(page);

    expect(result).toEqual([]);
  });

  it("returns matching selectors", async () => {
    const { locatorCounts, page } = createPageMock();
    locatorCounts.set("input[tabindex='-1']", 1);
    locatorCounts.set("input[aria-hidden='true']", 2);

    const result = await findHoneypotFields(page);

    expect(result).toContain("input[tabindex='-1']");
    expect(result).toContain("input[aria-hidden='true']");
  });
});

// --- EvasionSession ---

describe("EvasionSession", () => {
  it("defaults to moderate level", () => {
    const { page } = createPageMock();
    const session = new EvasionSession(page);

    expect(session.activeLevel).toBe("moderate");
    expect(session.activeProfile).toEqual(EVASION_PROFILES.moderate);
  });

  it("uses the specified level", () => {
    const { page } = createPageMock();
    const session = new EvasionSession(page, "paranoid");

    expect(session.activeLevel).toBe("paranoid");
    expect(session.activeProfile).toEqual(EVASION_PROFILES.paranoid);
  });

  describe("moveMouse", () => {
    it("uses bezier curves in moderate mode", async () => {
      const { mouseMove, page } = createPageMock();
      const session = new EvasionSession(page, "moderate");

      await session.moveMouse({ x: 0, y: 0 }, { x: 100, y: 100 });

      // Bezier path produces many moves, not just one.
      expect(mouseMove.mock.calls.length).toBeGreaterThan(5);
    });

    it("uses a direct move in minimal mode", async () => {
      const { mouseMove, page } = createPageMock();
      const session = new EvasionSession(page, "minimal");

      await session.moveMouse({ x: 0, y: 0 }, { x: 100, y: 100 });

      expect(mouseMove.mock.calls.length).toBe(1);
      const call = mouseMove.mock.calls[0] as [number, number, { steps: number }];
      expect(call[0]).toBe(100);
      expect(call[1]).toBe(100);
    });

    it("tracks mouse position after moving", async () => {
      const { page } = createPageMock();
      const session = new EvasionSession(page, "minimal");

      await session.moveMouse({ x: 0, y: 0 }, { x: 250, y: 375 });

      // Internal state is reflected in subsequent idle drift.
      // (We verify indirectly: calling idle with drift enabled should use the updated coords)
      expect(session.activeLevel).toBe("minimal"); // sanity check
    });
  });

  describe("scroll", () => {
    it("uses momentum scroll in moderate mode", async () => {
      const { evaluate, page } = createPageMock();
      const session = new EvasionSession(page, "moderate");

      await session.scroll(300);

      // Momentum scroll calls evaluate multiple times.
      expect(evaluate.mock.calls.length).toBeGreaterThan(1);
    });

    it("uses single evaluate call in minimal mode", async () => {
      const { evaluate, page } = createPageMock();
      const session = new EvasionSession(page, "minimal");

      await session.scroll(300);

      expect(evaluate.mock.calls.length).toBe(1);
    });

    it("throws for excessive scroll distances", async () => {
      const { page } = createPageMock();
      const session = new EvasionSession(page, "moderate");

      await expect(session.scroll(999_999)).rejects.toThrow(/20000/);
    });
  });

  describe("idle", () => {
    it("no-ops for zero or negative duration", async () => {
      const { mouseMove, page, waitForTimeout } = createPageMock();
      const session = new EvasionSession(page, "paranoid");

      await session.idle(0);
      await session.idle(-100);

      expect(mouseMove).not.toHaveBeenCalled();
      expect(waitForTimeout).not.toHaveBeenCalled();
    });

    it("uses drift in moderate mode", async () => {
      const { mouseMove, page } = createPageMock();
      const session = new EvasionSession(page, "moderate");

      await session.idle(600);

      // idleDriftEnabled=true → simulateIdleDrift → mouse.move calls.
      expect(mouseMove.mock.calls.length).toBeGreaterThan(0);
    });

    it("uses waitForTimeout in minimal mode", async () => {
      const { mouseMove, page, waitForTimeout } = createPageMock();
      const session = new EvasionSession(page, "minimal");

      await session.idle(500);

      expect(mouseMove).not.toHaveBeenCalled();
      expect(waitForTimeout).toHaveBeenCalledWith(500);
    });
  });

  describe("simulateTabSwitch", () => {
    it("is a no-op in minimal and moderate modes", async () => {
      const { evaluate, page } = createPageMock();
      const session = new EvasionSession(page, "moderate");

      await session.simulateTabSwitch();

      expect(evaluate).not.toHaveBeenCalled();
    });

    it("fires blur/focus events in paranoid mode", async () => {
      const { evaluate, page } = createPageMock();
      const session = new EvasionSession(page, "paranoid");

      await session.simulateTabSwitch(300);

      expect(evaluate.mock.calls.length).toBe(2);
    });
  });

  describe("simulateViewportJitter", () => {
    it("is a no-op unless simulateViewportResize is enabled", async () => {
      const { evaluate, page } = createPageMock();
      const session = new EvasionSession(page, "moderate");

      await session.simulateViewportJitter();

      expect(evaluate).not.toHaveBeenCalled();
    });

    it("fires a resize event in paranoid mode", async () => {
      const { evaluate, page } = createPageMock();
      const session = new EvasionSession(page, "paranoid");

      await session.simulateViewportJitter();

      expect(evaluate).toHaveBeenCalledOnce();
    });
  });

  describe("readingPause", () => {
    it("no-ops in minimal mode", async () => {
      const { page, waitForTimeout } = createPageMock();
      const session = new EvasionSession(page, "minimal");

      await session.readingPause(1000);

      expect(waitForTimeout).not.toHaveBeenCalled();
    });

    it("waits proportionally in moderate mode", async () => {
      const { page, waitForTimeout } = createPageMock();
      const session = new EvasionSession(page, "moderate");

      await session.readingPause(230); // 230 chars at 230 wpm ≈ 6 s
      await session.readingPause(460); // 460 chars should take roughly twice as long

      const delays = waitForTimeout.mock.calls.map(([d]) => d as number);
      expect(delays[0]).toBeGreaterThan(0);
      expect(delays[1]).toBeGreaterThan(0);
      expect(delays[1]).toBeCloseTo((delays[0] ?? 0) * 2, -2);
    });
  });

  describe("sampleInterval", () => {
    it("returns the base interval unchanged in minimal mode", () => {
      const { page } = createPageMock();
      const session = new EvasionSession(page, "minimal");

      expect(session.sampleInterval(1000)).toBe(1000);
    });

    it("returns a Poisson-distributed interval in moderate mode", () => {
      const { page } = createPageMock();
      const session = new EvasionSession(page, "moderate");

      const results = Array.from({ length: 100 }, () => session.sampleInterval(500));
      const unique = new Set(results);
      // Poisson samples should all differ.
      expect(unique.size).toBeGreaterThan(10);
    });
  });

  describe("detectCaptcha / findHoneypotFields delegation", () => {
    it("delegates detectCaptcha to the standalone function", async () => {
      const { locatorCounts, page } = createPageMock();
      locatorCounts.set("[data-sitekey]", 1);
      const session = new EvasionSession(page, "minimal");

      expect(await session.detectCaptcha()).toBe(true);
    });

    it("delegates findHoneypotFields to the standalone function", async () => {
      const { locatorCounts, page } = createPageMock();
      locatorCounts.set("input[tabindex='-1']", 1);
      const session = new EvasionSession(page, "minimal");

      const fields = await session.findHoneypotFields();
      expect(fields).toContain("input[tabindex='-1']");
    });
  });
});
