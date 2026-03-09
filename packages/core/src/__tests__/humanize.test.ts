import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { TypingProfile } from "../humanize.js";
import {
  HumanizedPage,
  QWERTY_KEY_ADJACENCY_MAP,
  getAdjacentTypoCandidates,
  humanize,
  pickAdjacentTypoCharacter,
  TYPING_PROFILES
} from "../humanize.js";

interface MockBoundingBox {
  height: number;
  width: number;
  x: number;
  y: number;
}

function createPageMock(options?: { boundingBox?: MockBoundingBox | null }) {
  const operations: string[] = [];
  const waitForTimeout = vi.fn(async (delay: number) => {
    operations.push(`wait:${delay}`);
  });
  const goto = vi.fn(
    async (
      url: string,
      gotoOptions?: { waitUntil?: "domcontentloaded" | "networkidle" | "load" }
    ) => {
      operations.push(`goto:${url}:${gotoOptions?.waitUntil ?? "domcontentloaded"}`);
    }
  );
  const waitForLoadState = vi.fn(async (state: string) => {
    operations.push(`load:${state}`);
  });
  const scrollIntoViewIfNeeded = vi.fn(async () => {
    operations.push("scroll");
  });
  const boundingBox = vi.fn(async () => options?.boundingBox ?? null);
  const click = vi.fn(async () => {
    operations.push("click");
  });

  const locator = {
    boundingBox,
    click,
    first: vi.fn(),
    scrollIntoViewIfNeeded
  };
  locator.first.mockReturnValue(locator);

  const evaluate = vi.fn(async (callback: unknown, scrollAmount: number) => {
    if (typeof callback === "function") {
      const originalScrollBy = globalThis.scrollBy;
      const scrollBy = vi.fn();
      Object.defineProperty(globalThis, "scrollBy", {
        configurable: true,
        value: scrollBy,
        writable: true
      });

      try {
        (callback as (scrollAmount: number) => void)(scrollAmount);
      } finally {
        Object.defineProperty(globalThis, "scrollBy", {
          configurable: true,
          value: originalScrollBy,
          writable: true
        });
      }
    }

    operations.push(`evaluate:${scrollAmount}`);
  });

  const mouse = {
    move: vi.fn(async (x: number, y: number, moveOptions?: { steps?: number }) => {
      operations.push(`move:${x}:${y}:${moveOptions?.steps ?? 0}`);
    })
  };

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
    evaluate,
    goto,
    keyboard,
    locator: vi.fn(() => locator),
    mouse,
    waitForLoadState,
    waitForTimeout
  } as unknown as Page;

  return {
    boundingBox,
    evaluate,
    goto,
    keyboard,
    mouse,
    operations,
    page,
    waitForLoadState,
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

function getTypedCharacters(keyboard: ReturnType<typeof createPageMock>["keyboard"]): string[] {
  return keyboard.type.mock.calls.flatMap(([value]) =>
    typeof value === "string" ? [value] : []
  );
}

function getInternalOptions(humanizedPage: HumanizedPage) {
  return Reflect.get(humanizedPage, "options") as {
    baseDelay: number;
    fast: boolean;
    jitterRange: number;
    typingDelayOverride: number | null;
    typingJitterOverride: number | null;
    typingProfile: string;
    typingProfileOverrides: Partial<TypingProfile>;
  };
}

function getResolvedTypingProfile(
  humanizedPage: HumanizedPage,
  options?: {
    profile?: "casual" | "careful" | "fast";
    profileOverrides?: Partial<TypingProfile>;
  }
): TypingProfile {
  const resolveTypingProfile = Reflect.get(humanizedPage, "resolveTypingProfile") as (
    options?: {
      profile?: "casual" | "careful" | "fast";
      profileOverrides?: Partial<TypingProfile>;
    }
  ) => TypingProfile;

  return resolveTypingProfile.call(humanizedPage, options);
}

async function typeLiteralCharacter(
  humanizedPage: HumanizedPage,
  character: string,
  profile: TypingProfile
): Promise<void> {
  const typeLiteralCharacterInternal = Reflect.get(humanizedPage, "typeLiteralCharacter") as (
    character: string,
    profile: TypingProfile
  ) => Promise<void>;

  await typeLiteralCharacterInternal.call(humanizedPage, character, profile);
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

    expect(getInternalOptions(humanizedPage)).toEqual({
      baseDelay: 950,
      fast: false,
      jitterRange: 1500,
      typingDelayOverride: null,
      typingJitterOverride: null,
      typingProfile: "careful",
      typingProfileOverrides: {}
    });
  });

  it("resolves typing profile precedence across constructor and call overrides", () => {
    const { page } = createPageMock();
    const humanizedPage = new HumanizedPage(page, {
      typingDelay: 80,
      typingJitter: 12,
      typingProfile: "casual",
      typingProfileOverrides: {
        punctuationMultiplier: 1.9,
        wordBoundaryMultiplier: 1.5
      }
    });

    const resolved = getResolvedTypingProfile(humanizedPage, {
      profile: "fast",
      profileOverrides: {
        whitespaceMultiplier: 2.25
      }
    });

    expect(resolved).toMatchObject({
      baseCharDelayMs: 80,
      charDelayJitterMs: 12,
      punctuationMultiplier: 1.9,
      typoRate: TYPING_PROFILES.fast.typoRate,
      whitespaceMultiplier: 2.25,
      wordBoundaryMultiplier: 1.5
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

  it("returns no typo candidates for unsupported characters", () => {
    expect(getAdjacentTypoCandidates("!")).toEqual([]);
    expect(getAdjacentTypoCandidates("ø")).toEqual([]);
    expect(pickAdjacentTypoCharacter("👋")).toBeNull();
  });

  it("preserves uppercase typos and falls back to the last candidate", () => {
    const candidates = getAdjacentTypoCandidates("t");
    const firstCandidate = candidates[0]?.key;
    const lastCandidate = candidates.at(-1)?.key;

    expect(firstCandidate).toBeTruthy();
    expect(lastCandidate).toBeTruthy();
    expect(pickAdjacentTypoCharacter("T", 0)).toBe(firstCandidate?.toUpperCase());
    expect(pickAdjacentTypoCharacter("T", Number.NaN)).toBe(lastCandidate?.toUpperCase());
  });
});

describe("HumanizedPage.type", () => {
  it("handles empty strings without issuing keyboard events", async () => {
    const { keyboard, page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.type("#composer", "", createStableTypingOptions());

    expect(keyboard.type).not.toHaveBeenCalled();
    expect(keyboard.press).not.toHaveBeenCalled();
    expect(keyboard.down).not.toHaveBeenCalled();
    expect(getWaitCalls(waitForTimeout)).toEqual([200, 150, 200]);
  });

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

  it("types unicode and special characters without splitting code points", async () => {
    const { keyboard, page } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });
    const text = "👋éß\n#!";

    await humanizedPage.type(
      "#composer",
      text,
      createStableTypingOptions({
        typoRate: 1
      })
    );

    expect(getTypedCharacters(keyboard)).toEqual(Array.from(text));
    expect(keyboard.press).not.toHaveBeenCalledWith("Backspace");
  });

  it("produces non-uniform delays across realistic typing contexts", async () => {
    const { page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });
    const text = "a zoo. go!";

    await humanizedPage.type("#composer", text, createStableTypingOptions());

    const charCount = Array.from(text).length;
    const charDelays = getWaitCalls(waitForTimeout).slice(2, 2 + charCount);

    expect(charDelays).toHaveLength(charCount);
    expect(new Set(charDelays.map((delay) => delay.toFixed(2))).size).toBeGreaterThan(4);
    expect(charDelays[6]).toBeGreaterThan(charDelays[1] ?? 0);
    expect(charDelays[7]).toBeGreaterThan(charDelays[2] ?? 0);
  });

  it("adds thinking and long pauses at eligible word boundaries", async () => {
    const { page, waitForTimeout } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.type(
      "#composer",
      "hello world. again there",
      createStableTypingOptions({
        longPauseChance: 1,
        longPauseRange: { minMs: 700, maxMs: 900 },
        thinkingPauseChance: 1,
        thinkingPauseRange: { minMs: 200, maxMs: 260 }
      })
    );

    expect(getWaitCalls(waitForTimeout)).toContain(230);
    expect(getWaitCalls(waitForTimeout)).toContain(800);
  });

  it("waits before uppercase characters when shift lead time is configured", async () => {
    const { page, waitForTimeout } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.type(
      "#composer",
      "A",
      createStableTypingOptions({
        shiftLeadRange: { minMs: 20, maxMs: 40 }
      })
    );

    expect(getWaitCalls(waitForTimeout)).toContain(30);
  });

  it("supports very long strings without introducing correction artifacts", async () => {
    const { keyboard, page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });
    const text = "lorem ipsum dolor sit amet ".repeat(12).trim();

    await humanizedPage.type("#composer", text, createStableTypingOptions());

    expect(getTypedCharacters(keyboard)).toHaveLength(Array.from(text).length);
    expect(keyboard.press).not.toHaveBeenCalledWith("Backspace");
    expect(getWaitCalls(waitForTimeout)).toHaveLength(Array.from(text).length + 3);
  });

  it("keeps rapid sequential calls independent", async () => {
    const { keyboard, page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.type("#composer", "go", createStableTypingOptions());
    await humanizedPage.type("#composer", "ok", createStableTypingOptions());

    expect(getTypedCharacters(keyboard)).toEqual(["g", "o", "o", "k"]);
    expect(keyboard.press).not.toHaveBeenCalledWith("Backspace");
    expect(getWaitCalls(waitForTimeout)).toHaveLength(10);
  });

  it("skips characters when typing contexts are unavailable", async () => {
    const { keyboard, page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    vi.spyOn(
      HumanizedPage.prototype as unknown as {
        buildTypingContexts: (characters: readonly string[]) => [];
      },
      "buildTypingContexts"
    ).mockReturnValue([]);

    await humanizedPage.type("#composer", "abc", createStableTypingOptions());

    expect(keyboard.type).not.toHaveBeenCalled();
    expect(keyboard.press).not.toHaveBeenCalled();
    expect(getWaitCalls(waitForTimeout)).toEqual([200, 150, 200]);
  });
});

describe("HumanizedPage helpers", () => {
  it("navigates with default and custom wait targets", async () => {
    const { goto, page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.navigate("https://example.com");
    await humanizedPage.navigate("https://example.com/feed", { waitUntil: "load" });

    expect(goto).toHaveBeenNthCalledWith(1, "https://example.com", {
      waitUntil: "domcontentloaded"
    });
    expect(goto).toHaveBeenNthCalledWith(2, "https://example.com/feed", {
      waitUntil: "load"
    });
    expect(getWaitCalls(waitForTimeout)).toEqual([300, 600, 300, 600]);
  });

  it("scrolls elements into view and waits afterwards", async () => {
    const { page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.scrollIntoView("#composer");

    expect(page.locator).toHaveBeenCalledWith("#composer");
    expect(getWaitCalls(waitForTimeout)).toEqual([200]);
  });

  it("scrolls down with generated and explicit distances", async () => {
    const { evaluate, page, waitForTimeout } = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.scrollDown();
    await humanizedPage.scrollDown(420);

    expect(evaluate.mock.calls[0]?.[1]).toBe(550);
    expect(evaluate.mock.calls[1]?.[1]).toBe(420);
    expect(getWaitCalls(waitForTimeout)).toEqual([400, 400]);
  });

  it("moves the mouse near a target with light randomness", async () => {
    const { mouse, page, waitForTimeout } = createPageMock();
    const randomValues = [0.9, 0.1, 0.6];
    let randomIndex = 0;
    vi.spyOn(Math, "random").mockImplementation(() => randomValues[randomIndex++] ?? 0);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.moveMouseNear(100, 200);

    expect(mouse.move).toHaveBeenCalledWith(104, 196, { steps: 6 });
    expect(getWaitCalls(waitForTimeout)).toEqual([150]);
  });

  it("clicks with cursor movement when a bounding box is available", async () => {
    const { mouse, page, waitForTimeout } = createPageMock({
      boundingBox: { height: 20, width: 80, x: 100, y: 200 }
    });
    const randomValues = [0.75, 0.25, 0.5];
    let randomIndex = 0;
    vi.spyOn(Math, "random").mockImplementation(() => randomValues[randomIndex++] ?? 0);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.click("#composer");

    const moveCall = mouse.move.mock.calls[0];
    expect(moveCall?.[0]).toBeCloseTo(146);
    expect(moveCall?.[1]).toBeCloseTo(208.5);
    expect(moveCall?.[2]).toEqual({ steps: 5 });
    expect(getWaitCalls(waitForTimeout)).toEqual([200, 100, 300]);
  });

  it("clicks directly when an element has no bounding box", async () => {
    const { mouse, page, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.click("#composer");

    expect(mouse.move).not.toHaveBeenCalled();
    expect(getWaitCalls(waitForTimeout)).toEqual([200, 300]);
  });

  it("waits for the page load state with a human pause", async () => {
    const { page, waitForLoadState, waitForTimeout } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await humanizedPage.waitForPageLoad();

    expect(waitForLoadState).toHaveBeenCalledWith("domcontentloaded");
    expect(getWaitCalls(waitForTimeout)).toEqual([400]);
  });

  it("idles with different ranges in slow and fast modes", async () => {
    const slowMock = createPageMock();
    const fastMock = createPageMock();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const slowPage = new HumanizedPage(slowMock.page);
    const fastPage = new HumanizedPage(fastMock.page, { fast: true });

    await slowPage.idle();
    await fastPage.idle();

    expect(getWaitCalls(slowMock.waitForTimeout)).toEqual([2500]);
    expect(getWaitCalls(fastMock.waitForTimeout)).toEqual([350]);
  });

  it("treats empty literal characters as no-ops internally", async () => {
    const { keyboard, page } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 200, jitterRange: 0 });

    await typeLiteralCharacter(humanizedPage, "", TYPING_PROFILES.careful);

    expect(keyboard.type).not.toHaveBeenCalled();
    expect(keyboard.press).not.toHaveBeenCalled();
    expect(keyboard.down).not.toHaveBeenCalled();
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
