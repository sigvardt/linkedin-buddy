import type {
  BrowserContext,
  Keyboard,
  Locator,
  Mouse,
  Page
} from "playwright-core";
import { resolveEvasionConfig, type EvasionConfig } from "./config.js";
import { EvasionSession, type Point2D } from "./evasion.js";
import { attachHumanizeLogger, humanize } from "./humanize.js";
import type { JsonEventLogger } from "./logging.js";

type LoggerLike = Pick<JsonEventLogger, "log">;
type LocatorCheckOptions = Parameters<Locator["check"]>[0];
type LocatorClickOptions = Parameters<Locator["click"]>[0];
type LocatorFillOptions = Parameters<Locator["fill"]>[1];
type LocatorHoverOptions = Parameters<Locator["hover"]>[0];
type LocatorPressOptions = Parameters<Locator["press"]>[1];
type LocatorSelectOptionOptions = Parameters<Locator["selectOption"]>[1];
type PageClickOptions = Parameters<Page["click"]>[1];
type PageFillOptions = Parameters<Page["fill"]>[2];
type PageHoverOptions = Parameters<Page["hover"]>[1];
type PagePressOptions = Parameters<Page["press"]>[2];
type MouseClickOptions = Parameters<Mouse["click"]>[2];

interface ScrollMetrics {
  maxTop: number;
  scrollY: number;
}

interface PositionLike {
  x: number;
  y: number;
}

interface ResolvedInteractionOptions {
  evasion: EvasionConfig;
  logger?: LoggerLike;
}

interface PageState {
  hardeningPromise: Promise<void>;
  humanizedPage: ReturnType<typeof humanize>;
  interactionCount: number;
  options: ResolvedInteractionOptions;
  rawPage: Page;
  session: EvasionSession;
  wrappedKeyboard?: Keyboard;
  wrappedMouse?: Mouse;
  wrappedPage?: Page;
}

/** Shared browser-wrapping options applied to LinkedIn Playwright contexts. */
export interface LinkedInBrowserInteractionOptions {
  evasion?: EvasionConfig;
  logger?: LoggerLike;
}

const NAVIGATION_METHOD_NAMES = new Set([
  "goto",
  "goBack",
  "goForward",
  "reload",
  "setContent"
]);

const wrappedContextByRaw = new WeakMap<BrowserContext, BrowserContext>();
const rawContextByWrapped = new WeakMap<object, BrowserContext>();
const wrappedLocatorByRaw = new WeakMap<Locator, Locator>();
const rawLocatorByWrapped = new WeakMap<object, Locator>();
const wrappedPageByRaw = new WeakMap<Page, Page>();
const rawPageByWrapped = new WeakMap<object, Page>();
const pageStateByRaw = new WeakMap<Page, PageState>();

/**
 * Wrap a Playwright browser context so page, locator, mouse, and keyboard
 * interactions automatically flow through the configured evasion session.
 */
export function wrapLinkedInBrowserContext(
  context: BrowserContext,
  options: LinkedInBrowserInteractionOptions = {}
): BrowserContext {
  if (rawContextByWrapped.has(context as object)) {
    return context;
  }

  const existingWrapped = wrappedContextByRaw.get(context);
  if (existingWrapped) {
    return existingWrapped;
  }

  const resolvedOptions = resolveInteractionOptions(options);
  const wrappedContext = new Proxy(context, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) =>
        wrapMaybe(value.apply(target, unwrapArgs(args)), resolvedOptions);
    }
  }) as BrowserContext;

  wrappedContextByRaw.set(context, wrappedContext);
  rawContextByWrapped.set(wrappedContext as object, context);

  return wrappedContext;
}

/**
 * Wrap a Playwright page so interactions default to the configured evasion
 * profile without requiring per-command opt-in.
 */
