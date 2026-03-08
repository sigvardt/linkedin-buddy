import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV,
  getLinkedInSelectorLocaleConfigWarning,
  resolveLinkedInSelectorLocaleConfigResolution
} from "../src/index.js";

describe("selector locale config warnings", () => {
  let previousSelectorLocaleEnv: string | undefined;

  beforeEach(() => {
    previousSelectorLocaleEnv = process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
    delete process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
  });

  afterEach(() => {
    if (typeof previousSelectorLocaleEnv === "string") {
      process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV] = previousSelectorLocaleEnv;
      return;
    }

    delete process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
  });

  it("formats CLI guidance for unsupported explicit locales", () => {
    const warning = getLinkedInSelectorLocaleConfigWarning(
      resolveLinkedInSelectorLocaleConfigResolution("fr-CA"),
      "cli"
    );

    expect(warning).toMatchObject({
      message: 'Unsupported selector locale "fr-ca" from --selector-locale.',
      actionTaken: 'Using English ("en") selector phrases for this run.',
      supportedLocales: ["en", "da"]
    });
    expect(warning?.guidance).toContain("Supported locales: en, da.");
    expect(warning?.guidance).toContain("Region tags like da-DK normalize to da.");
    expect(warning?.guidance).toContain("--selector-locale <locale>");
  });

  it("formats runtime guidance for env-based blank values", () => {
    process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV] = "   ";

    const warning = getLinkedInSelectorLocaleConfigWarning(
      resolveLinkedInSelectorLocaleConfigResolution(),
      "runtime"
    );

    expect(warning).toMatchObject({
      message: `${LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV} was set but blank.`,
      actionTaken: 'Using English ("en") selector phrases for this run.',
      supportedLocales: ["en", "da"]
    });
    expect(warning?.guidance).toContain("Use a locale tag like en, da, or da-DK.");
    expect(warning?.guidance).toContain(LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV);
    expect(warning?.guidance).toContain("selectorLocale");
  });

  it("returns no warning for supported locales", () => {
    const warning = getLinkedInSelectorLocaleConfigWarning(
      resolveLinkedInSelectorLocaleConfigResolution("da-DK"),
      "cli"
    );

    expect(warning).toBeNull();
  });
});
