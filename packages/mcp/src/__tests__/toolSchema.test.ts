import { LinkedInBuddyError } from "@linkedin-buddy/core";
import { describe, expect, it } from "vitest";
import {
  appendToolSchemaPath,
  describeToolArgValue,
  describeToolSchemaTypes,
  formatToolSchemaPath,
  isPlainObject,
  throwToolSchemaValidationError,
  validateToolArgEnum,
  validateToolArgValueAgainstSchema,
  type LinkedInMcpInputSchema,
} from "../toolSchema.js";

function captureValidationError(action: () => unknown): LinkedInBuddyError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedInBuddyError);
    const linkedInError = error as LinkedInBuddyError;
    expect(linkedInError.code).toBe("ACTION_PRECONDITION_FAILED");
    return linkedInError;
  }

  throw new Error("Expected LinkedInBuddyError to be thrown.");
}

describe("toolSchema", () => {
  describe("isPlainObject", () => {
    it("returns true only for plain objects", () => {
      expect(isPlainObject({ key: "value" })).toBe(true);
      expect(isPlainObject(Object.create(null) as Record<string, unknown>)).toBe(
        true,
      );
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject("text")).toBe(false);
      expect(isPlainObject(10)).toBe(false);
      expect(isPlainObject(false)).toBe(false);
    });
  });

  describe("describeToolArgValue", () => {
    it("describes arrays, null, non-finite numbers, and primitive types", () => {
      expect(describeToolArgValue([1, 2])).toBe("array");
      expect(describeToolArgValue(null)).toBe("null");
      expect(describeToolArgValue(Number.NaN)).toBe("non-finite number");
      expect(describeToolArgValue(Number.POSITIVE_INFINITY)).toBe(
        "non-finite number",
      );
      expect(describeToolArgValue("hello")).toBe("string");
      expect(describeToolArgValue(42)).toBe("number");
      expect(describeToolArgValue(true)).toBe("boolean");
      expect(describeToolArgValue({})).toBe("object");
      expect(describeToolArgValue(undefined)).toBe("undefined");
      expect(describeToolArgValue(() => "x")).toBe("function");
    });
  });

  describe("appendToolSchemaPath", () => {
    it("appends to an empty path", () => {
      expect(appendToolSchemaPath("", "profile")).toBe("profile");
    });

    it("appends dot segments to an existing path", () => {
      expect(appendToolSchemaPath("profile", "name")).toBe("profile.name");
    });

    it("appends bracket segments without a dot", () => {
      expect(appendToolSchemaPath("items", "[2]")).toBe("items[2]");
    });
  });

  describe("formatToolSchemaPath", () => {
    it("formats empty path as arguments", () => {
      expect(formatToolSchemaPath("")).toBe("arguments");
    });

    it("returns non-empty path unchanged", () => {
      expect(formatToolSchemaPath("payload.name")).toBe("payload.name");
    });
  });

  describe("describeToolSchemaTypes", () => {
    it("describes anyOf schemas", () => {
      expect(
        describeToolSchemaTypes({ anyOf: [{ type: "string" }, { type: "number" }] }),
      ).toBe("string, number");
    });

    it("describes enum schemas", () => {
      expect(describeToolSchemaTypes({ enum: ["a", 2, true] })).toBe(
        '"a", 2, true',
      );
    });

    it("describes type schemas", () => {
      expect(describeToolSchemaTypes({ type: "boolean" })).toBe("boolean");
    });

    it("falls back to supported value when type info is absent", () => {
      expect(describeToolSchemaTypes({})).toBe("supported value");
    });
  });

  describe("throwToolSchemaValidationError", () => {
    it("throws LinkedInBuddyError with formatted path and details", () => {
      const error = captureValidationError(() =>
        throwToolSchemaValidationError("", "must be valid.", { reason: "x" }),
      );

      expect(error.message).toBe("arguments must be valid.");
      expect(error.details).toMatchObject({
        path: "arguments",
        reason: "x",
      });
    });
  });

  describe("validateToolArgEnum", () => {
    it("accepts values present in enum", () => {
      expect(() =>
        validateToolArgEnum({ enum: ["a", "b"] }, "a", "status"),
      ).not.toThrow();
    });

    it("throws when value is not in enum", () => {
      const error = captureValidationError(() =>
        validateToolArgEnum({ enum: ["a", "b"] }, "c", "status"),
      );

      expect(error.message).toBe('status must be one of: "a", "b".');
      expect(error.details).toMatchObject({
        path: "status",
        actual_type: "string",
        allowed_values: ["a", "b"],
      });
    });

    it("does nothing when enum is absent", () => {
      expect(() => validateToolArgEnum({}, "anything", "status")).not.toThrow();
    });
  });

  describe("validateToolArgValueAgainstSchema", () => {
    it("validates string branch", () => {
      expect(() =>
        validateToolArgValueAgainstSchema({ type: "string" }, "ok", "name"),
      ).not.toThrow();

      const error = captureValidationError(() =>
        validateToolArgValueAgainstSchema({ type: "string" }, 5, "name"),
      );
      expect(error.message).toBe("name must be a string.");
    });

    it("validates number branch", () => {
      expect(() =>
        validateToolArgValueAgainstSchema({ type: "number" }, 2.5, "score"),
      ).not.toThrow();

      const error = captureValidationError(() =>
        validateToolArgValueAgainstSchema(
          { type: "number" },
          Number.POSITIVE_INFINITY,
          "score",
        ),
      );
      expect(error.message).toBe("score must be a finite number.");
    });

    it("validates integer branch", () => {
      expect(() =>
        validateToolArgValueAgainstSchema({ type: "integer" }, 3, "count"),
      ).not.toThrow();

      const error = captureValidationError(() =>
        validateToolArgValueAgainstSchema({ type: "integer" }, 3.2, "count"),
      );
      expect(error.message).toBe("count must be an integer.");
    });

    it("validates boolean branch", () => {
      expect(() =>
        validateToolArgValueAgainstSchema({ type: "boolean" }, false, "enabled"),
      ).not.toThrow();

      const error = captureValidationError(() =>
        validateToolArgValueAgainstSchema({ type: "boolean" }, "false", "enabled"),
      );
      expect(error.message).toBe("enabled must be a boolean.");
    });

    it("validates array branch with item schema", () => {
      const schema: LinkedInMcpInputSchema = {
        type: "array",
        items: { type: "integer" },
      };

      expect(() =>
        validateToolArgValueAgainstSchema(schema, [1, 2], "values"),
      ).not.toThrow();

      const error = captureValidationError(() =>
        validateToolArgValueAgainstSchema(schema, [1, "x"], "values"),
      );
      expect(error.message).toBe("values[1] must be an integer.");
    });

    it("validates object properties, required fields, and additionalProperties false", () => {
      const schema: LinkedInMcpInputSchema = {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      };

      expect(() =>
        validateToolArgValueAgainstSchema(schema, { name: "Ada" }, "payload"),
      ).not.toThrow();

      const missingRequired = captureValidationError(() =>
        validateToolArgValueAgainstSchema(schema, {}, "payload"),
      );
      expect(missingRequired.message).toBe("payload.name is required.");

      const unknownKey = captureValidationError(() =>
        validateToolArgValueAgainstSchema(
          schema,
          { name: "Ada", extra: true },
          "payload",
        ),
      );
      expect(unknownKey.message).toBe("payload.extra is not allowed.");
    });

    it("validates additionalProperties schema objects", () => {
      const schema: LinkedInMcpInputSchema = {
        type: "object",
        additionalProperties: { type: "number" },
      };

      expect(() =>
        validateToolArgValueAgainstSchema(schema, { a: 1, b: 2 }, "payload"),
      ).not.toThrow();

      const error = captureValidationError(() =>
        validateToolArgValueAgainstSchema(schema, { a: "bad" }, "payload"),
      );
      expect(error.message).toBe("payload.a must be a finite number.");
    });

    it("validates anyOf schemas", () => {
      const schema: LinkedInMcpInputSchema = {
        anyOf: [{ type: "string" }, { type: "number" }],
      };

      expect(() =>
        validateToolArgValueAgainstSchema(schema, "ok", "value"),
      ).not.toThrow();
      expect(() =>
        validateToolArgValueAgainstSchema(schema, 10, "value"),
      ).not.toThrow();

      const error = captureValidationError(() =>
        validateToolArgValueAgainstSchema(schema, false, "value"),
      );
      expect(error.message).toBe("value must match one of: string, number.");
      expect(error.details).toMatchObject({
        path: "value",
        actual_type: "boolean",
        expected: "string, number",
      });
    });

    it("uses default branch enum validation when type is omitted", () => {
      expect(() =>
        validateToolArgValueAgainstSchema({ enum: ["x", "y"] }, "x", "mode"),
      ).not.toThrow();

      const error = captureValidationError(() =>
        validateToolArgValueAgainstSchema({ enum: ["x", "y"] }, "z", "mode"),
      );
      expect(error.message).toBe('mode must be one of: "x", "y".');
    });
  });
});