export function wrapLinkedInPage(
  page: Page,
  options: LinkedInBrowserInteractionOptions = {}
): Page {
  if (rawPageByWrapped.has(page as object)) {
    return page;
  }

  const existingWrapped = wrappedPageByRaw.get(page);
  if (existingWrapped) {
    return existingWrapped;
  }

  const state = ensurePageState(page, resolveInteractionOptions(options));

  const wrappedPage = new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === "keyboard") {
        return wrapKeyboard(target.keyboard, state);
      }

      if (prop === "mouse") {
        return wrapMouse(target.mouse, state);
      }

      if (prop === "click") {
        return (selector: string, options?: PageClickOptions) =>
          performPageClick(state, selector, options);
      }

      if (prop === "fill") {
        return (selector: string, value: string, options?: PageFillOptions) =>
          performPageFill(state, selector, value, options);
      }

      if (prop === "hover") {
        return (selector: string, options?: PageHoverOptions) =>
          performPageHover(state, selector, options);
      }

      if (prop === "press") {
        return (selector: string, key: string, options?: PagePressOptions) =>
          performPagePress(state, selector, key, options);
      }

      if (prop === "type") {
        return (selector: string, value: string, options?: Parameters<Page["type"]>[2]) =>
          performPageType(state, selector, value, options);
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      if (typeof prop === "string" && NAVIGATION_METHOD_NAMES.has(prop)) {
        return async (...args: unknown[]) => {
          await ensurePageReady(state);
          return wrapMaybe(await value.apply(target, unwrapArgs(args)), state.options);
        };
      }

      return (...args: unknown[]) =>
        wrapMaybe(value.apply(target, unwrapArgs(args)), state.options);
    }
  }) as Page;

  state.wrappedPage = wrappedPage;
  wrappedPageByRaw.set(page, wrappedPage);
  rawPageByWrapped.set(wrappedPage as object, page);
  return wrappedPage;
}

/**
 * Return the raw Playwright page underlying a wrapped LinkedIn page.
 * If the page was never wrapped, it is returned unchanged.
 */
export function unwrapLinkedInPage(page: Page): Page {
  return (rawPageByWrapped.get(page as object) as Page | undefined) ?? page;
}

/** Scroll the current LinkedIn page by `pixels` using the evasion session when available. */
export async function scrollLinkedInPageBy(page: Page, pixels: number): Promise<void> {
  const normalizedPixels = normalizeFiniteNumber(pixels);
  if (normalizedPixels === 0) {
    return;
  }

  const state = resolvePageState(page);
  if (state) {
    await prepareForInteraction(state, {
      baseDelayMs: 90,
      includePassiveSignals: false
    });
    await state.session.scroll(normalizedPixels);
    return;
  }

  await page.evaluate((top) => {
    globalThis.scrollBy({ top, behavior: "smooth" });
  }, normalizedPixels);
}

/** Scroll the current LinkedIn page back to the top using the evasion session when available. */
export async function scrollLinkedInPageToTop(page: Page): Promise<void> {
  const metrics = await readScrollMetrics(page);
  if (metrics.scrollY <= 0) {
    return;
  }

  await scrollLinkedInPageBy(page, -metrics.scrollY);
}

/** Scroll the current LinkedIn page to the bottom using the evasion session when available. */
export async function scrollLinkedInPageToBottom(page: Page): Promise<void> {
  const metrics = await readScrollMetrics(page);
  const remaining = Math.max(0, metrics.maxTop - metrics.scrollY);
  if (remaining <= 0) {
    return;
  }

  await scrollLinkedInPageBy(page, remaining);
}

function ensurePageState(page: Page, options: ResolvedInteractionOptions): PageState {
  const existingState = pageStateByRaw.get(page);
  if (existingState) {
    return existingState;
  }

  if (options.logger) {
    attachHumanizeLogger(page, options.logger);
  }

  const session = new EvasionSession(page, options.evasion.level, {
    diagnosticsEnabled: options.evasion.diagnosticsEnabled,
    diagnosticsLabel: "browser",
    ...(options.logger ? { logger: options.logger } : {})
  });
  const state: PageState = {
    hardeningPromise: session.hardenFingerprint(),
    humanizedPage: humanize(page, {
      fast: options.evasion.level === "minimal",
      ...(options.evasion.level === "minimal"
        ? { typingProfile: "fast" as const }
        : {})
    }),
    interactionCount: 0,
    options,
    rawPage: page,
    session
  };

  pageStateByRaw.set(page, state);
  return state;
}

