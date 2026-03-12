import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LinkedInBuddyError } from "@linkedin-buddy/core";
import { describe, expect, it } from "vitest";
import {
  coerceEnumValue,
  readBoolean,
  readJsonInputFile,
  readNonNegativeNumber,
  readObject,
  readOptionalNonNegativeNumber,
  readOptionalPositiveNumber,
  readPositiveNumber,
  readRequiredBoolean,
  readRequiredString,
  readRequiredStringArray,
  readString,
  readStringArray,
  trimOrUndefined,
  type ToolArgs,
} from "../toolArgs.js";

function captureLinkedInBuddyError(action: () => unknown): LinkedInBuddyError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedInBuddyError);
    const linkedInError = error as LinkedInBuddyError;
    expect(linkedInError.code).toBe("ACTION_PRECONDITION_FAILED");
    return linkedInError;
  }

  throw new Error("Expected action to throw LinkedInBuddyError.");
}

async function captureLinkedInBuddyErrorAsync(
  action: () => Promise<unknown>,
): Promise<LinkedInBuddyError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedInBuddyError);
    const linkedInError = error as LinkedInBuddyError;
    expect(linkedInError.code).toBe("ACTION_PRECONDITION_FAILED");
    return linkedInError;
  }

  throw new Error("Expected action to throw LinkedInBuddyError.");
}

