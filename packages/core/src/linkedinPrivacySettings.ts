import { type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import {
  LinkedInBuddyError,
  asLinkedInBuddyError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  peekRateLimitPreview,
  type ConsumeRateLimitInput,
  type RateLimiter
} from "./rateLimiter.js";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";
import {
  normalizeText,
  getOrCreatePage,
  escapeRegExp,
  dedupePhrases
} from "./shared.js";

export const LINKEDIN_PRIVACY_SETTING_KEYS = [
  "profile_viewing_mode",
  "connections_visibility",
  "last_name_visibility"
] as const;

export type LinkedInPrivacySettingKey =
  (typeof LINKEDIN_PRIVACY_SETTING_KEYS)[number];

export interface GetLinkedInPrivacySettingsInput {
  profileName?: string;
}

export interface PrepareUpdateLinkedInPrivacySettingInput {
  profileName?: string;
  settingKey: LinkedInPrivacySettingKey | string;
  value: string;
  operatorNote?: string;
}

export interface LinkedInPrivacySettingDefinition {
  key: LinkedInPrivacySettingKey;
  label: string;
  description: string;
  allowed_values: readonly string[];
}

export interface LinkedInPrivacySettingState
  extends LinkedInPrivacySettingDefinition {
  current_value: string | null;
  status: "available" | "unavailable";
  source_url: string | null;
  selector_key: string | null;
  message: string | null;
}

export interface LinkedInPrivacySettingsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  rateLimiter: RateLimiter;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInPrivacySettingsRuntime
  extends LinkedInPrivacySettingsExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInPrivacySettingsExecutorRuntime>,
    "prepare"
  >;
}

export const UPDATE_PRIVACY_SETTING_ACTION_TYPE = "privacy.update_setting";

const UPDATE_PRIVACY_SETTING_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.privacy.update_setting",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 10
} as const satisfies ConsumeRateLimitInput;

interface VisibleLocatorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (root: Page | Locator) => Locator;
}

interface ToggleControlCandidate extends VisibleLocatorCandidate {
  readState: (locator: Locator) => Promise<boolean | null>;
}

interface ToggleControlMatch {
  locator: Locator;
  key: string;
  state: boolean | null;
}

interface LinkedInPrivacySettingReadResult {
  currentValue: string;
  selectorKey: string | null;
}

interface LinkedInPrivacySettingApplyResult {
  previousValue: string | null;
  currentValue: string;
  selectorKey: string | null;
  sourceUrl: string;
}

interface LinkedInPrivacySettingDescriptor {
  key: LinkedInPrivacySettingKey;
  label: string;
  description: string;
  allowedValues: readonly string[];
  urls: readonly string[];
  read: (
    page: Page,
    selectorLocale: LinkedInSelectorLocale
  ) => Promise<LinkedInPrivacySettingReadResult>;
  apply: (
    page: Page,
    selectorLocale: LinkedInSelectorLocale,
    value: string
  ) => Promise<Omit<LinkedInPrivacySettingApplyResult, "sourceUrl">>;
}

const PROFILE_VIEWING_MODE_VALUE_ORDER = [
  "full_profile",
  "private_profile_characteristics",
  "private_mode"
] as const;

const TOGGLE_ON_VALUE_MAP = {
  connections_visibility: "visible",
  last_name_visibility: "full_last_name"
} as const;

const TOGGLE_OFF_VALUE_MAP = {
  connections_visibility: "hidden",
  last_name_visibility: "last_initial"
} as const;

function buildPhraseRegex(
  phrases: readonly string[],
  options: { exact?: boolean } = {}
): RegExp {
  const normalizedPhrases = dedupePhrases(phrases);
  const body = normalizedPhrases.map((phrase) => escapeRegExp(phrase)).join("|") || "^$";
  const pattern = options.exact ? `^(?:${body})$` : `(?:${body})`;
  return new RegExp(pattern, "iu");
}

