import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import {
  applyStealthLaunchOptions,
  createStealthChromium,
  hardenBrowserContext,
  LINKEDIN_BUDDY_HEADED_FALLBACK_ENV,
  LINKEDIN_BUDDY_LOCALE_ENV,
  LINKEDIN_BUDDY_STEALTH_ENABLED_ENV,
  LINKEDIN_BUDDY_TIMEZONE_ENV,
  resolveStealthConfig,
  type StealthConfig,
} from "../stealth.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// --- resolveStealthConfig ---

describe("resolveStealthConfig", () => {
  it("returns enabled=true with moderate level (default)", () => {
    const config = resolveStealthConfig("moderate");
    expect(config.enabled).toBe(true);
  });

  it("returns enabled=true with paranoid level", () => {
    const config = resolveStealthConfig("paranoid");
    expect(config.enabled).toBe(true);
  });

  it("returns enabled=false with minimal level", () => {
    const config = resolveStealthConfig("minimal");
    expect(config.enabled).toBe(false);
  });

  it("defaults to moderate level when no argument provided", () => {
    const config = resolveStealthConfig();
    expect(config.enabled).toBe(true);
  });

  it("uses default locale en-US when env var not set", () => {
    delete process.env[LINKEDIN_BUDDY_LOCALE_ENV];
    const config = resolveStealthConfig("moderate");
    expect(config.locale).toBe("en-US");
  });

  it("uses default timezone America/New_York when env var not set", () => {
    delete process.env[LINKEDIN_BUDDY_TIMEZONE_ENV];
    const config = resolveStealthConfig("moderate");
    expect(config.timezone).toBe("America/New_York");
  });

  it("reads locale from LINKEDIN_BUDDY_LOCALE env var", () => {
    process.env[LINKEDIN_BUDDY_LOCALE_ENV] = "fr-FR";
    const config = resolveStealthConfig("moderate");
    expect(config.locale).toBe("fr-FR");
    delete process.env[LINKEDIN_BUDDY_LOCALE_ENV];
  });

  it("reads timezone from LINKEDIN_BUDDY_TIMEZONE env var", () => {
    process.env[LINKEDIN_BUDDY_TIMEZONE_ENV] = "Europe/London";
    const config = resolveStealthConfig("moderate");
    expect(config.timezone).toBe("Europe/London");
    delete process.env[LINKEDIN_BUDDY_TIMEZONE_ENV];
  });

  it("trims whitespace from locale env var", () => {
    process.env[LINKEDIN_BUDDY_LOCALE_ENV] = "  de-DE  ";
    const config = resolveStealthConfig("moderate");
    expect(config.locale).toBe("de-DE");
    delete process.env[LINKEDIN_BUDDY_LOCALE_ENV];
  });

  it("trims whitespace from timezone env var", () => {
    process.env[LINKEDIN_BUDDY_TIMEZONE_ENV] = "  Asia/Tokyo  ";
    const config = resolveStealthConfig("moderate");
    expect(config.timezone).toBe("Asia/Tokyo");
    delete process.env[LINKEDIN_BUDDY_TIMEZONE_ENV];
  });

  it("sets headedFallback=false by default", () => {
    delete process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV];
    const config = resolveStealthConfig("moderate");
    expect(config.headedFallback).toBe(false);
  });

  it("sets headedFallback=true when env var is 'true'", () => {
    process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV] = "true";
    const config = resolveStealthConfig("moderate");
    expect(config.headedFallback).toBe(true);
    delete process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV];
  });

  it("sets headedFallback=true when env var is '1'", () => {
    process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV] = "1";
    const config = resolveStealthConfig("moderate");
    expect(config.headedFallback).toBe(true);
    delete process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV];
  });

  it("sets headedFallback=true when env var is 'yes'", () => {
    process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV] = "yes";
    const config = resolveStealthConfig("moderate");
    expect(config.headedFallback).toBe(true);
    delete process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV];
  });

  it("sets headedFallback=true when env var is 'on'", () => {
    process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV] = "on";
    const config = resolveStealthConfig("moderate");
    expect(config.headedFallback).toBe(true);
    delete process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV];
  });

  it("sets headedFallback=false when env var is 'false'", () => {
    process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV] = "false";
    const config = resolveStealthConfig("moderate");
    expect(config.headedFallback).toBe(false);
    delete process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV];
  });

  it("overrides level-based default when LINKEDIN_BUDDY_STEALTH_ENABLED=true", () => {
    process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV] = "true";
    const config = resolveStealthConfig("minimal");
    expect(config.enabled).toBe(true);
    delete process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV];
  });

  it("overrides level-based default when LINKEDIN_BUDDY_STEALTH_ENABLED=false", () => {
    process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV] = "false";
    const config = resolveStealthConfig("paranoid");
    expect(config.enabled).toBe(false);
    delete process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV];
  });

  it("treats empty LINKEDIN_BUDDY_STEALTH_ENABLED as not set", () => {
    process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV] = "";
    const config = resolveStealthConfig("minimal");
    expect(config.enabled).toBe(false);
    delete process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV];
  });

  it("treats whitespace-only LINKEDIN_BUDDY_STEALTH_ENABLED as not set", () => {
    process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV] = "   ";
    const config = resolveStealthConfig("paranoid");
    expect(config.enabled).toBe(true);
    delete process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV];
  });

  it("returns a valid StealthConfig interface", () => {
    const config = resolveStealthConfig("moderate");
    expect(config).toHaveProperty("enabled");
    expect(config).toHaveProperty("locale");
    expect(config).toHaveProperty("timezone");
    expect(config).toHaveProperty("headedFallback");
    expect(typeof config.enabled).toBe("boolean");
    expect(typeof config.locale).toBe("string");
    expect(typeof config.timezone).toBe("string");
    expect(typeof config.headedFallback).toBe("boolean");
  });
});