function wrapLocator(locator: Locator, options: ResolvedInteractionOptions): Locator {
  if (rawLocatorByWrapped.has(locator as object)) {
    return locator;
  }

  const existingWrapped = wrappedLocatorByRaw.get(locator);
  if (existingWrapped) {
    return existingWrapped;
  }

  const state = ensurePageState(locator.page(), options);
  const wrappedLocator = new Proxy(locator, {
    get(target, prop, receiver) {
      if (prop === "check") {
        return (options?: LocatorCheckOptions) =>
          performLocatorCheck(state, target, options, "check");
      }

      if (prop === "click") {
        return (options?: LocatorClickOptions) => performLocatorClick(state, target, options);
      }

      if (prop === "fill") {
        return (value: string, options?: LocatorFillOptions) =>
          performLocatorFill(state, target, value, options);
      }

      if (prop === "hover") {
        return (options?: LocatorHoverOptions) => performLocatorHover(state, target, options);
      }

      if (prop === "page") {
        return () => wrapLinkedInPage(target.page(), state.options);
      }

      if (prop === "press") {
        return (key: string, options?: LocatorPressOptions) =>
          performLocatorPress(state, target, key, options);
      }

      if (prop === "selectOption") {
        return (
          values: Parameters<Locator["selectOption"]>[0],
          options?: LocatorSelectOptionOptions
        ) => performLocatorSelectOption(state, target, values, options);
      }

      if (prop === "type") {
        return (value: string, options?: Parameters<Locator["type"]>[1]) =>
          performLocatorType(state, target, value, options);
      }

      if (prop === "uncheck") {
        return (options?: LocatorCheckOptions) =>
          performLocatorCheck(state, target, options, "uncheck");
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) =>
        wrapMaybe(value.apply(target, unwrapArgs(args)), state.options);
    }
  }) as Locator;

  wrappedLocatorByRaw.set(locator, wrappedLocator);
  rawLocatorByWrapped.set(wrappedLocator as object, locator);
  return wrappedLocator;
}