function getProfileViewingModeDisplayLabel(value: string): string {
  return value
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeLinkedInPrivacySettingDescriptorValue(
  settingKey: LinkedInPrivacySettingKey,
  value: string
): string {
  const descriptor = LINKEDIN_PRIVACY_SETTING_DESCRIPTORS[settingKey];
  const normalizedValue = normalizeText(value).toLowerCase();
  const matchedValue = descriptor.allowedValues.find((candidate) => {
    return candidate.toLowerCase() === normalizedValue;
  });

  if (matchedValue) {
    return matchedValue;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${settingKey} value must be one of: ${descriptor.allowedValues.join(", ")}.`
  );
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  return condition();
}

async function findVisibleLocator(
  root: Page | Locator,
  candidates: readonly VisibleLocatorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    if (await locator.isVisible().catch(() => false)) {
      return {
        locator,
        key: candidate.key
      };
    }
  }

  return null;
}

async function findVisibleToggleControl(
  page: Page,
  candidates: readonly ToggleControlCandidate[]
): Promise<ToggleControlMatch | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }

    return {
      locator,
      key: candidate.key,
      state: await candidate.readState(locator)
    };
  }

  return null;
}

function createSettingsSaveButtonCandidates(): VisibleLocatorCandidate[] {
  const exactRegex = buildPhraseRegex(["Save", "Done"], { exact: true });
  const textRegex = buildPhraseRegex(["Save changes", "Save", "Done"]);

  return [
    {
      key: "settings-save-role",
      selectorHint: "getByRole(button, /^(?:Save|Done)$/iu)",
      locatorFactory: (root) =>
        root.getByRole("button", {
          name: exactRegex
        })
    },
    {
      key: "settings-save-text",
      selectorHint: "button hasText /(?:Save changes|Save|Done)/iu",
      locatorFactory: (root) =>
        root.locator("button").filter({
          hasText: textRegex
        })
    },
    {
      key: "settings-save-primary",
      selectorHint: "button.artdeco-button--primary",
      locatorFactory: (root) =>
        root.locator("button.artdeco-button--primary")
    }
  ];
}

async function maybeClickSettingsSaveButton(page: Page): Promise<string | null> {
  const button = await findVisibleLocator(page, createSettingsSaveButtonCandidates());
  if (!button) {
    return null;
  }

  await button.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(600);
  return button.key;
}

function createProfileViewingModeOptionCandidates(
  value: (typeof PROFILE_VIEWING_MODE_VALUE_ORDER)[number]
): VisibleLocatorCandidate[] {
  const label =
    value === "full_profile"
      ? "Your name and headline"
      : value === "private_profile_characteristics"
        ? "Private profile characteristics"
        : "Private mode";
  const exactRegex = buildPhraseRegex([label], { exact: true });
  const textRegex = buildPhraseRegex([label]);

  return [
    {
      key: `profile-viewing-mode-${value}-role-radio`,
      selectorHint: `getByRole(radio, /^(?:${escapeRegExp(label)})$/iu)`,
      locatorFactory: (root) =>
        root.getByRole("radio", {
          name: exactRegex
        })
    },
    {
      key: `profile-viewing-mode-${value}-role-button`,
      selectorHint: `getByRole(button, /^(?:${escapeRegExp(label)})$/iu)`,
      locatorFactory: (root) =>
        root.getByRole("button", {
          name: exactRegex
        })
    },
    {
      key: `profile-viewing-mode-${value}-label-text`,
      selectorHint: `label hasText /(?:${escapeRegExp(label)})/iu`,
      locatorFactory: (root) =>
        root.locator("label").filter({
          hasText: textRegex
        })
    }
  ];
}

function createToggleControlCandidates(): ToggleControlCandidate[] {
  return [
    {
      key: "toggle-role-switch",
      selectorHint: "getByRole(switch)",
      locatorFactory: (root) => root.getByRole("switch"),
      readState: async (locator) => {
        const ariaChecked = await locator.getAttribute("aria-checked");
        if (ariaChecked === "true") {
          return true;
        }
        if (ariaChecked === "false") {
          return false;
        }
        return null;
      }
    },
    {
      key: "toggle-role-checkbox",
      selectorHint: "getByRole(checkbox)",
      locatorFactory: (root) => root.getByRole("checkbox"),
      readState: async (locator) => {
        const ariaChecked = await locator.getAttribute("aria-checked");
        if (ariaChecked === "true") {
          return true;
        }
        if (ariaChecked === "false") {
          return false;
        }
        return null;
      }
    },
    {
      key: "toggle-input-checkbox",
      selectorHint: "input[type='checkbox']",
      locatorFactory: (root) => root.locator("input[type='checkbox']"),
      readState: async (locator) => locator.isChecked().catch(() => null)
    },
    {
      key: "toggle-button-aria-pressed",
      selectorHint: "button[aria-pressed]",
      locatorFactory: (root) => root.locator("button[aria-pressed]"),
      readState: async (locator) => {
        const ariaPressed = await locator.getAttribute("aria-pressed");
        if (ariaPressed === "true") {
          return true;
        }
        if (ariaPressed === "false") {
          return false;
        }
        return null;
      }
    },
    {
      key: "toggle-button-aria-checked",
      selectorHint: "button[aria-checked]",
      locatorFactory: (root) => root.locator("button[aria-checked]"),
      readState: async (locator) => {
        const ariaChecked = await locator.getAttribute("aria-checked");
        if (ariaChecked === "true") {
          return true;
        }
        if (ariaChecked === "false") {
          return false;
        }
        return null;
      }
    }
  ];
}

async function readProfileViewingModeState(
  page: Page
): Promise<LinkedInPrivacySettingReadResult> {
  const radioInputs = page.locator(
    "main input[type='radio'], [role='main'] input[type='radio'], form input[type='radio']"
  );
  const radioInputCount = await radioInputs.count();

  for (
    let index = 0;
    index < Math.min(radioInputCount, PROFILE_VIEWING_MODE_VALUE_ORDER.length);
    index += 1
  ) {
    if (await radioInputs.nth(index).isChecked().catch(() => false)) {
      return {
        currentValue: PROFILE_VIEWING_MODE_VALUE_ORDER[index]!,
        selectorKey: `profile-viewing-mode-input-index-${index}`
      };
    }
  }

  const roleRadios = page.locator(
    "main [role='radio'], [role='main'] [role='radio'], form [role='radio']"
  );
  const roleRadioCount = await roleRadios.count();

  for (
    let index = 0;
    index < Math.min(roleRadioCount, PROFILE_VIEWING_MODE_VALUE_ORDER.length);
    index += 1
  ) {
    const radio = roleRadios.nth(index);
    const ariaChecked = await radio.getAttribute("aria-checked");
    if (ariaChecked === "true") {
      return {
        currentValue: PROFILE_VIEWING_MODE_VALUE_ORDER[index]!,
        selectorKey: `profile-viewing-mode-role-index-${index}`
      };
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not determine the current LinkedIn profile viewing mode.",
    {
      attempted_selectors: [
        "main input[type='radio']",
        "[role='main'] input[type='radio']",
        "form input[type='radio']",
        "main [role='radio']",
        "[role='main'] [role='radio']",
        "form [role='radio']"
      ]
    }
  );
}

async function applyProfileViewingMode(
  page: Page,
  value: string
): Promise<Omit<LinkedInPrivacySettingApplyResult, "sourceUrl">> {
  const targetValue = normalizeLinkedInPrivacySettingDescriptorValue(
    "profile_viewing_mode",
    value
  ) as (typeof PROFILE_VIEWING_MODE_VALUE_ORDER)[number];
  const before = await readProfileViewingModeState(page);
  if (before.currentValue === targetValue) {
    return {
      previousValue: before.currentValue,
      currentValue: before.currentValue,
      selectorKey: before.selectorKey
    };
  }

  const explicitOption = await findVisibleLocator(
    page,
    createProfileViewingModeOptionCandidates(targetValue)
  );

  if (explicitOption) {
    await explicitOption.locator.click({ timeout: 5_000 });
  } else {
    const fallbackIndex = PROFILE_VIEWING_MODE_VALUE_ORDER.indexOf(targetValue);
    const roleRadios = page.locator(
      "main [role='radio'], [role='main'] [role='radio'], form [role='radio']"
    );
    if ((await roleRadios.count()) >= PROFILE_VIEWING_MODE_VALUE_ORDER.length) {
      await roleRadios.nth(fallbackIndex).click({ timeout: 5_000 });
    } else {
      const fallbackLabels = page.locator(
        "main label, [role='main'] label, form label"
      );
      if ((await fallbackLabels.count()) <= fallbackIndex) {
        throw new LinkedInBuddyError(
          "UI_CHANGED_SELECTOR_FAILED",
          `Could not find the ${getProfileViewingModeDisplayLabel(targetValue)} profile viewing mode option.`,
          {
            attempted_selectors: createProfileViewingModeOptionCandidates(
              targetValue
            ).map((candidate) => candidate.selectorHint)
          }
        );
      }

      await fallbackLabels.nth(fallbackIndex).click({ timeout: 5_000 });
    }
  }

  const saveSelectorKey = await maybeClickSettingsSaveButton(page);
  const updated = await waitForCondition(async () => {
    const state = await readProfileViewingModeState(page).catch(() => null);
    return state?.currentValue === targetValue;
  }, 5_000);

  if (!updated) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      `LinkedIn profile viewing mode could not be updated to ${targetValue}.`,
      {
        requested_value: targetValue,
        save_selector_key: saveSelectorKey
      }
    );
  }

  const after = await readProfileViewingModeState(page);
  return {
    previousValue: before.currentValue,
    currentValue: after.currentValue,
    selectorKey: explicitOption
      ? saveSelectorKey
        ? `${explicitOption.key}:${saveSelectorKey}`
        : explicitOption.key
      : saveSelectorKey
  };
}

async function readToggleSettingState(
  page: Page,
  settingKey: keyof typeof TOGGLE_ON_VALUE_MAP
): Promise<LinkedInPrivacySettingReadResult> {
  const toggle = await findVisibleToggleControl(page, createToggleControlCandidates());
  if (!toggle || typeof toggle.state !== "boolean") {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      `Could not find the ${settingKey} toggle on the LinkedIn settings page.`,
      {
        attempted_selectors: createToggleControlCandidates().map(
          (candidate) => candidate.selectorHint
        )
      }
    );
  }

  return {
    currentValue: toggle.state
      ? TOGGLE_ON_VALUE_MAP[settingKey]
      : TOGGLE_OFF_VALUE_MAP[settingKey],
    selectorKey: toggle.key
  };
}

async function applyToggleSetting(
  page: Page,
  settingKey: keyof typeof TOGGLE_ON_VALUE_MAP,
  value: string
): Promise<Omit<LinkedInPrivacySettingApplyResult, "sourceUrl">> {
  const requestedValue = normalizeLinkedInPrivacySettingDescriptorValue(
    settingKey,
    value
  );
  const before = await readToggleSettingState(page, settingKey);
  if (before.currentValue === requestedValue) {
    return {
      previousValue: before.currentValue,
      currentValue: before.currentValue,
      selectorKey: before.selectorKey
    };
  }

  const toggle = await findVisibleToggleControl(page, createToggleControlCandidates());
  if (!toggle) {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      `Could not find the ${settingKey} toggle on the LinkedIn settings page.`,
      {
        attempted_selectors: createToggleControlCandidates().map(
          (candidate) => candidate.selectorHint
        )
      }
    );
  }

  await toggle.locator.click({ timeout: 5_000 });
  const saveSelectorKey = await maybeClickSettingsSaveButton(page);
  const updated = await waitForCondition(async () => {
    const state = await readToggleSettingState(page, settingKey).catch(() => null);
    return state?.currentValue === requestedValue;
  }, 5_000);

  if (!updated) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      `LinkedIn ${settingKey} could not be updated to ${requestedValue}.`,
      {
        requested_value: requestedValue,
        toggle_selector_key: toggle.key,
        save_selector_key: saveSelectorKey
      }
    );
  }

  const after = await readToggleSettingState(page, settingKey);
  return {
    previousValue: before.currentValue,
    currentValue: after.currentValue,
    selectorKey: saveSelectorKey ? `${toggle.key}:${saveSelectorKey}` : toggle.key
  };
}

const LINKEDIN_PRIVACY_SETTING_DEFINITIONS: readonly LinkedInPrivacySettingDefinition[] =
  Object.freeze([
    {
      key: "profile_viewing_mode",
      label: "Profile viewing mode",
      description:
        "Controls how your profile appears when you browse other LinkedIn members.",
      allowed_values: PROFILE_VIEWING_MODE_VALUE_ORDER
    },
    {
      key: "connections_visibility",
      label: "Connections visibility",
      description:
        "Controls whether other LinkedIn members can see your connections list.",
      allowed_values: ["visible", "hidden"]
    },
    {
      key: "last_name_visibility",
      label: "Last name visibility",
      description:
        "Controls whether LinkedIn shows your full last name or only the initial.",
      allowed_values: ["full_last_name", "last_initial"]
    }
  ]);

const LINKEDIN_PRIVACY_SETTING_DESCRIPTORS: Record<
  LinkedInPrivacySettingKey,
  LinkedInPrivacySettingDescriptor
> = {
  profile_viewing_mode: {
    key: "profile_viewing_mode",
    label: "Profile viewing mode",
    description:
      "Controls how your profile appears when you browse other LinkedIn members.",
    allowedValues: PROFILE_VIEWING_MODE_VALUE_ORDER,
    urls: [
      "https://www.linkedin.com/mypreferences/d/profile-viewing-options",
      "https://www.linkedin.com/mypreferences/d/visibility/profile-viewing-options"
    ],
    read: async (page) => readProfileViewingModeState(page),
    apply: async (page, _selectorLocale, value) =>
      applyProfileViewingMode(page, value)
  },
  connections_visibility: {
    key: "connections_visibility",
    label: "Connections visibility",
    description:
      "Controls whether other LinkedIn members can see your connections list.",
    allowedValues: ["visible", "hidden"],
    urls: [
      "https://www.linkedin.com/mypreferences/d/connections-visibility",
      "https://www.linkedin.com/mypreferences/d/visibility/connections-visibility"
    ],
    read: async (page) => readToggleSettingState(page, "connections_visibility"),
    apply: async (page, _selectorLocale, value) =>
      applyToggleSetting(page, "connections_visibility", value)
  },
  last_name_visibility: {
    key: "last_name_visibility",
    label: "Last name visibility",
    description:
      "Controls whether LinkedIn shows your full last name or only the initial.",
    allowedValues: ["full_last_name", "last_initial"],
    urls: [
      "https://www.linkedin.com/mypreferences/d/last-name-visibility",
      "https://www.linkedin.com/mypreferences/d/name-visibility",
      "https://www.linkedin.com/mypreferences/d/visibility/last-name-visibility",
      "https://www.linkedin.com/mypreferences/d/visibility/name-visibility"
    ],
    read: async (page) => readToggleSettingState(page, "last_name_visibility"),
    apply: async (page, _selectorLocale, value) =>
      applyToggleSetting(page, "last_name_visibility", value)
  }
};

async function withPrivacySettingsPage<T>(
  page: Page,
  descriptor: LinkedInPrivacySettingDescriptor,
  action: (page: Page, sourceUrl: string) => Promise<T>
): Promise<T> {
  const errors: Array<Record<string, string>> = [];

  for (const url of descriptor.urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);
      return await action(page, url);
    } catch (error) {
      errors.push({
        url,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not open the LinkedIn ${descriptor.label.toLowerCase()} setting page.`,
    {
      setting_key: descriptor.key,
      attempted_urls: descriptor.urls,
      errors
    }
  );
}

export function getLinkedInPrivacySettingDefinitions():
  readonly LinkedInPrivacySettingDefinition[] {
  return LINKEDIN_PRIVACY_SETTING_DEFINITIONS;
}

export function normalizeLinkedInPrivacySettingKey(
  value: string
): LinkedInPrivacySettingKey {
  const normalizedValue = normalizeText(value).toLowerCase();
  const matchedKey = LINKEDIN_PRIVACY_SETTING_KEYS.find((candidate) => {
    return candidate.toLowerCase() === normalizedValue;
  });

  if (matchedKey) {
    return matchedKey;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `settingKey must be one of: ${LINKEDIN_PRIVACY_SETTING_KEYS.join(", ")}.`
  );
}

export function normalizeLinkedInPrivacySettingValue(
  settingKey: LinkedInPrivacySettingKey,
  value: string
): string {
  return normalizeLinkedInPrivacySettingDescriptorValue(settingKey, value);
}

async function executeUpdatePrivacySetting(
  runtime: LinkedInPrivacySettingsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const settingKey = normalizeLinkedInPrivacySettingKey(
    String(target.setting_key ?? payload.setting_key ?? "")
  );
  const requestedValue = normalizeLinkedInPrivacySettingDescriptorValue(
    settingKey,
    String(payload.value ?? "")
  );
  const descriptor = LINKEDIN_PRIVACY_SETTING_DESCRIPTORS[settingKey];

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: UPDATE_PRIVACY_SETTING_ACTION_TYPE,
        profileName,
        targetUrl: descriptor.urls[0],
        metadata: {
          setting_key: settingKey,
          requested_value: requestedValue
        },
        errorDetails: {
          setting_key: settingKey,
          requested_value: requestedValue
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: UPDATE_PRIVACY_SETTING_RATE_LIMIT_CONFIG,
            message: createConfirmRateLimitMessage(
              UPDATE_PRIVACY_SETTING_ACTION_TYPE
            ),
            details: {
              action_id: actionId,
              profile_name: profileName,
              setting_key: settingKey,
              requested_value: requestedValue
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            `Failed to execute LinkedIn privacy setting update for ${settingKey}.`
          ),
        execute: async () => {
          const update = await withPrivacySettingsPage(
            page,
            descriptor,
            async (currentPage, sourceUrl) => {
              const result = await descriptor.apply(
                currentPage,
                runtime.selectorLocale,
                requestedValue
              );
              return {
                ...result,
                sourceUrl
              };
            }
          );

          return {
            ok: true,
            result: {
              status: "privacy_setting_updated",
              setting_key: settingKey,
              previous_value: update.previousValue,
              value: update.currentValue,
              source_url: update.sourceUrl,
              selector_key: update.selectorKey
            },
            artifacts: []
          };
        }
      });
    }
  );
}

