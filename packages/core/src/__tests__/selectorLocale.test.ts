import { describe, expect, it } from "vitest";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  getLinkedInSelectorPhrases,
  resolveLinkedInSelectorLocale
} from "../selectorLocale.js";

describe("resolveLinkedInSelectorLocale", () => {
  it("normalizes region-specific locales to the supported base locale", () => {
    expect(resolveLinkedInSelectorLocale("da-DK")).toBe("da");
    expect(resolveLinkedInSelectorLocale("EN_us")).toBe("en");
  });

  it("falls back to english for unsupported locales", () => {
    expect(resolveLinkedInSelectorLocale("fr")).toBe("en");
    expect(resolveLinkedInSelectorLocale(undefined)).toBe("en");
  });
});

describe("getLinkedInSelectorPhrases", () => {
  it("returns locale-specific phrases before english fallbacks", () => {
    expect(getLinkedInSelectorPhrases("connect", "da")).toEqual([
      "Opret forbindelse",
      "Forbind",
      "Connect"
    ]);
  });

  it("deduplicates english fallback phrases when the locale already shares them", () => {
    expect(getLinkedInSelectorPhrases("send", "da")).toEqual(["Send"]);
  });
});

describe("buildLinkedInSelectorPhraseRegex", () => {
  it("matches both localized phrases and english fallback phrases", () => {
    const regex = buildLinkedInSelectorPhraseRegex("connect", "da", {
      exact: true
    });

    expect(regex.test("Opret forbindelse")).toBe(true);
    expect(regex.test("Connect")).toBe(true);
    expect(regex.test("Invite to connect")).toBe(false);
  });
});

describe("buildLinkedInAriaLabelContainsSelector", () => {
  it("builds locale-aware aria-label selectors with english fallback", () => {
    const selector = buildLinkedInAriaLabelContainsSelector(
      "button",
      "comment",
      "da"
    );

    expect(selector).toContain('button[aria-label*="Kommenter" i]');
    expect(selector).toContain('button[aria-label*="Comment" i]');
  });
});