describe("toolArgs", () => {
  describe("readString", () => {
    it("returns a trimmed string value", () => {
      const args: ToolArgs = { key: "  value  " };
      expect(readString(args, "key", "fallback")).toBe("value");
    });

    it("returns fallback for non-string input", () => {
      const args: ToolArgs = { key: 123 };
      expect(readString(args, "key", "fallback")).toBe("fallback");
    });

    it("returns fallback for empty string input", () => {
      const args: ToolArgs = { key: "   " };
      expect(readString(args, "key", "fallback")).toBe("fallback");
    });
  });

  describe("readRequiredString", () => {
    it("returns a trimmed string value", () => {
      const args: ToolArgs = { profileName: "  default  " };
      expect(readRequiredString(args, "profileName")).toBe("default");
    });

    it("throws when the value is missing or empty", () => {
      const missingArgs: ToolArgs = {};
      const missingError = captureLinkedInBuddyError(() =>
        readRequiredString(missingArgs, "profileName"),
      );
      expect(missingError.message).toBe("profileName is required.");

      const emptyArgs: ToolArgs = { profileName: "   " };
      const emptyError = captureLinkedInBuddyError(() =>
        readRequiredString(emptyArgs, "profileName"),
      );
      expect(emptyError.message).toBe("profileName is required.");
    });
  });

  describe("readPositiveNumber", () => {
    it("returns a valid positive number", () => {
      const args: ToolArgs = { limit: 5 };
      expect(readPositiveNumber(args, "limit", 10)).toBe(5);
    });

    it("returns fallback for non-number input", () => {
      const args: ToolArgs = { limit: "5" };
      expect(readPositiveNumber(args, "limit", 10)).toBe(10);
    });

    it("throws for numbers less than or equal to zero", () => {
      const zeroArgs: ToolArgs = { limit: 0 };
      const zeroError = captureLinkedInBuddyError(() =>
        readPositiveNumber(zeroArgs, "limit", 10),
      );
      expect(zeroError.message).toBe("limit must be a positive number.");

      const negativeArgs: ToolArgs = { limit: -1 };
      const negativeError = captureLinkedInBuddyError(() =>
        readPositiveNumber(negativeArgs, "limit", 10),
      );
      expect(negativeError.message).toBe("limit must be a positive number.");
    });

    it("throws for non-finite numbers", () => {
      const args: ToolArgs = { limit: Number.POSITIVE_INFINITY };
      const error = captureLinkedInBuddyError(() =>
        readPositiveNumber(args, "limit", 10),
      );
      expect(error.message).toBe("limit must be a positive number.");
    });
  });

  describe("readNonNegativeNumber", () => {
    it("returns zero", () => {
      const args: ToolArgs = { offset: 0 };
      expect(readNonNegativeNumber(args, "offset", 10)).toBe(0);
    });

    it("returns a positive number", () => {
      const args: ToolArgs = { offset: 3 };
      expect(readNonNegativeNumber(args, "offset", 10)).toBe(3);
    });

    it("throws for negative numbers", () => {
      const args: ToolArgs = { offset: -1 };
      const error = captureLinkedInBuddyError(() =>
        readNonNegativeNumber(args, "offset", 10),
      );
      expect(error.message).toBe("offset must be zero or a positive number.");
    });

    it("throws for non-finite numbers", () => {
      const args: ToolArgs = { offset: Number.NaN };
      const error = captureLinkedInBuddyError(() =>
        readNonNegativeNumber(args, "offset", 10),
      );
      expect(error.message).toBe("offset must be zero or a positive number.");
    });
  });

  describe("readBoolean", () => {
    it("returns a boolean value", () => {
      const args: ToolArgs = { enabled: false };
      expect(readBoolean(args, "enabled", true)).toBe(false);
    });

    it("returns fallback for non-boolean input", () => {
      const args: ToolArgs = { enabled: "false" };
      expect(readBoolean(args, "enabled", true)).toBe(true);
    });
  });

  describe("readRequiredBoolean", () => {
    it("returns a required boolean value", () => {
      const args: ToolArgs = { enabled: true };
      expect(readRequiredBoolean(args, "enabled")).toBe(true);
    });

    it("throws for non-boolean input", () => {
      const args: ToolArgs = { enabled: "true" };
      const error = captureLinkedInBuddyError(() =>
        readRequiredBoolean(args, "enabled"),
      );
      expect(error.message).toBe("enabled is required.");
    });
  });

  describe("readOptionalPositiveNumber", () => {
    it("returns undefined for an absent key", () => {
      const args: ToolArgs = {};
      expect(readOptionalPositiveNumber(args, "limit")).toBeUndefined();
    });

    it("returns a number for a present key", () => {
      const args: ToolArgs = { limit: 2 };
      expect(readOptionalPositiveNumber(args, "limit")).toBe(2);
    });
  });

  describe("readOptionalNonNegativeNumber", () => {
    it("returns undefined for an absent key", () => {
      const args: ToolArgs = {};
      expect(readOptionalNonNegativeNumber(args, "offset")).toBeUndefined();
    });

    it("returns number for a present key", () => {
      const args: ToolArgs = { offset: 12 };
      expect(readOptionalNonNegativeNumber(args, "offset")).toBe(12);
    });

    it("throws for a non-integer value", () => {
      const args: ToolArgs = { offset: 1.5 };
      const error = captureLinkedInBuddyError(() =>
        readOptionalNonNegativeNumber(args, "offset"),
      );
      expect(error.message).toBe("offset must be a non-negative integer.");
    });

    it("throws for a negative value", () => {
      const args: ToolArgs = { offset: -1 };
      const error = captureLinkedInBuddyError(() =>
        readOptionalNonNegativeNumber(args, "offset"),
      );
      expect(error.message).toBe("offset must be a non-negative integer.");
    });
  });

  describe("readStringArray", () => {
    it("handles string input", () => {
      const args: ToolArgs = { tags: "  one  " };
      expect(readStringArray(args, "tags")).toEqual(["one"]);
    });

    it("handles array input", () => {
      const args: ToolArgs = { tags: [" one ", "two"] };
      expect(readStringArray(args, "tags")).toEqual(["one", "two"]);
    });

    it("filters empty and non-string items", () => {
      const args: ToolArgs = { tags: [" one ", "  ", 2, "two", ""] };
      expect(readStringArray(args, "tags")).toEqual(["one", "two"]);
    });

    it("throws for invalid value types", () => {
      const args: ToolArgs = { tags: 42 };
      const error = captureLinkedInBuddyError(() =>
        readStringArray(args, "tags"),
      );
      expect(error.message).toBe("tags must be a string or array of strings.");
    });
  });

  describe("readRequiredStringArray", () => {
    it("returns values when non-empty", () => {
      const args: ToolArgs = { tags: ["alpha", "beta"] };
      expect(readRequiredStringArray(args, "tags")).toEqual(["alpha", "beta"]);
    });

    it("throws for missing or empty values", () => {
      const missingArgs: ToolArgs = {};
      const missingError = captureLinkedInBuddyError(() =>
        readRequiredStringArray(missingArgs, "tags"),
      );
      expect(missingError.message).toBe("tags is required.");

      const emptyArgs: ToolArgs = { tags: ["   ", ""] };
      const emptyError = captureLinkedInBuddyError(() =>
        readRequiredStringArray(emptyArgs, "tags"),
      );
      expect(emptyError.message).toBe("tags is required.");
    });
  });

  describe("readObject", () => {
    it("returns a valid object", () => {
      const args: ToolArgs = { values: { key: "value" } };
      expect(readObject(args, "values")).toEqual({ key: "value" });
    });

    it("returns undefined when value is absent", () => {
      const args: ToolArgs = {};
      expect(readObject(args, "values")).toBeUndefined();
    });

    it("throws for array values", () => {
      const args: ToolArgs = { values: ["value"] };
      const error = captureLinkedInBuddyError(() => readObject(args, "values"));
      expect(error.message).toBe("values must be an object.");
    });

    it("throws for primitive values", () => {
      const args: ToolArgs = { values: 5 };
      const error = captureLinkedInBuddyError(() => readObject(args, "values"));
      expect(error.message).toBe("values must be an object.");
    });
  });

  describe("trimOrUndefined", () => {
    it("returns trimmed strings", () => {
      expect(trimOrUndefined("  value  ")).toBe("value");
    });

    it("returns undefined for empty or non-string values", () => {
      expect(trimOrUndefined("   ")).toBeUndefined();
      expect(trimOrUndefined(undefined)).toBeUndefined();
    });
  });

  describe("coerceEnumValue", () => {
    it("returns valid enum values", () => {
      expect(
        coerceEnumValue("active", ["active", "inactive"] as const, "status"),
      ).toBe("active");
    });

    it("throws with a helpful message for invalid values", () => {
      const error = captureLinkedInBuddyError(() =>
        coerceEnumValue("archived", ["active", "inactive"] as const, "status"),
      );
      expect(error.message).toBe("status must be one of: active, inactive.");
    });
  });

  describe("readJsonInputFile", () => {
    it("reads valid JSON files", async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "tool-args-test-"));
      const jsonPath = path.join(tempDir, "input.json");

      try {
        await writeFile(jsonPath, '{"ok":true,"count":2}', "utf8");

        await expect(
          readJsonInputFile(jsonPath, "input file"),
        ).resolves.toEqual({
          ok: true,
          count: 2,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("throws when the file is missing", async () => {
      const missingPath = path.join(os.tmpdir(), "missing-tool-args.json");
      const error = await captureLinkedInBuddyErrorAsync(() =>
        readJsonInputFile(missingPath, "input file"),
      );

      expect(error.message).toBe("Could not read input file.");
      expect(error.details).toMatchObject({
        path: path.resolve(missingPath),
      });
      expect(error.details).toHaveProperty("cause");
    });

    it("throws when the file does not contain valid JSON", async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "tool-args-test-"));
      const jsonPath = path.join(tempDir, "input.json");

      try {
        await writeFile(jsonPath, "{invalid-json}", "utf8");

        const error = await captureLinkedInBuddyErrorAsync(() =>
          readJsonInputFile(jsonPath, "input file"),
        );
        expect(error.message).toBe("input file must contain valid JSON.");
        expect(error.details).toMatchObject({
          path: path.resolve(jsonPath),
        });
        expect(error.details).toHaveProperty("cause");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