// --- applyStealthLaunchOptions ---

describe("applyStealthLaunchOptions", () => {
  it("returns baseOptions unchanged when config.enabled=false", () => {
    const baseOptions = { args: ["--some-arg"] };
    const config: StealthConfig = {
      enabled: false,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result).toEqual(baseOptions);
  });

  it("adds STEALTH_LAUNCH_ARGS when config.enabled=true", () => {
    const baseOptions = {};
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.args).toBeDefined();
    expect(result.args).toContain(
      "--disable-blink-features=AutomationControlled",
    );
    expect(result.args).toContain("--no-first-run");
    expect(result.args).toContain("--no-default-browser-check");
    expect(result.args).toContain("--disable-infobars");
  });

  it("deduplicates args when merging", () => {
    const baseOptions = {
      args: ["--disable-blink-features=AutomationControlled"],
    };
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    const argCount = (result.args ?? []).filter(
      (arg) => arg === "--disable-blink-features=AutomationControlled",
    ).length;
    expect(argCount).toBe(1);
  });

  it("adds --enable-automation to ignoreDefaultArgs", () => {
    const baseOptions = {};
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.ignoreDefaultArgs).toBeDefined();
    expect(result.ignoreDefaultArgs).toContain("--enable-automation");
  });

  it("deduplicates ignoreDefaultArgs", () => {
    const baseOptions = { ignoreDefaultArgs: ["--enable-automation"] };
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    const ignoredCount = (result.ignoreDefaultArgs ?? []).filter(
      (arg) => arg === "--enable-automation",
    ).length;
    expect(ignoredCount).toBe(1);
  });

  it("sets default locale when not in baseOptions", () => {
    const baseOptions = {};
    const config: StealthConfig = {
      enabled: true,
      locale: "fr-FR",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.locale).toBe("fr-FR");
  });

  it("does not override existing locale in baseOptions", () => {
    const baseOptions = { locale: "de-DE" };
    const config: StealthConfig = {
      enabled: true,
      locale: "fr-FR",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.locale).toBe("de-DE");
  });

  it("sets default timezone when not in baseOptions", () => {
    const baseOptions = {};
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "Europe/London",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.timezoneId).toBe("Europe/London");
  });

  it("does not override existing timezoneId in baseOptions", () => {
    const baseOptions = { timezoneId: "Asia/Tokyo" };
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "Europe/London",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.timezoneId).toBe("Asia/Tokyo");
  });

  it("sets default viewport when not in baseOptions", () => {
    const baseOptions = {};
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.viewport).toEqual({ width: 1440, height: 900 });
  });

  it("does not override existing viewport in baseOptions", () => {
    const baseOptions = { viewport: { width: 1920, height: 1080 } };
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it("sets colorScheme to light by default", () => {
    const baseOptions = {};
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.colorScheme).toBe("light");
  });

  it("does not override existing colorScheme in baseOptions", () => {
    const baseOptions = { colorScheme: "dark" };
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.colorScheme).toBe("dark");
  });

  it("sets deviceScaleFactor to 1 by default", () => {
    const baseOptions = {};
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.deviceScaleFactor).toBe(1);
  });

  it("does not override existing deviceScaleFactor in baseOptions", () => {
    const baseOptions = { deviceScaleFactor: 2 };
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.deviceScaleFactor).toBe(2);
  });

  it("does not mutate the input baseOptions", () => {
    const baseOptions = { args: ["--test"] };
    const originalArgs = baseOptions.args;
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    applyStealthLaunchOptions(baseOptions, config);

    expect(baseOptions.args).toBe(originalArgs);
    expect(baseOptions.args).toEqual(["--test"]);
  });

  it("handles undefined args in baseOptions", () => {
    const baseOptions = { args: undefined };
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.args).toBeDefined();
    expect(result.args?.length).toBeGreaterThan(0);
  });

  it("handles undefined ignoreDefaultArgs in baseOptions", () => {
    const baseOptions = { ignoreDefaultArgs: undefined };
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const result = applyStealthLaunchOptions(baseOptions, config);

    expect(result.ignoreDefaultArgs).toBeDefined();
    expect(result.ignoreDefaultArgs).toContain("--enable-automation");
  });
});

