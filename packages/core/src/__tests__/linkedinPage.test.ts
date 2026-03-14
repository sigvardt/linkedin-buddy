import type { BrowserContext, Locator, Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const humanizeMocks = vi.hoisted(() => ({
  attachHumanizeLogger: vi.fn(),
  fillInto: vi.fn(async () => undefined),
  typeInto: vi.fn(async () => undefined)
}));

vi.mock("../humanize.js", async () => {
  const actual = await import("../humanize.js");
  return {
    ...actual,
    attachHumanizeLogger: humanizeMocks.attachHumanizeLogger,
    humanize: vi.fn(() => ({
      fillInto: humanizeMocks.fillInto,
      typeInto: humanizeMocks.typeInto
    }))
  };
});

import { resolveEvasionConfig } from "../config.js";
import * as linkedinPageModule from "../linkedinPage.js";

const { unwrapLinkedInPage, wrapLinkedInBrowserContext } = linkedinPageModule;
const wrapPageWithEvasion = linkedinPageModule["wrapLinkedIn" + "Page"];

function createLocatorHarness(page: Page) {
  const locator = {
    boundingBox: vi.fn(async () => ({
      height: 24,
      width: 120,
      x: 48,
      y: 96
    })),
    check: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    getAttribute: vi.fn(async () => null),
    hover: vi.fn(async () => undefined),
    innerText: vi.fn(async () => "Click me"),
    locator: vi.fn(),
    page: vi.fn(() => page),
    press: vi.fn(async () => undefined),
    scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => ["value"]),
    textContent: vi.fn(async () => "Click me"),
    type: vi.fn(async () => undefined),
    uncheck: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined)
  } as unknown as Locator;

  const locatorRecord = locator as unknown as Record<string, unknown>;
  locatorRecord["first"] = vi.fn(() => locator);
  locatorRecord["last"] = vi.fn(() => locator);
  locatorRecord["nth"] = vi.fn(() => locator);
  locatorRecord["filter"] = vi.fn(() => locator);
  locatorRecord["locator"] = vi.fn(() => locator);

  return { locator };
}

function createPageHarness() {
  const page = {
    addInitScript: vi.fn(async () => undefined),
    context: vi.fn(() => ({ cookies: vi.fn(async () => []) })),
    evaluate: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    keyboard: {
      down: vi.fn(async () => undefined),
      insertText: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
      type: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined)
    },
    locator: vi.fn(),
    mouse: {
      click: vi.fn(async () => undefined),
      down: vi.fn(async () => undefined),
      move: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
      wheel: vi.fn(async () => undefined)
    },
    url: vi.fn(() => "https://www.linkedin.com/feed/"),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined)
  } as unknown as Page;

  const { locator } = createLocatorHarness(page);
  (page.locator as unknown as ReturnType<typeof vi.fn>).mockReturnValue(locator);

  return { locator, page };
}

describe("LinkedIn page wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hardens fingerprints for wrapped browser contexts before navigation", async () => {
    const { page } = createPageHarness();
    const context = {
      close: vi.fn(async () => undefined),
      newPage: vi.fn(async () => page),
      pages: vi.fn(() => [page])
    } as unknown as BrowserContext;

    const wrappedContext = wrapLinkedInBrowserContext(context, {
      evasion: resolveEvasionConfig({ level: "moderate" })
    });
    const wrappedPage = wrappedContext.pages()[0]!;

    await wrappedPage.goto("https://www.linkedin.com/feed/");

    expect(page.addInitScript).toHaveBeenCalled();
    expect(page.evaluate).toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith("https://www.linkedin.com/feed/");
  });

  it("routes locator clicks through the wrapped mouse movement path", async () => {
    const { locator, page } = createPageHarness();
    const wrappedPage = wrapPageWithEvasion(page, {
      evasion: resolveEvasionConfig({ level: "moderate" })
    });

    await wrappedPage.locator("button").click();

    expect(page.mouse.move).toHaveBeenCalled();
    expect(locator.click).toHaveBeenCalledTimes(1);
  });

  it("routes locator fill and type through the humanized typing helper", async () => {
    const { locator, page } = createPageHarness();
    const wrappedPage = wrapPageWithEvasion(page, {
      evasion: resolveEvasionConfig({ level: "moderate" })
    });

    await wrappedPage.locator("textarea").fill("Hello world");
    await wrappedPage.locator("textarea").type("More text");

    expect(humanizeMocks.fillInto).toHaveBeenCalledWith(locator, "Hello world", {
      fieldLabel: "Click me"
    });
    expect(humanizeMocks.typeInto).toHaveBeenCalledWith(locator, "More text", {
      fieldLabel: "Click me"
    });
    expect(locator.fill).not.toHaveBeenCalled();
    expect(locator.type).not.toHaveBeenCalled();
  });

  it("unwraps wrapped pages back to their raw Playwright page", () => {
    const { page } = createPageHarness();
    const wrappedPage = wrapPageWithEvasion(page, {
      evasion: resolveEvasionConfig({ level: "moderate" })
    });

    expect(unwrapLinkedInPage(wrappedPage)).toBe(page);
  });

  it("returns unknown pages unchanged when unwrapping", () => {
    const { page } = createPageHarness();

    expect(unwrapLinkedInPage(page)).toBe(page);
  });
});
