import type { BrowserContext, Locator, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildTextRegex,
  dedupeRepeatedText,
  dedupePhrases,
  escapeCssAttributeValue,
  escapeRegExp,
  getOrCreatePage,
  isAbsoluteUrl,
  isLocatorVisible,
  isRecord,
  normalizeText
} from "../shared.js";

describe("shared", () => {
  describe("normalizeText", () => {
    it("handles null and undefined", () => {
      expect(normalizeText(null)).toBe("");
      expect(normalizeText(undefined)).toBe("");
    });

    it("trims and collapses whitespace", () => {
      expect(normalizeText("  hello  world  ")).toBe("hello world");
      expect(normalizeText("")).toBe("");
      expect(normalizeText("hello\t\nworld")).toBe("hello world");
      expect(normalizeText("hello\u00A0\u00A0world")).toBe("hello world");
    });
  });

  describe("isRecord", () => {
    it("returns true for objects", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(new Date())).toBe(true);
    });

    it("returns false for non-record values", () => {
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord([])).toBe(false);
      expect(isRecord("string")).toBe(false);
      expect(isRecord(42)).toBe(false);
    });
  });

  describe("escapeRegExp", () => {
    it("escapes regex metacharacters", () => {
      expect(escapeRegExp("hello.world")).toBe("hello\\.world");
      expect(escapeRegExp("a*b+c?")).toBe("a\\*b\\+c\\?");
      expect(escapeRegExp("plain")).toBe("plain");
      expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
    });
  });

  describe("escapeCssAttributeValue", () => {
    it("escapes quotes and backslashes", () => {
      expect(escapeCssAttributeValue('hello"world')).toBe('hello\\"world');
      expect(escapeCssAttributeValue("back\\slash")).toBe("back\\\\slash");
      expect(escapeCssAttributeValue("plain")).toBe("plain");
    });
  });

  describe("isAbsoluteUrl", () => {
    it("detects absolute http(s) URLs", () => {
      expect(isAbsoluteUrl("https://example.com")).toBe(true);
      expect(isAbsoluteUrl("http://example.com")).toBe(true);
      expect(isAbsoluteUrl("/relative/path")).toBe(false);
      expect(isAbsoluteUrl("")).toBe(false);
      expect(isAbsoluteUrl("example.com")).toBe(false);
    });
  });

  describe("dedupePhrases", () => {
    it("deduplicates case-insensitively and preserves first value", () => {
      expect(dedupePhrases(["Hello", "hello"])).toEqual(["Hello"]);
      expect(dedupePhrases(["  a  ", "a"])).toEqual(["a"]);
      expect(dedupePhrases(["", "  ", "valid"])).toEqual(["valid"]);
      expect(dedupePhrases(["x", "y", "x"])).toEqual(["x", "y"]);
    });
  });

  describe("dedupeRepeatedText", () => {
    it("returns empty string for falsy input", () => {
      expect(dedupeRepeatedText(null)).toBe("");
      expect(dedupeRepeatedText(undefined)).toBe("");
      expect(dedupeRepeatedText("")).toBe("");
    });

    it("returns short text unchanged", () => {
      expect(dedupeRepeatedText("Hi")).toBe("Hi");
      expect(dedupeRepeatedText("abc")).toBe("abc");
    });

    it("removes exact-half duplication", () => {
      expect(dedupeRepeatedText("TitleTitle")).toBe("Title");
      expect(dedupeRepeatedText("Software Engineer (C++) - RemoteSoftware Engineer (C++) - Remote"))
        .toBe("Software Engineer (C++) - Remote");
    });

    it("removes exact-half duplication with space separator", () => {
      expect(dedupeRepeatedText("Title Title")).toBe("Title");
    });

    it("removes prefix-repeated duplication with trailing text", () => {
      expect(dedupeRepeatedText("Developer Developer with verification"))
        .toBe("Developer with verification");
      expect(dedupeRepeatedText("Frontend-udvikler Frontend-udvikler with verification"))
        .toBe("Frontend-udvikler with verification");
    });

    it("preserves text that is not doubled", () => {
      expect(dedupeRepeatedText("Software Engineer")).toBe("Software Engineer");
      expect(dedupeRepeatedText("Senior Full Stack Developer")).toBe("Senior Full Stack Developer");
      expect(dedupeRepeatedText("Google")).toBe("Google");
    });

    it("normalizes whitespace", () => {
      expect(dedupeRepeatedText("  Developer   Developer  ")).toBe("Developer");
    });
  });

  describe("buildTextRegex", () => {
    it("builds a case-insensitive regex for labels", () => {
      const regex = buildTextRegex(["Save", "Done"]);
      expect(regex.test("save")).toBe(true);
      expect(regex.test("DONE")).toBe(true);
      expect(regex.test("Cancel")).toBe(false);
    });

    it("builds an anchored regex when exact is true", () => {
      const regex = buildTextRegex(["Save"], true);
      expect(regex.test("Save")).toBe(true);
      expect(regex.test("Save now")).toBe(false);
    });

    it("filters empty labels and escapes regex characters", () => {
      const filteredRegex = buildTextRegex(["", "  Save  ", "\n"]);
      expect(filteredRegex.test("save")).toBe(true);
      expect(filteredRegex.test("done")).toBe(false);

      const escapedRegex = buildTextRegex(["a+b"]);
      expect(escapedRegex.test("a+b")).toBe(true);
      expect(escapedRegex.test("aaab")).toBe(false);
    });
  });

  describe("getOrCreatePage", () => {
    it("returns the first existing page", async () => {
      const existingPage = {} as Page;
      const newPage = vi.fn<() => Promise<Page>>();
      const context = {
        pages: () => [existingPage],
        newPage
      } as unknown as BrowserContext;

      const result = await getOrCreatePage(context);

      expect(result).toBe(existingPage);
      expect(newPage).not.toHaveBeenCalled();
    });

    it("creates a new page when none exist", async () => {
      const createdPage = {} as Page;
      const newPage = vi.fn<() => Promise<Page>>().mockResolvedValue(createdPage);
      const context = {
        pages: () => [],
        newPage
      } as unknown as BrowserContext;

      const result = await getOrCreatePage(context);

      expect(newPage).toHaveBeenCalledTimes(1);
      expect(result).toBe(createdPage);
    });
  });

  describe("isLocatorVisible", () => {
    it("returns true when locator first element is visible", async () => {
      const isVisible = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
      const first = vi.fn<() => Locator>().mockReturnValue({ isVisible } as unknown as Locator);
      const locator = { first } as unknown as Locator;

      await expect(isLocatorVisible(locator)).resolves.toBe(true);
      expect(first).toHaveBeenCalledTimes(1);
      expect(isVisible).toHaveBeenCalledTimes(1);
    });

    it("returns false when visibility check throws", async () => {
      const isVisible = vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error("boom"));
      const first = vi.fn<() => Locator>().mockReturnValue({ isVisible } as unknown as Locator);
      const locator = { first } as unknown as Locator;

      await expect(isLocatorVisible(locator)).resolves.toBe(false);
      expect(first).toHaveBeenCalledTimes(1);
      expect(isVisible).toHaveBeenCalledTimes(1);
    });
  });
});
