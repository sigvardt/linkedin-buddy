import type { Page } from "playwright-core";
import { vi } from "vitest";

export interface EvaluateCall {
  callback: unknown;
  arg: unknown;
}

export function createPageMock() {
  const waitForTimeout = vi.fn(async (delayMs: number) => {
    void delayMs;
  });
  const mouseMove = vi.fn(
    async (x: number, y: number, options?: { steps?: number }) => {
      void x;
      void y;
      void options;
    }
  );
  const evaluateCalls: EvaluateCall[] = [];
  const locatorCounts = new Map<string, number>();

  const evaluate = vi.fn(async (callback: unknown, arg?: unknown) => {
    evaluateCalls.push({ callback, arg });
    if (typeof callback === "function") {
      try {
        (callback as (value?: unknown) => unknown)(arg);
      } catch {
        return undefined;
      }
    }

    return undefined;
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
