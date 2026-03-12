import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  escapeCssAttributeValue,
  escapeRegExp,
  getOrCreatePage,
  isAbsoluteUrl,
  isRecord,
  normalizeText,
} from "../shared.js";

describe("shared utilities", () => {
  it("normalizes whitespace-heavy text values", () => {
    expect(normalizeText("  Hello\n\tLinkedIn   Buddy ")).toBe(
      "Hello LinkedIn Buddy",
    );
    expect(normalizeText(null)).toBe("");
  });

  it("identifies plain records and rejects arrays/null", () => {
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord(["value"])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("returns existing context page before creating a new one", async () => {
    const existingPage = {} as Page;
    const context = {
      pages: vi.fn(() => [existingPage]),
      newPage: vi.fn(),
    } as unknown as BrowserContext;

    await expect(getOrCreatePage(context)).resolves.toBe(existingPage);
    expect(context.newPage).not.toHaveBeenCalled();
  });

  it("creates a new page when the context has no open pages", async () => {
    const createdPage = {} as Page;
    const context = {
      pages: vi.fn(() => []),
      newPage: vi.fn(async () => createdPage),
    } as unknown as BrowserContext;

    await expect(getOrCreatePage(context)).resolves.toBe(createdPage);
    expect(context.newPage).toHaveBeenCalledTimes(1);
  });

  it("escapes regex metacharacters for safe dynamic patterns", () => {
    expect(escapeRegExp("a+b?(test)[x]")).toBe("a\\+b\\?\\(test\\)\\[x\\]");
  });

  it("escapes CSS attribute values and validates absolute URLs", () => {
    expect(escapeCssAttributeValue('say "hello" \\ now')).toBe(
      'say \\"hello\\" \\\\ now',
    );
    expect(isAbsoluteUrl("https://www.linkedin.com/in/me/")).toBe(true);
    expect(isAbsoluteUrl("http://example.com")).toBe(true);
    expect(isAbsoluteUrl("/in/me/")).toBe(false);
  });
});
