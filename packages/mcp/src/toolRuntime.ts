import {
  LinkedInBuddyError,
  LINKEDIN_SELECTOR_LOCALES,
  createCoreRuntime,
} from "@linkedin-buddy/core";
import { readString, type ToolArgs } from "./toolArgs.js";
import { mcpPrivacyConfig } from "./toolResults.js";
import { type LinkedInMcpInputSchema } from "./toolSchema.js";

export type CoreRuntime = ReturnType<typeof createCoreRuntime>;

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export const cdpUrlInputSchemaProperty: LinkedInMcpInputSchema = {
  type: "string",
  description:
    "Connect to an existing browser via CDP endpoint (for example http://127.0.0.1:18800).",
};

export const selectorLocaleInputSchemaProperty: LinkedInMcpInputSchema = {
  type: "string",
  description: `Prefer localized LinkedIn UI text first (${LINKEDIN_SELECTOR_LOCALES.join(
    ", ",
  )}; region tags like da-DK normalize to da). Unsupported values fall back to en.`,
};

export function withCdpSchemaProperties(
  properties: Record<string, LinkedInMcpInputSchema>,
): Record<string, LinkedInMcpInputSchema> {
  return {
    ...properties,
    cdpUrl: cdpUrlInputSchemaProperty,
    selectorLocale: selectorLocaleInputSchemaProperty,
  };
}

export function createRuntime(args: ToolArgs): CoreRuntime {
  const cdpUrl = readString(args, "cdpUrl", "");
  const selectorLocale = readString(args, "selectorLocale", "");
  return createCoreRuntime(
    cdpUrl
      ? {
          cdpUrl,
          privacy: mcpPrivacyConfig,
          ...(selectorLocale ? { selectorLocale } : {}),
        }
      : {
          privacy: mcpPrivacyConfig,
          ...(selectorLocale ? { selectorLocale } : {}),
        },
  );
}

export async function withRuntime<T>(
  args: ToolArgs,
  fn: (runtime: CoreRuntime) => Promise<T>,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
): Promise<T> {
  const runtime = createRuntime(args);
  let runtimeClosed = false;
  const closeRuntime = (): void => {
    if (runtimeClosed) {
      return;
    }

    runtimeClosed = true;
    runtime.close();
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      closeRuntime();
      reject(
        new LinkedInBuddyError(
          "TIMEOUT",
          `Tool operation timed out after ${timeoutMs}ms. The browser session may be slow or unresponsive. Try: 1) Check linkedin.session.health, 2) Reduce the operation scope (lower limit), 3) Retry the operation.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(runtime), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    closeRuntime();
  }
}
