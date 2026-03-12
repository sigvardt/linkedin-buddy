import type { BrowserContext, Page } from "playwright-core";

/**
 * Normalize whitespace in a string value, handling null/undefined.
 * Collapses multiple whitespace characters into a single space and trims.
 */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Type guard for plain objects (non-null, non-array).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Get or create a page from a browser context.
 * Returns the first existing page or creates a new one.
 */
export async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

/**
 * Escape special regex characters in a string.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escape a value for use in CSS attribute selectors.
 */
export function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Check if a string is an absolute HTTP(S) URL.
 */
export function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