function wrapKeyboard(keyboard: Keyboard, state: PageState): Keyboard {
  if (state.wrappedKeyboard) {
    return state.wrappedKeyboard;
  }

  state.wrappedKeyboard = new Proxy(keyboard, {
    get(target, prop, receiver) {
      if (prop === "insertText") {
        return async (text: string) => {
          await prepareForInteraction(state, { baseDelayMs: 70, includePassiveSignals: false });
          return target.insertText(text);
        };
      }

      if (prop === "press") {
        return async (key: string, options?: Parameters<Keyboard["press"]>[1]) => {
          await prepareForInteraction(state, { baseDelayMs: 70, includePassiveSignals: false });
          return target.press(key, options);
        };
      }

      if (prop === "type") {
        return async (text: string, options?: Parameters<Keyboard["type"]>[1]) => {
          await prepareForInteraction(state, { baseDelayMs: 70, includePassiveSignals: false });
          return target.type(text, options);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => value.apply(target, unwrapArgs(args));
    }
  }) as Keyboard;

  return state.wrappedKeyboard;
}

function wrapMouse(mouse: Mouse, state: PageState): Mouse {
  if (state.wrappedMouse) {
    return state.wrappedMouse;
  }

  state.wrappedMouse = new Proxy(mouse, {
    get(target, prop, receiver) {
      if (prop === "click") {
        return async (x: number, y: number, options?: MouseClickOptions) => {
          await prepareForInteraction(state, { baseDelayMs: 80, includePassiveSignals: false });
          await state.session.moveMouseTo({ x, y });
          await state.session.idle(
            state.session.sampleInterval(60, {
              maxIntervalMs: 300,
              minIntervalMs: 10
            })
          );
          return target.click(x, y, options);
        };
      }

      if (prop === "down") {
        return async (...args: unknown[]) => {
          await ensurePageReady(state);
          return target.down(...(args as Parameters<Mouse["down"]>));
        };
      }

      if (prop === "move") {
        return async (x: number, y: number) => {
          await ensurePageReady(state);
          await state.session.moveMouseTo({ x, y });
        };
      }

      if (prop === "up") {
        return async (...args: unknown[]) => {
          await ensurePageReady(state);
          return target.up(...(args as Parameters<Mouse["up"]>));
        };
      }

      if (prop === "wheel") {
        return async (deltaX: number, deltaY: number) => {
          await prepareForInteraction(state, { baseDelayMs: 90, includePassiveSignals: false });
          if (normalizeFiniteNumber(deltaX) !== 0) {
            return target.wheel(deltaX, deltaY);
          }

          await state.session.scroll(deltaY);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => value.apply(target, unwrapArgs(args));
    }
  }) as Mouse;

  return state.wrappedMouse;
}

function resolveInteractionOptions(
  options: LinkedInBrowserInteractionOptions | ResolvedInteractionOptions
): ResolvedInteractionOptions {
  return {
    evasion: options.evasion ?? resolveEvasionConfig(),
    ...(options.logger ? { logger: options.logger } : {})
  };
}

async function ensurePageReady(state: PageState): Promise<void> {
  await state.hardeningPromise;
}

async function prepareForInteraction(
  state: PageState,
  input: {
    baseDelayMs?: number;
    includePassiveSignals?: boolean;
    textCharCount?: number;
  } = {}
): Promise<void> {
  await ensurePageReady(state);

  const textCharCount = Math.max(0, Math.round(input.textCharCount ?? 0));
  if (textCharCount > 0) {
    await state.session.readingPause(textCharCount);
  }

  const sampledDelayMs = state.session.sampleInterval(input.baseDelayMs ?? 140, {
    maxIntervalMs: 1_500,
    minIntervalMs: 20
  });
  await state.session.idle(sampledDelayMs);

  state.interactionCount += 1;
  if (input.includePassiveSignals === false) {
    return;
  }

  if (
    state.session.activeProfile.simulateViewportResize &&
    state.interactionCount % 11 === 0
  ) {
    await state.session.simulateViewportJitter();
  }

  if (state.session.activeProfile.simulateTabBlur && state.interactionCount % 17 === 0) {
    await state.session.simulateTabSwitch(
      state.session.sampleInterval(1_200, {
        maxIntervalMs: 2_500,
        minIntervalMs: 400
      })
    );
  }
}

async function performLocatorCheck(
  state: PageState,
  locator: Locator,
  options: LocatorCheckOptions | undefined,
  mode: "check" | "uncheck"
): Promise<void> {
  await prepareForInteraction(state, {
    textCharCount: (await readInteractionText(locator)).length
  });
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await moveMouseNearLocator(state, locator);

  if (mode === "check") {
    await locator.check(options);
    return;
  }

  await locator.uncheck(options);
}

async function performLocatorClick(
  state: PageState,
  locator: Locator,
  options?: LocatorClickOptions
): Promise<void> {
  await prepareForInteraction(state, {
    textCharCount: (await readInteractionText(locator)).length
  });
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await moveMouseNearLocator(state, locator, options?.position);
  await locator.click(options);
}

async function performLocatorFill(
  state: PageState,
  locator: Locator,
  value: string,
  options?: LocatorFillOptions
): Promise<void> {
  await prepareForInteraction(state, {
    textCharCount: (await readInteractionText(locator)).length
  });
  const fieldLabel = await readInteractionLabel(locator);
  await state.humanizedPage.fillInto(locator, value, {
    ...(fieldLabel ? { fieldLabel } : {}),
    ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout })
  });

  if (options?.timeout !== undefined) {
    await locator.waitFor({ state: "attached", timeout: options.timeout }).catch(() => undefined);
  }
}

async function performLocatorHover(
  state: PageState,
  locator: Locator,
  options?: LocatorHoverOptions
): Promise<void> {
  await prepareForInteraction(state, {
    baseDelayMs: 90,
    textCharCount: (await readInteractionText(locator)).length
  });
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await moveMouseNearLocator(state, locator);
  await locator.hover(options);
}

async function performLocatorPress(
  state: PageState,
  locator: Locator,
  key: string,
  options?: LocatorPressOptions
): Promise<void> {
  await prepareForInteraction(state, {
    baseDelayMs: 80,
    textCharCount: (await readInteractionText(locator)).length
  });
  await locator.press(key, options);
}

async function performLocatorSelectOption(
  state: PageState,
  locator: Locator,
  values: Parameters<Locator["selectOption"]>[0],
  options?: LocatorSelectOptionOptions
): Promise<void> {
  await prepareForInteraction(state, {
    baseDelayMs: 100,
    textCharCount: (await readInteractionText(locator)).length
  });
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await moveMouseNearLocator(state, locator);
  await locator.selectOption(values, options);
}

async function performLocatorType(
  state: PageState,
  locator: Locator,
  value: string,
  options?: Parameters<Locator["type"]>[1]
): Promise<void> {
  await prepareForInteraction(state, {
    textCharCount: (await readInteractionText(locator)).length
  });
  const fieldLabel = await readInteractionLabel(locator);
  await state.humanizedPage.typeInto(locator, value, {
    ...(fieldLabel ? { fieldLabel } : {}),
    ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout })
  });
}

