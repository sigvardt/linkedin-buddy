import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { TypingProfile } from "../humanize.js";
import {
  attachHumanizeLogger,
  HumanizedPage,
  getAdjacentTypoCandidates
} from "../humanize.js";

function createStableTypingOptions(overrides: Partial<TypingProfile> = {}) {
  return {
    profile: "careful" as const,
    profileOverrides: {
      baseCharDelayMs: 0,
      burstWordMultiplier: 1,
      charDelayJitterMs: 0,
      correctionPauseRange: { minMs: 0, maxMs: 0 },
      correctionResumeRange: { minMs: 0, maxMs: 0 },
      doubleBackspaceRate: 0,
      longPauseChance: 0,
      longPauseRange: { minMs: 0, maxMs: 0 },
      midWordMultiplier: 1,
      punctuationMultiplier: 1,
      repeatedCharacterMultiplier: 1,
      shiftLeadRange: { minMs: 0, maxMs: 0 },
      shiftMissRate: 0,
      thinkingPauseChance: 0,
      thinkingPauseRange: { minMs: 0, maxMs: 0 },
      typoRate: 0,
      whitespaceMultiplier: 1,
      wordBoundaryMultiplier: 1,
      ...overrides
    }
  };
}

function createPageMock() {
  const waitForTimeout = vi.fn(async () => {});
  const click = vi.fn(async () => {});
  const fill = vi.fn(async () => {});
  const scrollIntoViewIfNeeded = vi.fn(async () => {});
  const boundingBox = vi.fn(async () => null);

  const locator = {
    boundingBox,
    click,
    fill,
    first: vi.fn(),
    scrollIntoViewIfNeeded
  };
  locator.first.mockReturnValue(locator);

  const keyboard = {
    down: vi.fn(async () => {}),
    insertText: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    up: vi.fn(async () => {})
  };

  const page = {
    evaluate: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    keyboard,
    locator: vi.fn(() => locator),
    mouse: {
      move: vi.fn(async () => {})
    },
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout
  } as unknown as Page;

  return {
    boundingBox,
    click,
    fill,
    keyboard,
    locator,
    page,
    scrollIntoViewIfNeeded,
    waitForTimeout
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("HumanizedPage hardening", () => {
  it("falls back to direct input when simulated typing fails", async () => {
    const { fill, keyboard, page } = createPageMock();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    keyboard.type.mockRejectedValueOnce(new Error("keyboard failed"));
    const humanizedPage = new HumanizedPage(page, { baseDelay: 0, jitterRange: 0 });

    await humanizedPage.type("#composer", "hello", createStableTypingOptions());

    expect(fill).toHaveBeenCalledWith("hello", { timeout: 10_000 });
    expect(consoleWarn).toHaveBeenCalled();
    expect(
      consoleWarn.mock.calls.some(
        ([message]) =>
          typeof message === "string" && message.includes("humanize.typing.degraded")
      )
    ).toBe(true);
  });

  it("releases Shift before degrading when uppercase typing fails", async () => {
    const { fill, keyboard, page } = createPageMock();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    keyboard.press.mockRejectedValueOnce(new Error("shift press failed"));
    const humanizedPage = new HumanizedPage(page, { baseDelay: 0, jitterRange: 0 });

    await humanizedPage.type("#composer", "A", createStableTypingOptions());

    expect(keyboard.down).toHaveBeenCalledWith("Shift");
    expect(keyboard.up).toHaveBeenCalledWith("Shift");
    expect(fill).toHaveBeenCalledWith("A", { timeout: 10_000 });
  });

  it("degrades long Unicode text to direct input before simulating", async () => {
    const { fill, keyboard, page } = createPageMock();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const humanizedPage = new HumanizedPage(page, { baseDelay: 0, jitterRange: 0 });
    const text = "👩🏽‍💻".repeat(501);

    await humanizedPage.type("#composer", text, createStableTypingOptions());

    expect(fill).toHaveBeenCalledWith(text, { timeout: 10_000 });
    expect(keyboard.type).not.toHaveBeenCalled();
  });

  it("validates invalid public inputs with clear errors", async () => {
    const { page } = createPageMock();
    const humanizedPage = new HumanizedPage(page, { baseDelay: 0, jitterRange: 0 });

    expect(() => new HumanizedPage(page, { jitterRange: -1 })).toThrow(/jitterRange/);
    expect(() => getAdjacentTypoCandidates(42 as unknown as string)).toThrow(/character/);
    await expect(humanizedPage.type("", "ok")).rejects.toThrow(/selector/);
    expect(
      () => new HumanizedPage(page, { typingProfiles: "fast" } as unknown as never)
    ).toThrow(/Did you mean "typingProfile"/);
    await expect(
      humanizedPage.type("#composer", "ok", {
        profileOverrides: {
          typoChance: 0.2
        } as unknown as Partial<TypingProfile>
      })
    ).rejects.toThrow(/Did you mean "typoRate"/);
  });

  it("emits logger-backed typing start and completion events with field labels", async () => {
    const { page } = createPageMock();
    const logger = {
      log: vi.fn()
    };
    attachHumanizeLogger(page, logger);
    const humanizedPage = new HumanizedPage(page, { baseDelay: 0, jitterRange: 0 });

    await humanizedPage.type("#composer", "hello", {
      ...createStableTypingOptions(),
      fieldLabel: "email"
    });

    expect(logger.log).toHaveBeenCalledWith(
      "info",
      "humanize.typing.start",
      expect.objectContaining({
        field_label: "email",
        graphemeCount: 5,
        typing_profile: "careful"
      })
    );
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      "humanize.typing.done",
      expect.objectContaining({
        field_label: "email",
        mode: "simulated"
      })
    );
  });
});
