import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { LinkedInBuddyError } from "../errors.js";
import type { CoreRuntime } from "../runtime.js";
import { WRITE_VALIDATION_FEED_URL } from "../writeValidationShared.js";

const writeValidationRuntimeMocks = vi.hoisted(() => ({
  createCoreRuntime: vi.fn(),
  inspectLinkedInSession: vi.fn(),
  launch: vi.fn(),
  loadSession: vi.fn(),
  waitForNetworkIdleBestEffort: vi.fn()
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launch: writeValidationRuntimeMocks.launch
  }
}));

vi.mock("../runtime.js", () => ({
  createCoreRuntime: writeValidationRuntimeMocks.createCoreRuntime
}));

vi.mock("../auth/sessionInspection.js", () => ({
  inspectLinkedInSession: writeValidationRuntimeMocks.inspectLinkedInSession
}));

vi.mock("../pageLoad.js", () => ({
  waitForNetworkIdleBestEffort: writeValidationRuntimeMocks.waitForNetworkIdleBestEffort
}));

vi.mock("../auth/sessionStore.js", () => ({
  LinkedInSessionStore: class {
    async load(sessionName: string) {
      return writeValidationRuntimeMocks.loadSession(sessionName);
    }
  }
}));

import { createWriteValidationRuntime } from "../writeValidationRuntime.js";

interface MockPageBundle {
  goto: ReturnType<typeof vi.fn>;
  page: Page;
  screenshot: ReturnType<typeof vi.fn>;
}

interface MockContextBundle {
  close: ReturnType<typeof vi.fn>;
  context: BrowserContext;
  newPage: ReturnType<typeof vi.fn>;
  pages: ReturnType<typeof vi.fn>;
  setDefaultNavigationTimeout: ReturnType<typeof vi.fn>;
  setDefaultTimeout: ReturnType<typeof vi.fn>;
}

interface MockBrowserBundle {
  browser: Browser;
  close: ReturnType<typeof vi.fn>;
  newContext: ReturnType<typeof vi.fn>;
}

function createMockPageBundle(): MockPageBundle {
  const goto = vi.fn(async () => undefined);
  const screenshot = vi.fn(async () => undefined);

  return {
    goto,
    page: {
      goto,
      screenshot
    } as unknown as Page,
    screenshot
  };
}

function createMockContextBundle(page: Page): MockContextBundle {
  const close = vi.fn(async () => undefined);
  const newPage = vi.fn(async () => page);
  const pages = vi.fn<() => Page[]>()
    .mockReturnValueOnce([])
    .mockReturnValue([page]);
  const setDefaultNavigationTimeout = vi.fn();
  const setDefaultTimeout = vi.fn();

  return {
    close,
    context: {
      close,
      newPage,
      pages,
      setDefaultNavigationTimeout,
      setDefaultTimeout
    } as unknown as BrowserContext,
    newPage,
    pages,
    setDefaultNavigationTimeout,
    setDefaultTimeout
  };
}

function createMockBrowserBundle(context: BrowserContext): MockBrowserBundle {
  const close = vi.fn(async () => undefined);
  const newContext = vi.fn(async () => context);

  return {
    browser: {
      close,
      newContext
    } as unknown as Browser,
    close,
    newContext
  };
}