async function performPageClick(
  state: PageState,
  selector: string,
  options?: PageClickOptions
): Promise<void> {
  await performLocatorClick(state, state.rawPage.locator(assertSelector(selector)).first(), options);
}

async function performPageFill(
  state: PageState,
  selector: string,
  value: string,
  options?: PageFillOptions
): Promise<void> {
  await performLocatorFill(
    state,
    state.rawPage.locator(assertSelector(selector)).first(),
    value,
    options
  );
}

async function performPageHover(
  state: PageState,
  selector: string,
  options?: PageHoverOptions
): Promise<void> {
  await performLocatorHover(state, state.rawPage.locator(assertSelector(selector)).first(), options);
}

async function performPagePress(
  state: PageState,
  selector: string,
  key: string,
  options?: PagePressOptions
): Promise<void> {
  await performLocatorPress(
    state,
    state.rawPage.locator(assertSelector(selector)).first(),
    key,
    options
  );
}

async function performPageType(
  state: PageState,
  selector: string,
  value: string,
  options?: Parameters<Page["type"]>[2]
): Promise<void> {
  await performLocatorType(
    state,
    state.rawPage.locator(assertSelector(selector)).first(),
    value,
    options
  );
}

async function moveMouseNearLocator(
  state: PageState,
  locator: Locator,
  position?: PositionLike
): Promise<void> {
  const point = await resolveLocatorPoint(locator, position);
  if (!point) {
    return;
  }

  await state.session.moveMouseTo(point);
  await state.session.idle(
    state.session.sampleInterval(60, {
      maxIntervalMs: 300,
      minIntervalMs: 10
    })
  );
}

async function resolveLocatorPoint(
  locator: Locator,
  position?: PositionLike
): Promise<Point2D | null> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    return null;
  }

  const offsetX = isPositionLike(position)
    ? clampNumber(position.x, 0, Math.max(0, box.width))
    : box.width / 2;
  const offsetY = isPositionLike(position)
    ? clampNumber(position.y, 0, Math.max(0, box.height))
    : box.height / 2;

  return {
    x: box.x + offsetX,
    y: box.y + offsetY
  };
}

