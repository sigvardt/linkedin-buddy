import type { BrowserContext, Locator, Page } from "playwright-core";

/** Trims text and collapses internal whitespace for stable comparisons and output. */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

/** Returns whether a value is a plain object rather than null or an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Escapes special regex metacharacters so the string can be used inside new RegExp(). */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escapes backslashes and double-quotes for safe use inside CSS attribute selectors. */
export function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Returns whether a URL string starts with an absolute http(s) scheme. */
export function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Deduplicates a phrase list case-insensitively, normalizing whitespace and filtering blanks. */
export function dedupePhrases(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = normalizeText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

/** Builds a case-insensitive regex matching any of the provided label strings. */
export function buildTextRegex(labels: readonly string[], exact = false): RegExp {
  const normalizedLabels = Array.from(
    new Set(
      labels
        .map((label) => normalizeText(label))
        .filter((label) => label.length > 0),
    ),
  );
  const pattern = normalizedLabels
    .map((label) => escapeRegExp(label))
    .join("|");
  return new RegExp(exact ? `^(?:${pattern})$` : `(?:${pattern})`, "i");
}

/**
 * Detects text that has been doubled due to concatenated visible /
 * screen-reader spans and returns the clean single copy.
 *
 * Examples:
 *   "TitleTitle"                                      -> "Title"
 *   "Developer Developer with verification"           -> "Developer with verification"
 *   "Software Engineer (C++) - RemoteSoftware ..."    -> "Software Engineer (C++) - Remote"
 */
export function dedupeRepeatedText(value: string | null | undefined): string {
  const text = normalizeText(value);
  if (text.length < 4) {
    return text;
  }

  // Case 1: exact halves - "TitleTitle" or "Title Title"
  if (text.length % 2 === 0) {
    const mid = text.length / 2;
    const first = normalizeText(text.slice(0, mid));
    const second = normalizeText(text.slice(mid));
    if (first && first === second) {
      return first;
    }
  }

  // Case 2: repeated word prefix - "Developer Developer with verification"
  const words = text.split(" ");
  for (let i = 1; i * 2 <= words.length; i += 1) {
    const prefix = words.slice(0, i).join(" ");
    const next = words.slice(i, i * 2).join(" ");
    if (prefix === next) {
      return normalizeText(words.slice(i).join(" "));
    }
  }

  return text;
}

/** Returns the first open page in a browser context, or creates a new one. */
export async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

/** Returns whether a Playwright locator points at a currently visible element. */
export async function isLocatorVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}
