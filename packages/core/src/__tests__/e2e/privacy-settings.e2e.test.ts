import { describe, expect, it } from "vitest";
import type { LinkedInPrivacySettingState } from "../../linkedinPrivacySettings.js";
import {
  callMcpTool,
  expectPreparedAction,
  getDefaultProfileName,
  MCP_TOOL_NAMES
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const VALID_PROFILE_VIEWING_MODE_VALUES = new Set([
  "full_profile",
  "private_profile_characteristics",
  "private_mode"
]);

const VALID_CONNECTIONS_VISIBILITY_VALUES = new Set(["visible", "hidden"]);

const VALID_LAST_NAME_VISIBILITY_VALUES = new Set([
  "full_last_name",
  "last_initial"
]);

function expectPrivacySettingShape(setting: LinkedInPrivacySettingState): void {
  expect(typeof setting.key).toBe("string");
  expect(setting.key.length).toBeGreaterThan(0);
  expect(typeof setting.label).toBe("string");
  expect(setting.label.length).toBeGreaterThan(0);
  expect(typeof setting.description).toBe("string");
  expect(setting.description.length).toBeGreaterThan(0);
  expect(Array.isArray(setting.allowed_values)).toBe(true);
  expect(setting.allowed_values.length).toBeGreaterThan(0);
  expect(setting.status === "available" || setting.status === "unavailable").toBe(
    true
  );
}

function expectAvailableSetting(
  setting: LinkedInPrivacySettingState,
  validValues: Set<string>
): void {
  expectPrivacySettingShape(setting);
  expect(setting.status).toBe("available");
  expect(typeof setting.current_value).toBe("string");
  expect(setting.current_value!.length).toBeGreaterThan(0);
  expect(validValues.has(setting.current_value!)).toBe(true);
  expect(typeof setting.source_url).toBe("string");
  expect(setting.source_url!.length).toBeGreaterThan(0);
  expect(setting.message).toBeNull();
}

function findSettingByKey(
  settings: LinkedInPrivacySettingState[],
  key: string
): LinkedInPrivacySettingState {
  const setting = settings.find((s) => s.key === key);
  expect(setting, `Expected to find setting with key "${key}"`).toBeDefined();
  return setting!;
}

describe("Privacy Settings E2E", () => {
  const e2e = setupE2ESuite();

  it("getSettings returns all three privacy settings", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const settings = await runtime.privacySettings.getSettings();

    expect(Array.isArray(settings)).toBe(true);
    expect(settings).toHaveLength(3);

    for (const setting of settings) {
      expectPrivacySettingShape(setting);
    }

    const keys = settings.map((s) => s.key);
    expect(keys).toContain("profile_viewing_mode");
    expect(keys).toContain("connections_visibility");
    expect(keys).toContain("last_name_visibility");
  }, 120_000);

  it("profile_viewing_mode returns a recognized value", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const settings = await runtime.privacySettings.getSettings();
    const setting = findSettingByKey(settings, "profile_viewing_mode");

    expectAvailableSetting(setting, VALID_PROFILE_VIEWING_MODE_VALUES);
    expect(setting.allowed_values).toEqual([
      "full_profile",
      "private_profile_characteristics",
      "private_mode"
    ]);
  }, 120_000);

  it("connections_visibility returns a recognized value", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const settings = await runtime.privacySettings.getSettings();
    const setting = findSettingByKey(settings, "connections_visibility");

    expectAvailableSetting(setting, VALID_CONNECTIONS_VISIBILITY_VALUES);
    expect(setting.allowed_values).toEqual(["visible", "hidden"]);
  }, 120_000);

  it("last_name_visibility returns a recognized value", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const settings = await runtime.privacySettings.getSettings();
    const setting = findSettingByKey(settings, "last_name_visibility");

    expectAvailableSetting(setting, VALID_LAST_NAME_VISIBILITY_VALUES);
    expect(setting.allowed_values).toEqual(["full_last_name", "last_initial"]);
  }, 120_000);

  it("settings are consistent across consecutive reads", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const first = await runtime.privacySettings.getSettings();
    const second = await runtime.privacySettings.getSettings();

    expect(first).toHaveLength(second.length);
    for (const firstSetting of first) {
      const secondSetting = findSettingByKey(second, firstSetting.key);
      expect(firstSetting.current_value).toBe(secondSetting.current_value);
      expect(firstSetting.status).toBe(secondSetting.status);
    }
  }, 180_000);

  it("prepareUpdateSetting for profile_viewing_mode returns valid prepared action", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const prepared = runtime.privacySettings.prepareUpdateSetting({
      settingKey: "profile_viewing_mode",
      value: "private_mode"
    });

    expectPreparedAction(prepared);
    expect(prepared.preview).toMatchObject({
      summary: expect.any(String),
      target: {
        profile_name: "default",
        setting_key: "profile_viewing_mode"
      },
      setting: {
        key: "profile_viewing_mode",
        value: "private_mode"
      }
    });
    expect(prepared.preview).toHaveProperty("rate_limit");
  });

  it("prepareUpdateSetting for connections_visibility returns valid prepared action", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const prepared = runtime.privacySettings.prepareUpdateSetting({
      settingKey: "connections_visibility",
      value: "hidden"
    });

    expectPreparedAction(prepared);
    expect(prepared.preview).toMatchObject({
      summary: expect.any(String),
      target: {
        profile_name: "default",
        setting_key: "connections_visibility"
      },
      setting: {
        key: "connections_visibility",
        value: "hidden"
      }
    });
    expect(prepared.preview).toHaveProperty("rate_limit");
  });

  it("prepareUpdateSetting for last_name_visibility returns valid prepared action", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const prepared = runtime.privacySettings.prepareUpdateSetting({
      settingKey: "last_name_visibility",
      value: "full_last_name"
    });

    expectPreparedAction(prepared);
    expect(prepared.preview).toMatchObject({
      summary: expect.any(String),
      target: {
        profile_name: "default",
        setting_key: "last_name_visibility"
      },
      setting: {
        key: "last_name_visibility",
        value: "full_last_name"
      }
    });
    expect(prepared.preview).toHaveProperty("rate_limit");
  });

  it("prepareUpdateSetting rejects invalid setting key", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() =>
      runtime.privacySettings.prepareUpdateSetting({
        settingKey: "invalid_key",
        value: "something"
      })
    ).toThrow("settingKey must be one of");
  });

  it("prepareUpdateSetting rejects invalid value", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() =>
      runtime.privacySettings.prepareUpdateSetting({
        settingKey: "connections_visibility",
        value: "invalid_value"
      })
    ).toThrow("connections_visibility value must be one of");
  });
});