async function readInteractionLabel(locator: Locator): Promise<string> {
  const text = await readInteractionText(locator);
  if (text.length > 0) {
    return text;
  }

  const attributeNames = ["aria-label", "placeholder", "title", "value"] as const;
  for (const attributeName of attributeNames) {
    const value = normalizeInteractionText(
      await locator.getAttribute(attributeName).catch(() => null)
    );
    if (value.length > 0) {
      return value;
    }
  }

  return "";
}

async function readInteractionText(locator: Locator): Promise<string> {
  const innerText = normalizeInteractionText(await locator.innerText().catch(() => null));
  if (innerText.length > 0) {
    return innerText;
  }

  return normalizeInteractionText(await locator.textContent().catch(() => null));
}

function resolvePageState(page: Page): PageState | undefined {
  const rawPage = rawPageByWrapped.get(page as object) ?? page;
  return pageStateByRaw.get(rawPage);
}

async function readScrollMetrics(page: Page): Promise<ScrollMetrics> {
  const metrics = await page
    .evaluate(() => {
      const maxTop = Math.max(0, globalThis.document.body.scrollHeight - globalThis.innerHeight);
      return {
        maxTop,
        scrollY: Math.max(0, globalThis.scrollY)
      } satisfies ScrollMetrics;
    })
    .catch(() => null);

  if (!isRecord(metrics)) {
    return { maxTop: 0, scrollY: 0 };
  }

  return {
    maxTop: Math.max(0, normalizeFiniteNumber(metrics.maxTop)),
    scrollY: Math.max(0, normalizeFiniteNumber(metrics.scrollY))
  };
}

function assertSelector(selector: string): string {
  if (typeof selector !== "string") {
    throw new TypeError("selector must be a string.");
  }

  return selector;
}

function wrapMaybe<T>(value: T, options: ResolvedInteractionOptions): T {
  if (isPromiseLike(value)) {
    return value.then((resolved) => wrapMaybe(resolved, options)) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => wrapMaybe(entry, options)) as T;
  }

  if (isBrowserContextLike(value)) {
    return wrapLinkedInBrowserContext(value, options) as T;
  }

  if (isPageLike(value)) {
    return wrapLinkedInPage(value, options) as T;
  }

  if (isLocatorLike(value)) {
    return wrapLocator(value, options) as T;
  }

  return value;
}

function unwrapArgs(args: readonly unknown[]): unknown[] {
  return args.map((value) => unwrapValue(value));
}

function unwrapValue<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const rawContext = rawContextByWrapped.get(value);
  if (rawContext) {
    return rawContext as T;
  }

  const rawLocator = rawLocatorByWrapped.get(value);
  if (rawLocator) {
    return rawLocator as T;
  }

  const rawPage = rawPageByWrapped.get(value);
  if (rawPage) {
    return rawPage as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => unwrapValue(entry)) as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const unwrappedEntries = Object.entries(value).map(([key, entryValue]) => [
    key,
    unwrapValue(entryValue)
  ]);
  return Object.fromEntries(unwrappedEntries) as T;
}

function isBrowserContextLike(value: unknown): value is BrowserContext {
  return isRecord(value) && typeof value.pages === "function" && typeof value.newPage === "function";
}

function isLocatorLike(value: unknown): value is Locator {
  return isRecord(value) && typeof value.page === "function" && typeof value.locator === "function";
}

function isPageLike(value: unknown): value is Page {
  return (
    isRecord(value) &&
    typeof value.goto === "function" &&
    typeof value.locator === "function" &&
    typeof value.url === "function" &&
    isRecord(value.keyboard) &&
    isRecord(value.mouse)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositionLike(value: unknown): value is PositionLike {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isPromiseLike<T>(value: T): value is T & PromiseLike<Awaited<T>> {
  return isRecord(value) && typeof value.then === "function";
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeFiniteNumber(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

function normalizeInteractionText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}
