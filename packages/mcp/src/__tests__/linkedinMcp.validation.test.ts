import { LinkedInAssistantError } from "@linkedin-assistant/core";
import { describe, expect, it } from "vitest";
import {
  LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL,
  LINKEDIN_PROFILE_PREPARE_UPSERT_SECTION_ITEM_TOOL,
  LINKEDIN_SESSION_STATUS_TOOL
} from "../index.js";
import * as toolConstants from "../index.js";
import {
  LINKEDIN_MCP_TOOL_DEFINITIONS,
  validateToolArguments,
  type LinkedInMcpInputSchema
} from "../bin/linkedin-mcp.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function synthesizeValidValue(schema: LinkedInMcpInputSchema): unknown {
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    return synthesizeValidValue(schema.anyOf[0]!);
  }

  switch (schema.type) {
    case "string":
      return "value";
    case "number":
      return 1;
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [synthesizeValidValue(schema.items ?? { type: "string" })];
    case "object": {
      const value: Record<string, unknown> = {};
      const properties = schema.properties ?? {};
      const required = schema.required ?? [];

      for (const key of required) {
        const propertySchema = properties[key];
        if (!propertySchema) {
          throw new Error(`Missing property schema for required key ${key}.`);
        }
        value[key] = synthesizeValidValue(propertySchema);
      }

      if (required.length === 0 && typeof schema.additionalProperties === "object") {
        value.sample = synthesizeValidValue(schema.additionalProperties);
      }

      return value;
    }
    default:
      return "value";
  }
}

function synthesizeValidArgs(schema: LinkedInMcpInputSchema): Record<string, unknown> {
  const value = synthesizeValidValue(schema);
  if (!isPlainObject(value)) {
    throw new Error("Expected an object-valued tool schema.");
  }

  return structuredClone(value);
}

function synthesizeTypeMismatchValue(schema: LinkedInMcpInputSchema): unknown {
  if (schema.anyOf && schema.anyOf.length > 0) {
    return [];
  }

  switch (schema.type) {
    case "string":
      return 123;
    case "number":
      return "invalid";
    case "integer":
      return "invalid";
    case "boolean":
      return "invalid";
    case "array":
      return "invalid";
    case "object":
      return "invalid";
    default:
      return 123;
  }
}

function captureValidationFailure(action: () => unknown): LinkedInAssistantError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedInAssistantError);
    const assistantError = error as LinkedInAssistantError;
    expect(assistantError.code).toBe("ACTION_PRECONDITION_FAILED");
    return assistantError;
  }

  throw new Error("Expected validation to fail.");
}

describe("MCP tool schema validation", () => {
  it("keeps the exported tool catalog in sync with the MCP definitions", () => {
    const exportedToolNames = [...Object.values(toolConstants)].sort();
    const definedToolNames = LINKEDIN_MCP_TOOL_DEFINITIONS.map((tool) => tool.name).sort();

    expect(definedToolNames).toEqual(exportedToolNames);
  });

  it("rejects unexpected top-level arguments for every tool", () => {
    for (const tool of LINKEDIN_MCP_TOOL_DEFINITIONS) {
      const assistantError = captureValidationFailure(() =>
        validateToolArguments(tool.name, {
          ...synthesizeValidArgs(tool.inputSchema),
          unexpected: true
        })
      );

      expect(assistantError.message).toBe("unexpected is not allowed.");
      expect(assistantError.details).toMatchObject({
        path: "unexpected"
      });
    }
  });

  it("rejects required-field type mismatches across the tool catalog", () => {
    for (const tool of LINKEDIN_MCP_TOOL_DEFINITIONS) {
      const requiredKey = tool.inputSchema.required?.[0];
      if (!requiredKey) {
        continue;
      }

      const propertySchema = tool.inputSchema.properties?.[requiredKey];
      if (!propertySchema) {
        throw new Error(`Missing property schema for ${tool.name}.${requiredKey}.`);
      }

      const args = synthesizeValidArgs(tool.inputSchema);
      args[requiredKey] = synthesizeTypeMismatchValue(propertySchema);

      const assistantError = captureValidationFailure(() =>
        validateToolArguments(tool.name, args)
      );

      expect(assistantError.message).toContain(requiredKey);
      expect(assistantError.details).toMatchObject({
        path: requiredKey
      });
    }
  });

  it("rejects invalid enum values wherever root properties declare enums", () => {
    for (const tool of LINKEDIN_MCP_TOOL_DEFINITIONS) {
      const enumProperty = Object.entries(tool.inputSchema.properties ?? {}).find(
        ([, schema]) => Array.isArray(schema.enum) && schema.enum.length > 0
      );
      if (!enumProperty) {
        continue;
      }

      const [propertyName] = enumProperty;
      const args = synthesizeValidArgs(tool.inputSchema);
      args[propertyName] = "__invalid_enum_value__";

      const assistantError = captureValidationFailure(() =>
        validateToolArguments(tool.name, args)
      );

      expect(assistantError.message).toContain(propertyName);
      expect(assistantError.message).toContain("must be one of");
      expect(assistantError.details).toMatchObject({
        path: propertyName
      });
    }
  });

  it("rejects mixed-type arrays for every string-array property", () => {
    for (const tool of LINKEDIN_MCP_TOOL_DEFINITIONS) {
      const arrayProperty = Object.entries(tool.inputSchema.properties ?? {}).find(
        ([, schema]) => schema.type === "array" && schema.items?.type === "string"
      );
      if (!arrayProperty) {
        continue;
      }

      const [propertyName, propertySchema] = arrayProperty;
      const args = synthesizeValidArgs(tool.inputSchema);
      args[propertyName] = [synthesizeValidValue(propertySchema.items!), 42];

      const assistantError = captureValidationFailure(() =>
        validateToolArguments(tool.name, args)
      );

      expect(assistantError.message).toBe(`${propertyName}[1] must be a string.`);
      expect(assistantError.details).toMatchObject({
        path: `${propertyName}[1]`,
        actual_type: "number"
      });
    }
  });

  it("validates nested additionalProperties schemas instead of silently dropping bad data", () => {
    const assistantError = captureValidationFailure(() =>
      validateToolArguments(LINKEDIN_PROFILE_PREPARE_UPSERT_SECTION_ITEM_TOOL, {
        section: "experience",
        values: {
          headline: ["bad"]
        }
      })
    );

    expect(assistantError.message).toBe(
      "values.headline must match one of: string, number, boolean."
    );
    expect(assistantError.details).toMatchObject({
      path: "values.headline",
      actual_type: "array"
    });
  });

  it("treats undefined optional values as absent but still rejects undefined required inputs", () => {
    expect(() =>
      validateToolArguments(LINKEDIN_SESSION_STATUS_TOOL, {
        profileName: undefined
      })
    ).not.toThrow();

    const assistantError = captureValidationFailure(() =>
      validateToolArguments(LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL, {
        query: undefined
      })
    );

    expect(assistantError.message).toBe("query is required.");
    expect(assistantError.details).toMatchObject({
      path: "query"
    });
  });
});