describe("Privacy Settings MCP E2E", () => {
  const e2e = setupE2ESuite();
  const profileName = getDefaultProfileName();

  it("MCP get_settings returns settings array", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.privacyGetSettings, {
      profileName
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName
    });

    const settings = result.payload.settings;
    expect(Array.isArray(settings)).toBe(true);

    const settingsArray = settings as Array<Record<string, unknown>>;
    expect(settingsArray).toHaveLength(3);

    for (const setting of settingsArray) {
      expect(typeof setting.key).toBe("string");
      expect(typeof setting.label).toBe("string");
      expect(typeof setting.description).toBe("string");
      expect(Array.isArray(setting.allowed_values)).toBe(true);
      expect(
        setting.status === "available" || setting.status === "unavailable"
      ).toBe(true);
    }
  }, 120_000);

  it("MCP get_settings returns available values for all three settings", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.privacyGetSettings, {
      profileName
    });

    expect(result.isError).toBe(false);

    const settings = result.payload.settings as Array<Record<string, unknown>>;
    for (const setting of settings) {
      expect(setting.status).toBe("available");
      expect(typeof setting.current_value).toBe("string");
      expect((setting.current_value as string).length).toBeGreaterThan(0);
      expect(typeof setting.source_url).toBe("string");
    }
  }, 120_000);

  it("MCP prepare_update_setting returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(
      MCP_TOOL_NAMES.privacyPrepareUpdateSetting,
      {
        profileName,
        settingKey: "connections_visibility",
        value: "hidden"
      }
    );

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const preview = result.payload.preview as Record<string, unknown>;
    expect(typeof preview.summary).toBe("string");
    expect(preview).toHaveProperty("target");
    expect(preview).toHaveProperty("setting");
    expect(preview).toHaveProperty("rate_limit");
  });

  it("MCP prepare_update_setting rejects invalid key", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(
      MCP_TOOL_NAMES.privacyPrepareUpdateSetting,
      {
        profileName,
        settingKey: "not_a_real_setting",
        value: "whatever"
      }
    );

    expect(result.isError).toBe(true);
  });

  it("MCP prepare_update_setting rejects invalid value", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(
      MCP_TOOL_NAMES.privacyPrepareUpdateSetting,
      {
        profileName,
        settingKey: "last_name_visibility",
        value: "not_a_valid_value"
      }
    );

    expect(result.isError).toBe(true);
  });
});
