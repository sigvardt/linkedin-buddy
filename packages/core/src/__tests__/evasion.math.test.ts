import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeBezierPath,
  computeMomentumSteps,
  computeReadingPauseMs,
  samplePoissonInterval
} from "../evasion/math.js";
import { MAX_BEZIER_STEPS, MAX_READING_WPM, MIN_BEZIER_STEPS } from "../evasion/shared.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("math evasion helpers", () => {
  describe("computeBezierPath", () => {
    it("clamps the number of generated steps to the supported bounds", () => {
      const from = { x: 0, y: 0 };
      const to = { x: 100, y: 50 };

      expect(computeBezierPath(from, to, { steps: 1, seed: 1 })).toHaveLength(MIN_BEZIER_STEPS + 1);
      expect(computeBezierPath(from, to, { steps: MAX_BEZIER_STEPS + 1, seed: 1 })).toHaveLength(
        MAX_BEZIER_STEPS + 1
      );
    });

    it("clamps overshoot factors into the supported range", () => {
      const from = { x: 0, y: 0 };
      const to = { x: 100, y: 0 };

      expect(computeBezierPath(from, to, { overshootFactor: -5, seed: 3 })).toEqual(
        computeBezierPath(from, to, { overshootFactor: 0, seed: 3 })
      );
      expect(computeBezierPath(from, to, { overshootFactor: 99, seed: 3 })).toEqual(
        computeBezierPath(from, to, { overshootFactor: 1, seed: 3 })
      );
    });

    it("keeps zero-distance overshoot paths stationary", () => {
      const point = { x: 42, y: 99 };
      const path = computeBezierPath(point, point, { overshootFactor: 1, steps: 20, seed: 7 });

      expect(path).toHaveLength(21);
      for (const currentPoint of path) {
        expect(currentPoint).toEqual(point);
      }
    });
  });

  describe("computeMomentumSteps", () => {
    it("returns a single step when asked for one", () => {
      expect(computeMomentumSteps(120, 1)).toEqual([120]);
    });

    it("preserves the total distance across positive and negative motion", () => {
      const downward = computeMomentumSteps(300, 4);
      const upward = computeMomentumSteps(-300, 4);

      expect(downward).toHaveLength(4);
      expect(upward).toHaveLength(4);
      expect(downward.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(300, 10);
      expect(upward.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(-300, 10);
      expect(downward.map((amount) => Math.abs(amount))).toEqual(
        [...downward].map((amount) => Math.abs(amount)).sort((left, right) => right - left)
      );
    });
  });

  describe("samplePoissonInterval", () => {
    it("remains finite when Math.random reaches zero", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);

      const interval = samplePoissonInterval(250);

      expect(interval).toBeGreaterThan(0);
      expect(Number.isFinite(interval)).toBe(true);
    });
  });

  describe("computeReadingPauseMs", () => {
    it("clamps reading speed to the configured maximum", () => {
      expect(computeReadingPauseMs(500, MAX_READING_WPM + 10_000)).toBe(
        computeReadingPauseMs(500, MAX_READING_WPM)
      );
    });
  });
});
