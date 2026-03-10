import type { Page } from "playwright-core";
import { vi } from "vitest";

export interface EvaluateCall {
  callback: unknown;
  arg: unknown;
}

export interface PageMockOptions {
  includeAddInitScript?: boolean;
  viewportSize?: { width: number; height: number } | null;
  evaluateError?: Error;
  addInitScriptError?: Error;
  waitForTimeoutError?: Error;
  mouseMoveError?: Error;
  locatorErrorSelectors?: ReadonlySet<string>;
}

export function createPageMock(options?: PageMockOptions) {
  const waitForTimeout = vi.fn(async (delayMs: number) => {
    if (options?.waitForTimeoutError !== undefined) {
      throw options.waitForTimeoutError;
    }

    void delayMs;
  });
  const mouseMove = vi.fn(
    async (x: number, y: number, moveOptions?: { steps?: number }) => {
      if (options?.mouseMoveError !== undefined) {
        throw options.mouseMoveError;
      }

      void x;
      void y;
      void moveOptions;
    }
  );
  const evaluateCalls: EvaluateCall[] = [];
  const addInitScriptCalls: EvaluateCall[] = [];
  const locatorCounts = new Map<string, number>();

  const evaluate = vi.fn(async (callback: unknown, arg?: unknown) => {
    if (options?.evaluateError !== undefined) {
      throw options.evaluateError;
    }

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

  const addInitScript = vi.fn(async (callback: unknown, arg?: unknown) => {
    if (options?.addInitScriptError !== undefined) {
      throw options.addInitScriptError;
    }

    addInitScriptCalls.push({ callback, arg });
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
    count: vi.fn(async () => {
      if (options?.locatorErrorSelectors?.has(selector)) {
        throw new Error(`Unable to count selector: ${selector}`);
      }

      return locatorCounts.get(selector) ?? 0;
    })
  }));

  const viewportSize = vi.fn(() => options?.viewportSize ?? null);
  const pageRecord: Record<string, unknown> = {
    evaluate,
    locator,
    mouse: { move: mouseMove },
    waitForTimeout
  };

  if (options?.includeAddInitScript === true || options?.addInitScriptError !== undefined) {
    pageRecord["addInitScript"] = addInitScript;
  }

  if (options?.viewportSize !== undefined) {
    pageRecord["viewportSize"] = viewportSize;
  }

  const page = pageRecord as unknown as Page;

  return {
    addInitScript,
    addInitScriptCalls,
    evaluate,
    evaluateCalls,
    locator,
    locatorCounts,
    mouseMove,
    page,
    viewportSize,
    waitForTimeout
  };
}