export class UpdatePrivacySettingActionExecutor
  implements ActionExecutor<LinkedInPrivacySettingsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPrivacySettingsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUpdatePrivacySetting(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return {
      ok: true,
      result,
      artifacts
    };
  }
}

export function createPrivacySettingActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInPrivacySettingsExecutorRuntime>
> {
  return {
    [UPDATE_PRIVACY_SETTING_ACTION_TYPE]:
      new UpdatePrivacySettingActionExecutor()
  };
}

export class LinkedInPrivacySettingsService {
  constructor(private readonly runtime: LinkedInPrivacySettingsRuntime) {}

  async getSettings(
    input: GetLinkedInPrivacySettingsInput = {}
  ): Promise<LinkedInPrivacySettingState[]> {
    const profileName = input.profileName ?? "default";

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    return this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        const settings: LinkedInPrivacySettingState[] = [];

        for (const definition of LINKEDIN_PRIVACY_SETTING_DEFINITIONS) {
          const descriptor =
            LINKEDIN_PRIVACY_SETTING_DESCRIPTORS[definition.key];

          try {
            const state = await withPrivacySettingsPage(
              page,
              descriptor,
              async (currentPage, sourceUrl) => {
                const result = await descriptor.read(
                  currentPage,
                  this.runtime.selectorLocale
                );
                return {
                  ...result,
                  sourceUrl
                };
              }
            );

            settings.push({
              ...definition,
              current_value: state.currentValue,
              status: "available",
              source_url: state.sourceUrl,
              selector_key: state.selectorKey,
              message: null
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            settings.push({
              ...definition,
              current_value: null,
              status: "unavailable",
              source_url: null,
              selector_key: null,
              message
            });
            this.runtime.logger.log(
              "warn",
              "privacy.settings.read.unavailable",
              {
                profile_name: profileName,
                setting_key: definition.key,
                message
              }
            );
          }
        }

        return settings;
      }
    );
  }

  prepareUpdateSetting(
    input: PrepareUpdateLinkedInPrivacySettingInput
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const settingKey = normalizeLinkedInPrivacySettingKey(input.settingKey);
    const value = normalizeLinkedInPrivacySettingDescriptorValue(
      settingKey,
      input.value
    );
    const descriptor = LINKEDIN_PRIVACY_SETTING_DESCRIPTORS[settingKey];
    const target = {
      profile_name: profileName,
      setting_key: settingKey
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPDATE_PRIVACY_SETTING_ACTION_TYPE,
      target,
      payload: {
        setting_key: settingKey,
        value
      },
      preview: {
        summary: `Update LinkedIn privacy setting ${settingKey} to ${value}`,
        target,
        setting: {
          key: settingKey,
          label: descriptor.label,
          description: descriptor.description,
          value
        },
        rate_limit: peekRateLimitPreview(
          this.runtime.rateLimiter,
          UPDATE_PRIVACY_SETTING_RATE_LIMIT_CONFIG
        )
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
