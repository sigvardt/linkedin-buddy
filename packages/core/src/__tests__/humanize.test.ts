import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { TypingProfile } from "../humanize.js";
import {
  HumanizedPage,
  QWERTY_KEY_ADJACENCY_MAP,
  getAdjacentTypoCandidates,
  humanize
} from "../humanize.js";

function createPageMock() {
  const operations: string[] = [];
  const waitForTimeout = vi.fn(async (delay: number) => {
    operations.push(`wait:${delay}`);
  });
  const scrollIntoViewIfNeeded = vi.fn(async () => {
    operations.push("scroll");
  });
  const click = vi.fn(async () => {
    operations.push("click");
  });

  const locator = {
    click,
    first: vi.fn(),
    scrollIntoViewIfNeeded
  };
  locator.first.mockReturnValue(locator);

  const keyboard = {
    down: vi.fn(async (key: string) => {
      operations.push(`down:${key}`);
    }),
    press: vi.fn(async (key: string) => {
      operations.push(`press:${key}`);
    }),
    type: vi.fn(async (text: string) => {
      operations.push(`type:${text}`);
    }),
    up: vi.fn(async (key: string) => {
      operations.push(`up:${key}`);
    })
  };

  const page = {
    keyboard,
    locator: vi.fn(() => locator),
    waitForTimeout
  } as unknown as Page;

  return {
    click,
    keyboard,
    operations,
    page,
    scrollIntoViewIfNeeded,
    waitForTimeout
  };
}

function getCalledDelay(waitForTimeout: ReturnType<typeof vi.fn>): number {
  const value = waitForTimeout.mock.calls[0]?.[0];
  if (typeof value !== "number") {
    throw new Error("waitForTimeout was not called with a numeric delay");
  }
  return value;
}

function getWaitCalls(waitForTimeout: ReturnType<typeof vi.fn>): number[] {
  return waitForTimeout.mock.calls.flatMap(([value]) =>
    typeof value === "number" ? [value] : []
  );
}

function createStableTypingOptions(overrides: Partial<TypingProfile> = {}) {
  return {
    profile: "careful" as const,
    profileOverrides: {
      baseCharDelayMs: 100,
      burstWordMultiplier: 0.82,
      charDelayJitterMs: 0,
      correctionPauseRange: { minMs: 50, maxMs: 50 },
      correctionResumeRange: { minMs: 30, maxMs: 30 },
      doubleBackspaceRate: 0,
      longPauseChance: 0,
      midWordMultiplier: 0.9,
      punctuationMultiplier: 1.35,
      repeatedCharacterMultiplier: 0.9,
      shiftLeadRange: { minMs: 0, maxMs: 0 },
      shiftMissRate: 0,
      thinkingPauseChance: 0,
      typoRate: 0,
      whitespaceMultiplier: 1.25,
      wordBoundaryMultiplier: 1.18,
      ...overrides
    }
  };
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
    const internal = humanizedPage as unknown as {
      options: {
        baseDelay: number;
        fast: boolean;
        jitterRange: number;
        typingDelayOverride: number | null;
        typingJitterOverride: number | null;
        typingProfile: string;
        typingProfileOverrides: Partial<TypingProfile>;
      };
    };

    expect(internal.options).toEqual({
      baseDelay: 950,
      fast: false,
      jitterRange: 1500,
      typingDelayOverride: null,
      typingJitterOverride: null,
      typingProfile: "careful",
      typingProfileOverrides: {}
    });
  });
});

describe("QWERTY adjacency", () => {
  it("covers every alphanumeric key on the keyboard", () => {
    const expectedKeys = Array.from("1234567890qwertyuiopasdfghjklzxcvbnm").sort();
    const actualKeys = Object.keys(QWERTY_KEY_ADJACENCY_MAP).sort();

    expect(actualKeys).toEqual(expectedKeys);
    for (const key of actualKeys) {
      expect(QWERTY_KEY_ADJACENCY_MAP[key]).toBeDefined();
      expect(QWERTY_KEY_ADJACENCY_MAP[key]?.length).toBeGreaterThan(0);
    }
  });

  it("weights same-finger neighbors higher than cross-hand neighbors", () => {
    const candidates = getAdjacentTypoCandidates("t");
    const sameFinger = candidates.find((candidate) => candidate.key === "r");
    const crossHand = candidates.find((candidate) => candidate.key === "y");

    expect(sameFinger?.weight).toBeGreaterThan(0);
    expect(crossHand?.weight).toBeGreaterThan(0);
    expect(sameFinger?.weight).toBeGreaterThan(crossHand?.weight ?? 0);
  });
});

describe("HumanizedPage.type", () => {
  it("inserts and corrects adjacent typos naturally", async () => {
    const { keyboard, page, operations, waitForTimeout } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.type("#composer", "t", createStableTypingOptions({ typoRate: 1 }));

    const mistypedCharacter = keyboard.type.mock.calls[0]?.[0];
    expect(mistypedCharacter).toBeTruthy();
    expect(mistypedCharacter).not.toBe("t");
    expect(operations.indexOf(`type:${mistypedCharacter}`)).toBeLessThan(
      operations.indexOf("press:Backspace")
    );
    expect(keyboard.press).toHaveBeenCalledWith("Backspace");
    expect(keyboard.type).toHaveBeenLastCalledWith("t", { delay: 0 });
    expect(getWaitCalls(waitForTimeout)).toContain(50);
    expect(getWaitCalls(waitForTimeout)).toContain(30);
  });

  it("can double-backspace and retype the previous character", async () => {
    const { page, operations } = createPageMock();
    const randomValues = [0.9, 0, 0];
    let randomIndex = 0;
    vi.spyOn(Math, "random").mockImplementation(() => randomValues[randomIndex++] ?? 0);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.type(
      "#composer",
      "at",
      createStableTypingOptions({ doubleBackspaceRate: 1, typoRate: 0.5 })
    );

    expect(operations.filter((operation) => operation === "press:Backspace")).toHaveLength(2);
    const typeOperations = operations.filter((operation) => operation.startsWith("type:"));
    expect(typeOperations[0]).toBe("type:a");
    expect(typeOperations.at(-2)).toBe("type:a");
    expect(typeOperations.at(-1)).toBe("type:t");
  });

  it("varies cadence across burst words and word boundaries", async () => {
    const { page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.type("#composer", "the test", createStableTypingOptions());

    const charDelays = getWaitCalls(waitForTimeout).slice(2, 10);
    expect(charDelays).toHaveLength(8);
    expect(charDelays[0]).toBeGreaterThan(charDelays[1] ?? 0);
    expect(charDelays[3]).toBeGreaterThan(charDelays[1] ?? 0);
    expect(charDelays[1]).toBeLessThan(charDelays[5] ?? Number.POSITIVE_INFINITY);
  });

  it("corrects missed shift capitalization mistakes", async () => {
    const { page, operations } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.type("#composer", "A", createStableTypingOptions({ shiftMissRate: 1 }));

    expect(operations.indexOf("type:a")).toBeLessThan(operations.indexOf("press:Backspace"));
    expect(operations).toContain("down:Shift");
    expect(operations).toContain("press:a");
    expect(operations).toContain("up:Shift");
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