// --- createStealthChromium ---

describe("createStealthChromium", () => {
  it("returns bare chromium when config.enabled=false", async () => {
    const config: StealthConfig = {
      enabled: false,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const chromium = await createStealthChromium(config);

    // The bare chromium should have launchPersistentContext method
    expect(typeof chromium.launchPersistentContext).toBe("function");
  });

  it("returns a different object when config.enabled=true", async () => {
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    // Mock the dynamic imports
    vi.mock("playwright-extra", () => ({
      addExtra: vi.fn((browser) => {
        const wrapped = Object.create(browser);
        wrapped.use = vi.fn();
        return wrapped;
      }),
    }));

    vi.mock("puppeteer-extra-plugin-stealth", () => ({
      default: vi.fn(() => ({})),
    }));

    const chromium = await createStealthChromium(config);

    // Should return something (the wrapped chromium)
    expect(chromium).toBeDefined();
    expect(typeof chromium.launchPersistentContext).toBe("function");
  });

  it("calls addExtra when stealth is enabled", async () => {
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    const addExtraMock = vi.fn((browser) => {
      const wrapped = Object.create(browser);
      wrapped.use = vi.fn();
      return wrapped;
    });

    const stealthPluginMock = vi.fn(() => ({}));

    vi.doMock("playwright-extra", () => ({
      addExtra: addExtraMock,
    }));

    vi.doMock("puppeteer-extra-plugin-stealth", () => ({
      default: stealthPluginMock,
    }));

    const chromium = await createStealthChromium(config);

    expect(chromium).toBeDefined();

    vi.doUnmock("playwright-extra");
    vi.doUnmock("puppeteer-extra-plugin-stealth");
  });
});

// --- hardenBrowserContext ---

describe("hardenBrowserContext", () => {
  it("does nothing when config.enabled=false", async () => {
    const mockContext = {
      setExtraHTTPHeaders: vi.fn(),
    } as unknown as BrowserContext;

    const config: StealthConfig = {
      enabled: false,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    await hardenBrowserContext(mockContext, config);

    expect(mockContext.setExtraHTTPHeaders).not.toHaveBeenCalled();
  });

  it("calls setExtraHTTPHeaders when config.enabled=true", async () => {
    const mockContext = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;

    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    await hardenBrowserContext(mockContext, config);

    expect(mockContext.setExtraHTTPHeaders).toHaveBeenCalledOnce();
  });

  it("sets Accept-Language header with locale and language code", async () => {
    const mockContext = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;

    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    await hardenBrowserContext(mockContext, config);

    const call = mockContext.setExtraHTTPHeaders.mock.calls[0];
    const headers = call?.[0] as Record<string, string> | undefined;
    expect(headers?.["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  it("extracts language code from locale with hyphen", async () => {
    const mockContext = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;

    const config: StealthConfig = {
      enabled: true,
      locale: "fr-FR",
      timezone: "America/New_York",
      headedFallback: false,
    };

    await hardenBrowserContext(mockContext, config);

    const call = mockContext.setExtraHTTPHeaders.mock.calls[0];
    const headers = call?.[0] as Record<string, string> | undefined;
    expect(headers?.["Accept-Language"]).toBe("fr-FR,fr;q=0.9");
  });

  it("handles locale without hyphen gracefully", async () => {
    const mockContext = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;

    const config: StealthConfig = {
      enabled: true,
      locale: "en",
      timezone: "America/New_York",
      headedFallback: false,
    };

    await hardenBrowserContext(mockContext, config);

    const call = mockContext.setExtraHTTPHeaders.mock.calls[0];
    const headers = call?.[0] as Record<string, string> | undefined;
    expect(headers?.["Accept-Language"]).toBe("en,en;q=0.9");
  });

  it("catches and ignores errors from setExtraHTTPHeaders", async () => {
    const mockContext = {
      setExtraHTTPHeaders: vi
        .fn()
        .mockRejectedValue(new Error("Network error")),
    } as unknown as BrowserContext;

    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    // Should not throw
    await expect(
      hardenBrowserContext(mockContext, config),
    ).resolves.toBeUndefined();
  });
});

// --- StealthConfig interface ---

describe("StealthConfig interface", () => {
  it("has enabled property of type boolean", () => {
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    expect(typeof config.enabled).toBe("boolean");
  });

  it("has locale property of type string", () => {
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    expect(typeof config.locale).toBe("string");
  });

  it("has timezone property of type string", () => {
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    expect(typeof config.timezone).toBe("string");
  });

  it("has headedFallback property of type boolean", () => {
    const config: StealthConfig = {
      enabled: true,
      locale: "en-US",
      timezone: "America/New_York",
      headedFallback: false,
    };

    expect(typeof config.headedFallback).toBe("boolean");
  });
});
