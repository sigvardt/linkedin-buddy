import { describe, expect, it } from "vitest";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint,
  getLinkedInSelectorPhrases,
  resolveLinkedInSelectorLocale,
  valueContainsLinkedInSelectorPhrase
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

  it("uses the provided fallback for blank and invalid locale values", () => {
    expect(resolveLinkedInSelectorLocale("   ", "da")).toBe("da");
    expect(resolveLinkedInSelectorLocale("fr-CA", "da")).toBe("da");
    expect(resolveLinkedInSelectorLocale(undefined, "da")).toBe("da");
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

  it("uses english base phrases when a locale has no override", () => {
    expect(
      getLinkedInSelectorPhrases("send", "da", {
        includeEnglishFallback: false
      })
    ).toEqual(["Send"]);
  });

  it("deduplicates english fallback phrases when the locale already shares them", () => {
    expect(getLinkedInSelectorPhrases("send", "da")).toEqual(["Send"]);
  });

  it("keeps locale-first ordering across multiple phrase keys", () => {
    expect(getLinkedInSelectorPhrases(["messaging", "write_message"], "da")).toEqual([
      "Beskeder",
      "Skriv en besked",
      "Skriv en meddelelse",
      "Messaging",
      "Messages",
      "Write a message"
    ]);
  });

  it("handles empty phrase sets without producing fallback matches", () => {
    expect(getLinkedInSelectorPhrases([] as const, "da")).toEqual([]);
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

  it("escapes punctuation-heavy phrases in regex hints and exact matches", () => {
    const hint = formatLinkedInSelectorRegexHint(
      "what_do_you_want_to_talk_about",
      "da",
      { exact: true }
    );
    const regex = buildLinkedInSelectorPhraseRegex(
      "what_do_you_want_to_talk_about",
      "da",
      { exact: true }
    );

    expect(hint).toContain("Hvad vil du tale om\\?");
    expect(regex.test("Hvad vil du tale om?")).toBe(true);
    expect(regex.test("Hvad vil du tale om")).toBe(false);
  });

  it("does not overmatch short labels when exact matching is required", () => {
    const regex = buildLinkedInSelectorPhraseRegex("send", "da", {
      exact: true
    });

    expect(regex.test("Send")).toBe(true);
    expect(regex.test("Send uden note")).toBe(false);
  });

  it("treats empty phrase sets as non-matching selectors", () => {
    const regex = buildLinkedInSelectorPhraseRegex([] as const, "da");

    expect(regex.test("Opret forbindelse")).toBe(false);
    expect(regex.test("")).toBe(true);
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

  it("supports multiple roots and custom attributes", () => {
    const selector = buildLinkedInAriaLabelContainsSelector(
      ["button", "div[role='button']"],
      "connect",
      "da",
      "title"
    );

    expect(selector).toContain('button[title*="Opret forbindelse" i]');
    expect(selector).toContain('div[role=\'button\'][title*="Connect" i]');
  });

  it("returns an empty selector when there are no phrase keys", () => {
    expect(buildLinkedInAriaLabelContainsSelector("button", [] as const, "da")).toBe("");
  });
});

describe("valueContainsLinkedInSelectorPhrase", () => {
  it("matches localized phrases and english fallbacks", () => {
    expect(valueContainsLinkedInSelectorPhrase("Skriv en besked", "write_message", "da")).toBe(
      true
    );
    expect(valueContainsLinkedInSelectorPhrase("Write a message", "write_message", "da")).toBe(
      true
    );
  });

  it("returns false for empty values and empty phrase sets", () => {
    expect(valueContainsLinkedInSelectorPhrase(undefined, "write_message", "da")).toBe(false);
    expect(valueContainsLinkedInSelectorPhrase("", [] as const, "da")).toBe(false);
  });
});
