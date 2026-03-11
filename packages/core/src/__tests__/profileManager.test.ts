import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import type { ConfigPaths } from "../config.js";
import { ProfileManager } from "../profileManager.js";

const playwrightMocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  launchPersistentContext: vi.fn()
}));

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: playwrightMocks.connectOverCDP,
    launchPersistentContext: playwrightMocks.launchPersistentContext
  }
}));

const TEST_PATHS: ConfigPaths = {
  baseDir: "/tmp/linkedin-buddy",
  artifactsDir: "/tmp/linkedin-buddy/artifacts",
  profilesDir: "/tmp/linkedin-buddy/profiles",
  dbPath: "/tmp/linkedin-buddy/state.sqlite"
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProfileManager.runWithContext", () => {
  it("dispatches to runWithCDP when cdpUrl is provided", async () => {
    const profileManager = new ProfileManager(TEST_PATHS);
    const callback = vi.fn(async () => "callback-result");
    const runWithCDPSpy = vi
      .spyOn(profileManager, "runWithCDP")
      .mockResolvedValue("cdp-result");
    const runWithPersistentContextSpy = vi
      .spyOn(profileManager, "runWithPersistentContext")
      .mockResolvedValue("persistent-result");

    const result = await profileManager.runWithContext(
      {
        cdpUrl: "http://127.0.0.1:18800",
        profileName: "default",
        headless: false
      },
      callback
    );

    expect(result).toBe("cdp-result");
    expect(runWithCDPSpy).toHaveBeenCalledWith("http://127.0.0.1:18800", callback);
    expect(runWithPersistentContextSpy).not.toHaveBeenCalled();
  });

  it("dispatches to runWithPersistentContext when cdpUrl is not provided", async () => {
    const profileManager = new ProfileManager(TEST_PATHS);
    const callback = vi.fn(async () => "callback-result");
    const runWithPersistentContextSpy = vi
      .spyOn(profileManager, "runWithPersistentContext")
      .mockResolvedValue("persistent-result");
    const runWithCDPSpy = vi
      .spyOn(profileManager, "runWithCDP")
      .mockResolvedValue("cdp-result");

    const result = await profileManager.runWithContext(
      {
        profileName: "default"
      },
      callback
    );

    expect(result).toBe("persistent-result");
    expect(runWithPersistentContextSpy).toHaveBeenCalledWith(
      "default",
      { headless: true },
      callback
    );
    expect(runWithCDPSpy).not.toHaveBeenCalled();
  });
});

describe("ProfileManager.runWithCDP", () => {
  it("connects over CDP and uses the first browser context", async () => {
    const profileManager = new ProfileManager(TEST_PATHS);
    const context = {} as BrowserContext;
    const close = vi.fn(async () => undefined);
    const callback = vi.fn(async (receivedContext: BrowserContext) => {
      expect(receivedContext).toBe(context);
      return "done";
    });

    playwrightMocks.connectOverCDP.mockResolvedValue({
      contexts: () => [context],
      close
    });

    const result = await profileManager.runWithCDP("http://127.0.0.1:18800", callback);

    expect(result).toBe("done");
    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledWith(
      "http://127.0.0.1:18800"
    );
    expect(callback).toHaveBeenCalledWith(context);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
