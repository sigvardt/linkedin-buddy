import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { HumanizeOptions } from "../humanize.js";
import { HumanizedPage, humanize } from "../humanize.js";

function createPageMock() {
  const waitForTimeout = vi.fn(async () => undefined);
  const page = {
    waitForTimeout
  } as unknown as Page;
  return { page, waitForTimeout };
}

function getCalledDelay(waitForTimeout: ReturnType<typeof vi.fn>): number {
  const value = waitForTimeout.mock.calls[0]?.[0];
  if (typeof value !== "number") {
    throw new Error("waitForTimeout was not called with a numeric delay");
  }
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HumanizedPage.delay", () => {
  it("adds jitter within expected range", async () => {
    const { page, waitForTimeout } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 500, jitterRange: 200 });

    await humanizedPage.delay();

    const delayMs = getCalledDelay(waitForTimeout);
    expect(delayMs).toBeGreaterThanOrEqual(500);
    expect(delayMs).toBeLessThanOrEqual(700);
  });

  it("uses custom baseMs when provided", async () => {
    const { page, waitForTimeout } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 900, jitterRange: 400 });

    await humanizedPage.delay(1_200);

    const delayMs = getCalledDelay(waitForTimeout);
    expect(delayMs).toBeGreaterThanOrEqual(1_200);
    expect(delayMs).toBeLessThanOrEqual(1_600);
  });
});

describe("HumanizedPage options", () => {
  it("fast mode uses shorter default delays", async () => {
    const slowMock = createPageMock();
    const fastMock = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const slowPage = new HumanizedPage(slowMock.page);
    const fastPage = new HumanizedPage(fastMock.page, { fast: true });

    await slowPage.delay();
    await fastPage.delay();

    const slowDelay = getCalledDelay(slowMock.waitForTimeout);
    const fastDelay = getCalledDelay(fastMock.waitForTimeout);
    expect(slowDelay).toBe(800);
    expect(fastDelay).toBe(200);
    expect(fastDelay).toBeLessThan(slowDelay);
  });

  it("merges provided options with defaults", () => {
    const { page } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 950 });
    const internal = humanizedPage as unknown as { options: Required<HumanizeOptions> };

    expect(internal.options).toEqual({
      baseDelay: 950,
      jitterRange: 1500,
      fast: false,
      typingDelay: 80,
      typingJitter: 60
    });
  });
});

describe("humanize", () => {
  it("creates a HumanizedPage wrapper", () => {
    const { page } = createPageMock();
    const wrapped = humanize(page);

    expect(wrapped).toBeInstanceOf(HumanizedPage);
    expect(wrapped.raw).toBe(page);
  });
});
