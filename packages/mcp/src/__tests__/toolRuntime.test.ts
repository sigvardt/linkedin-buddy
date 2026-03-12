import { LinkedInBuddyError } from "@linkedin-buddy/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toolRuntimeCoreMocks = vi.hoisted(() => ({
  createCoreRuntime: vi.fn(),
}));

vi.mock("@linkedin-buddy/core", async () => {
  const actual = await vi.importActual<typeof import("@linkedin-buddy/core")>(
    "@linkedin-buddy/core",
  );

  return {
    ...actual,
    createCoreRuntime: toolRuntimeCoreMocks.createCoreRuntime,
  };
});

import { mcpPrivacyConfig } from "../toolResults.js";
import {
  cdpUrlInputSchemaProperty,
  createRuntime,
  selectorLocaleInputSchemaProperty,
  withCdpSchemaProperties,
  withRuntime,
} from "../toolRuntime.js";
import type { ToolArgs } from "../toolArgs.js";

describe("toolRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createRuntime", () => {
    it("passes cdpUrl and selectorLocale when provided", () => {
      const close = vi.fn();
      toolRuntimeCoreMocks.createCoreRuntime.mockReturnValue({ close });

      createRuntime({
        cdpUrl: "  http://127.0.0.1:18800  ",
        selectorLocale: "  da-DK  ",
      });

      expect(toolRuntimeCoreMocks.createCoreRuntime).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18800",
        privacy: mcpPrivacyConfig,
        selectorLocale: "da-DK",
      });
    });

    it("omits cdpUrl when missing or blank", () => {
      const close = vi.fn();
      toolRuntimeCoreMocks.createCoreRuntime.mockReturnValue({ close });

      createRuntime({ cdpUrl: "   " });

      expect(toolRuntimeCoreMocks.createCoreRuntime).toHaveBeenCalledWith({
        privacy: mcpPrivacyConfig,
      });
    });
  });

  describe("withCdpSchemaProperties", () => {
    it("merges cdpUrl and selectorLocale into schema properties", () => {
      const properties = {
        profileName: { type: "string" as const },
      };

      const merged = withCdpSchemaProperties(properties);

      expect(merged).toEqual({
        profileName: { type: "string" },
        cdpUrl: cdpUrlInputSchemaProperty,
        selectorLocale: selectorLocaleInputSchemaProperty,
      });
    });
  });

  describe("withRuntime", () => {
    it("returns function result when fn resolves before timeout", async () => {
      const close = vi.fn();
      toolRuntimeCoreMocks.createCoreRuntime.mockReturnValue({ close });

      const result = await withRuntime({}, async () => "ok", 100);

      expect(result).toBe("ok");
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("rejects with TIMEOUT when fn runs too long", async () => {
      const close = vi.fn();
      toolRuntimeCoreMocks.createCoreRuntime.mockReturnValue({ close });

      const run = withRuntime(
        {},
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return "done";
        },
        10,
      );

      await expect(run).rejects.toMatchObject({ code: "TIMEOUT" });
      await expect(run).rejects.toBeInstanceOf(LinkedInBuddyError);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("propagates fn rejection and still closes runtime", async () => {
      const close = vi.fn();
      toolRuntimeCoreMocks.createCoreRuntime.mockReturnValue({ close });
      const failure = new LinkedInBuddyError(
        "AUTH_REQUIRED",
        "authenticate first",
      );

      const args: ToolArgs = {};
      await expect(
        withRuntime(
          args,
          async () => {
            throw failure;
          },
          100,
        ),
      ).rejects.toBe(failure);

      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
