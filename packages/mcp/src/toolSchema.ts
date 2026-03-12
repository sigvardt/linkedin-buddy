import { LinkedInBuddyError } from "@linkedin-buddy/core";

export type LinkedInMcpSchemaPrimitiveType =
  | "array"
  | "boolean"
  | "integer"
  | "number"
  | "object"
  | "string";

export type LinkedInMcpSchemaEnumValue = boolean | number | string;

export interface LinkedInMcpInputSchema {
  type?: LinkedInMcpSchemaPrimitiveType;
  description?: string;
  properties?: Record<string, LinkedInMcpInputSchema>;
  required?: string[];
  additionalProperties?: boolean | LinkedInMcpInputSchema;
  items?: LinkedInMcpInputSchema;
  enum?: readonly LinkedInMcpSchemaEnumValue[];
  anyOf?: readonly LinkedInMcpInputSchema[];
}

export interface LinkedInMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: LinkedInMcpInputSchema;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeToolArgValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return "non-finite number";
  }

  return typeof value;
}

export function appendToolSchemaPath(path: string, segment: string): string {
  if (path.length === 0) {
    return segment;
  }

  if (segment.startsWith("[")) {
    return `${path}${segment}`;
  }

  return `${path}.${segment}`;
}

export function formatToolSchemaPath(path: string): string {
  return path.length > 0 ? path : "arguments";
}

export function describeToolSchemaTypes(
  schema: LinkedInMcpInputSchema,
): string {
  if (schema.anyOf && schema.anyOf.length > 0) {
    return schema.anyOf
      .map((entry) => describeToolSchemaTypes(entry))
      .join(", ");
  }

  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((entry) => JSON.stringify(entry)).join(", ");
  }

  if (schema.type) {
    return schema.type;
  }

  return "supported value";
}

export function throwToolSchemaValidationError(
  path: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${formatToolSchemaPath(path)} ${message}`,
    {
      path: formatToolSchemaPath(path),
      ...details,
    },
  );
}

export function validateToolArgEnum(
  schema: LinkedInMcpInputSchema,
  value: unknown,
  path: string,
): void {
  if (
    schema.enum &&
    !schema.enum.includes(value as LinkedInMcpSchemaEnumValue)
  ) {
    throwToolSchemaValidationError(
      path,
      `must be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}.`,
      {
        actual_type: describeToolArgValue(value),
        allowed_values: [...schema.enum],
      },
    );
  }
}

export function validateToolArgValueAgainstSchema(
  schema: LinkedInMcpInputSchema,
  value: unknown,
  path: string,
): void {
  if (schema.anyOf && schema.anyOf.length > 0) {
    for (const candidate of schema.anyOf) {
      try {
        validateToolArgValueAgainstSchema(candidate, value, path);
        return;
      } catch (error) {
        if (!(error instanceof LinkedInBuddyError)) {
          throw error;
        }
      }
    }

    throwToolSchemaValidationError(
      path,
      `must match one of: ${describeToolSchemaTypes(schema)}.`,
      {
        actual_type: describeToolArgValue(value),
        expected: describeToolSchemaTypes(schema),
      },
    );
  }

  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        throwToolSchemaValidationError(path, "must be a string.", {
          actual_type: describeToolArgValue(value),
        });
      }
      validateToolArgEnum(schema, value, path);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throwToolSchemaValidationError(path, "must be a finite number.", {
          actual_type: describeToolArgValue(value),
        });
      }
      validateToolArgEnum(schema, value, path);
      return;
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value)
      ) {
        throwToolSchemaValidationError(path, "must be an integer.", {
          actual_type: describeToolArgValue(value),
        });
      }
      validateToolArgEnum(schema, value, path);
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        throwToolSchemaValidationError(path, "must be a boolean.", {
          actual_type: describeToolArgValue(value),
        });
      }
      validateToolArgEnum(schema, value, path);
      return;
    case "array":
      if (!Array.isArray(value)) {
        throwToolSchemaValidationError(path, "must be an array.", {
          actual_type: describeToolArgValue(value),
        });
      }

      if (schema.items) {
        value.forEach((entry, index) => {
          validateToolArgValueAgainstSchema(
            schema.items!,
            entry,
            appendToolSchemaPath(path, `[${index}]`),
          );
        });
      }
      return;
    case "object": {
      if (!isPlainObject(value)) {
        throwToolSchemaValidationError(path, "must be an object.", {
          actual_type: describeToolArgValue(value),
        });
      }

      const properties = schema.properties ?? {};
      const required = schema.required ?? [];
      for (const requiredKey of required) {
        if (!(requiredKey in value) || value[requiredKey] === undefined) {
          throwToolSchemaValidationError(
            appendToolSchemaPath(path, requiredKey),
            "is required.",
          );
        }
      }

      for (const [key, entryValue] of Object.entries(value)) {
        const propertyPath = appendToolSchemaPath(path, key);
        const propertySchema = properties[key];

        if (propertySchema) {
          if (entryValue !== undefined) {
            validateToolArgValueAgainstSchema(
              propertySchema,
              entryValue,
              propertyPath,
            );
          }
          continue;
        }

        if (schema.additionalProperties === false) {
          throwToolSchemaValidationError(propertyPath, "is not allowed.");
        }

        if (
          schema.additionalProperties &&
          typeof schema.additionalProperties === "object"
        ) {
          validateToolArgValueAgainstSchema(
            schema.additionalProperties,
            entryValue,
            propertyPath,
          );
        }
      }
      return;
    }
    default:
      validateToolArgEnum(schema, value, path);
      return;
  }
}
