import type { Locator, Page } from "playwright-core";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import {
  buildLinkedInSelectorPhraseRegex,
  buildLinkedInAriaLabelContainsSelector
} from "./selectorLocale.js";
import type { JsonEventLogger } from "./logging.js";

/**
 * Result from a single overlay dismissal pass.
 */
export interface DismissedOverlayResult {
  /** Whether any overlay was actually dismissed. */
  dismissed: boolean;
  /** Identifier for the type of overlay that was dismissed, or `null`. */
  overlayType: string | null;
  /** Selector key that matched, or `null`. */
  selectorKey: string | null;
}

type LoggerLike = Pick<JsonEventLogger, "log">;

/**
 * Known LinkedIn overlay / modal selectors that block interaction with the
 * underlying page.  The ordering matters — more specific selectors first,
 * generic fallback last.
 */
const BLOCKING_OVERLAY_SELECTORS = [
  // Org-page "viewing settings" modal
  '[data-test-modal-id="org-page-viewing-setting-modal"]',
  // Artdeco modal overlays (top-layer)
  ".artdeco-modal-overlay--is-top-layer",
  // Generic artdeco toast / global alerts
  ".artdeco-global-alert--COOKIE_CONSENT",
  ".artdeco-global-alert:not(.artdeco-global-alert--COOKIE_CONSENT)",
  // Inbox mini-composer bubble overlay
  ".msg-overlay-conversation-bubble",
  // Generic blocking dialogs (checked LAST — only dismissed when they are
  // clearly blocking, i.e. [aria-modal='true'] without expected action content)
  "[aria-modal='true'][role='dialog']",
  "dialog[open]"
] as const;

/**
 * Check whether a locator is visible on page.  Returns `false` on any error.
 */
async function isOverlayLocatorVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

/**
 * Attempts to click a close/dismiss button inside the given overlay locator.
 * Uses locale-aware selectors for "close" and "dismiss" phrases.
 *
 * @returns The key of the matched button, or `null` if no close button found.
 */
async function tryClickCloseButton(
  overlay: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<string | null> {
  const closeRegex = buildLinkedInSelectorPhraseRegex(
    ["dismiss", "close"],
    selectorLocale
  );
  const closeAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    ["dismiss", "close"],
    selectorLocale
  );

  const candidates: Array<{ key: string; locator: Locator }> = [
    {
      key: "overlay-close-role-button",
      locator: overlay.getByRole("button", { name: closeRegex })
    },
    {
      key: "overlay-close-aria-button",
      locator: overlay.locator(closeAriaSelector)
    },
    {
      key: "overlay-close-svg-button",
      locator: overlay.locator(
        "button:has(svg[data-test-icon='close-small']), " +
        "button:has(svg[aria-label*='close' i]), " +
        "button:has(li-icon[type='close'])"
      )
    }
  ];

  for (const candidate of candidates) {
    const visible = await isOverlayLocatorVisible(candidate.locator);
    if (visible) {
      await candidate.locator.first().click({ timeout: 2_000 }).catch(() => undefined);
      return candidate.key;
    }
  }

  return null;
}

/**
 * Checks whether a `[role='dialog']` overlay contains content that looks like
 * an expected write-action surface (form fields, content-editable areas, or
 * action buttons).  Such dialogs should NOT be dismissed — they are the target
 * of the upcoming write operation.
 */
async function isExpectedActionDialog(dialog: Locator): Promise<boolean> {
  const actionContentSelectors = [
    "[contenteditable='true']",
    "textarea",
    "form",
    "input[type='text']",
    "input[type='email']",
    "input[type='url']"
  ];

  for (const selector of actionContentSelectors) {
    const hasContent = await dialog
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
    if (hasContent) {
      return true;
    }
  }

  return false;
}

/**
 * Dismisses common LinkedIn overlay modals that block interaction with the
 * underlying page.
 *
 * The utility runs through a prioritized list of known blocking overlay
 * selectors.  For each visible overlay it attempts to click its close/dismiss
 * button.  If no close button is found it falls back to the Escape key.
 *
 * Safety: Generic `[role='dialog']` overlays are only dismissed when they
 * do NOT contain content-editable fields or form inputs — those are assumed to
 * be the target of the upcoming write operation.
 *
 * @returns Information about whether an overlay was dismissed and which
 * selector matched.
 */
export async function dismissLinkedInOverlaysIfPresent(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  logger?: LoggerLike
): Promise<DismissedOverlayResult> {
  for (const selector of BLOCKING_OVERLAY_SELECTORS) {
    const overlay = page.locator(selector).first();
    const visible = await isOverlayLocatorVisible(overlay);

    if (!visible) {
      continue;
    }

    // For generic dialog overlays, skip if they contain action content
    // (forms, textareas, content-editable) — those are expected write surfaces.
    if (selector === "[aria-modal='true'][role='dialog']" || selector === "dialog[open]") {
      if (await isExpectedActionDialog(overlay)) {
        continue;
      }
    }

    logger?.log("info", "overlay.dismissal.detected", {
      selector,
      page_url: page.url()
    });

    const buttonKey = await tryClickCloseButton(overlay, selectorLocale);

    if (buttonKey) {
      // Wait for overlay to disappear after clicking close
      await overlay
        .waitFor({ state: "hidden", timeout: 3_000 })
        .catch(() => undefined);

      logger?.log("info", "overlay.dismissal.closed_via_button", {
        selector,
        button_key: buttonKey,
        page_url: page.url()
      });

      return {
        dismissed: true,
        overlayType: selector,
        selectorKey: buttonKey
      };
    }

    // Fallback: press Escape
    await page.keyboard.press("Escape").catch(() => undefined);
    await overlay
      .waitFor({ state: "hidden", timeout: 2_000 })
      .catch(() => undefined);

    const stillVisible = await isOverlayLocatorVisible(overlay);

    logger?.log("info", "overlay.dismissal.escape_fallback", {
      selector,
      still_visible: stillVisible,
      page_url: page.url()
    });

    if (!stillVisible) {
      return {
        dismissed: true,
        overlayType: selector,
        selectorKey: "escape-fallback"
      };
    }
  }

  return {
    dismissed: false,
    overlayType: null,
    selectorKey: null
  };
}