function createRuntimeMock(): CoreRuntime & {
  artifacts: {
    registerArtifact: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
  };
  close: ReturnType<typeof vi.fn>;
} {
  const runtime = {
    artifacts: {
      registerArtifact: vi.fn(),
      resolve: vi.fn((relativePath: string) => path.join("/tmp/artifacts", relativePath))
    },
    close: vi.fn(),
    paths: {
      artifactsDir: "/tmp/artifacts",
      baseDir: "/tmp/base",
      dbPath: "/tmp/base/state.sqlite",
      profilesDir: "/tmp/base/profiles"
    },
    selectorLocale: "en"
  };

  return runtime as unknown as CoreRuntime & {
    artifacts: {
      registerArtifact: ReturnType<typeof vi.fn>;
      resolve: ReturnType<typeof vi.fn>;
    };
    close: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-09T10:00:00.000Z"));
  writeValidationRuntimeMocks.loadSession.mockResolvedValue({
    storageState: {
      cookies: [],
      origins: []
    }
  });
  writeValidationRuntimeMocks.waitForNetworkIdleBestEffort.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWriteValidationRuntime", () => {
  it("hydrates a stored-session runtime, blocks CDP reuse, and captures screenshots", async () => {
    const pageBundle = createMockPageBundle();
    const contextBundle = createMockContextBundle(pageBundle.page);
    const browserBundle = createMockBrowserBundle(contextBundle.context);
    const runtime = createRuntimeMock();

    writeValidationRuntimeMocks.createCoreRuntime.mockReturnValue(runtime);
    writeValidationRuntimeMocks.launch.mockResolvedValue(browserBundle.browser);
    writeValidationRuntimeMocks.inspectLinkedInSession.mockResolvedValue({
      authenticated: true,
      checkedAt: "2026-03-09T09:59:00.000Z",
      currentUrl: WRITE_VALIDATION_FEED_URL,
      reason: "Stored session is ready."
    });

    const handle = await createWriteValidationRuntime({
      account: {
        designation: "secondary",
        id: "secondary",
        label: "Secondary",
        profileName: "secondary-profile",
        sessionName: "secondary-session",
        targets: {}
      },
      baseDir: "/tmp/base",
      timeoutMs: 30_000
    });
    const screenshotPath = await handle.profileManager.capturePageScreenshot({
      actionType: "send_message",
      stage: "before",
      url: WRITE_VALIDATION_FEED_URL
    });

    expect(writeValidationRuntimeMocks.createCoreRuntime).toHaveBeenCalledWith({
      baseDir: "/tmp/base"
    });
    expect(writeValidationRuntimeMocks.loadSession).toHaveBeenCalledWith("secondary-session");
    expect(writeValidationRuntimeMocks.launch).toHaveBeenCalledTimes(1);
    expect(contextBundle.setDefaultNavigationTimeout).toHaveBeenCalledWith(30_000);
    expect(contextBundle.setDefaultTimeout).toHaveBeenCalledWith(30_000);
    expect(pageBundle.goto).toHaveBeenNthCalledWith(1, WRITE_VALIDATION_FEED_URL, {
      waitUntil: "domcontentloaded"
    });
    expect(pageBundle.goto).toHaveBeenNthCalledWith(2, WRITE_VALIDATION_FEED_URL, {
      waitUntil: "domcontentloaded"
    });
    expect(contextBundle.newPage).toHaveBeenCalledTimes(1);
    expect(screenshotPath).toBe(
      "live-write-validation/send-message-before-1773050400000.png"
    );
    expect(runtime.artifacts.resolve).toHaveBeenCalledWith(
      "live-write-validation/send-message-before-1773050400000.png"
    );
    expect(runtime.artifacts.registerArtifact).toHaveBeenCalledWith(
      "live-write-validation/send-message-before-1773050400000.png",
      "image/png",
      {
        action: "send_message",
        capture_stage: "before",
        capture_url: WRITE_VALIDATION_FEED_URL
      }
    );
    await expect(
      handle.runtime.profileManager.runWithContext(
        {
          cdpUrl: "http://127.0.0.1:18800",
          profileName: "secondary-profile"
        },
        async () => "ignored"
      )
    ).rejects.toThrow(
      "Stored-session write validation does not support CDP or external browser attachment."
    );
    await handle.profileManager.dispose();
    expect(browserBundle.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up browser and runtime resources when the stored session is not authenticated", async () => {
    const pageBundle = createMockPageBundle();
    const contextBundle = createMockContextBundle(pageBundle.page);
    const browserBundle = createMockBrowserBundle(contextBundle.context);
    const runtime = createRuntimeMock();

    writeValidationRuntimeMocks.createCoreRuntime.mockReturnValue(runtime);
    writeValidationRuntimeMocks.launch.mockResolvedValue(browserBundle.browser);
    writeValidationRuntimeMocks.inspectLinkedInSession.mockResolvedValue({
      authenticated: false,
      checkedAt: "2026-03-09T09:59:00.000Z",
      currentUrl: "https://www.linkedin.com/checkpoint/challenge/",
      reason: "LinkedIn requested a checkpoint challenge."
    });

    let caughtError: unknown;

    try {
      await createWriteValidationRuntime({
        account: {
          designation: "secondary",
          id: "secondary",
          label: "Secondary",
          profileName: "secondary-profile",
          sessionName: "secondary-session",
          targets: {}
        },
        baseDir: "/tmp/base",
        timeoutMs: 30_000
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(LinkedInBuddyError);
    expect(caughtError).toMatchObject({
      code: "CAPTCHA_OR_CHALLENGE",
      message: "LinkedIn requested a checkpoint challenge."
    });
    expect(browserBundle.close).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});
