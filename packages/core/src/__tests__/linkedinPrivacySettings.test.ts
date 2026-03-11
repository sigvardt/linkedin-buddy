import { describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_PRIVACY_SETTING_KEYS,
  LinkedInPrivacySettingsService,
  UPDATE_PRIVACY_SETTING_ACTION_TYPE,
  createPrivacySettingActionExecutors,
  getLinkedInPrivacySettingDefinitions,
  normalizeLinkedInPrivacySettingKey,
  normalizeLinkedInPrivacySettingValue
} from "../linkedinPrivacySettings.js";
import { createAllowedRateLimiterStub } from "./rateLimiterTestUtils.js";

describe("LinkedIn privacy setting constants", () => {
  it("exposes the supported setting keys", () => {
    expect(LINKEDIN_PRIVACY_SETTING_KEYS).toEqual([
      "profile_viewing_mode",
      "connections_visibility",
      "last_name_visibility"
    ]);
  });

  it("returns stable setting definitions", () => {
    expect(getLinkedInPrivacySettingDefinitions()).toEqual([
      expect.objectContaining({
        key: "profile_viewing_mode",
        allowed_values: [
          "full_profile",
          "private_profile_characteristics",
          "private_mode"
        ]
      }),
      expect.objectContaining({
        key: "connections_visibility",
        allowed_values: ["visible", "hidden"]
      }),
      expect.objectContaining({
        key: "last_name_visibility",
        allowed_values: ["full_last_name", "last_initial"]
      })
    ]);
  });
});

describe("privacy setting normalization", () => {
  it("normalizes supported setting keys and values", () => {
    const settingKey = normalizeLinkedInPrivacySettingKey(
      "profile_viewing_mode"
    );

    expect(settingKey).toBe("profile_viewing_mode");
    expect(
      normalizeLinkedInPrivacySettingValue(settingKey, "private_mode")
    ).toBe("private_mode");
  });

  it("rejects unsupported keys and values", () => {
    expect(() => normalizeLinkedInPrivacySettingKey("unknown")).toThrow(
      "settingKey must be one of"
    );
    expect(() =>
      normalizeLinkedInPrivacySettingValue(
        "connections_visibility",
        "maybe"
      )
    ).toThrow("connections_visibility value must be one of");
  });
});

describe("createPrivacySettingActionExecutors", () => {
  it("registers the update executor", () => {
    const executors = createPrivacySettingActionExecutors();

    expect(Object.keys(executors)).toEqual([
      UPDATE_PRIVACY_SETTING_ACTION_TYPE
    ]);
    expect(executors[UPDATE_PRIVACY_SETTING_ACTION_TYPE]).toBeDefined();
  });
});

describe("LinkedInPrivacySettingsService prepare flow", () => {
  it("prepares supported setting updates with structured previews", () => {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const rateLimiter = createAllowedRateLimiterStub();
    const service = new LinkedInPrivacySettingsService({
      rateLimiter,
      twoPhaseCommit: { prepare }
    } as unknown as ConstructorParameters<typeof LinkedInPrivacySettingsService>[0]);

    const prepared = service.prepareUpdateSetting({
      settingKey: "connections_visibility",
      value: "hidden"
    });

    expect(prepared.preview).toMatchObject({
      summary:
        "Update LinkedIn privacy setting connections_visibility to hidden",
      setting: {
        key: "connections_visibility",
        value: "hidden"
      },
      target: {
        profile_name: "default",
        setting_key: "connections_visibility"
      },
      rate_limit: {
        counter_key: "linkedin.privacy.update_setting"
      }
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: UPDATE_PRIVACY_SETTING_ACTION_TYPE,
        payload: {
          setting_key: "connections_visibility",
          value: "hidden"
        }
      })
    );
  });
});
