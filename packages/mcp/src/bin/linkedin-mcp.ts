#!/usr/bin/env node
import { createCoreRuntime } from "@linkedin-assistant/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import {
  LINKEDIN_OPEN_LOGIN_TOOL,
  LINKEDIN_STATUS_TOOL
} from "../index.js";

type ToolArgs = Record<string, unknown>;

function readString(
  args: ToolArgs,
  key: string,
  fallback: string
): string {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readPositiveNumber(
  args: ToolArgs,
  key: string,
  fallback: number
): number {
  const value = args[key];
  if (typeof value !== "number") {
    return fallback;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number.`);
  }

  return value;
}

function toToolResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function toErrorResult(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message
      }
    ]
  };
}

async function handleStatus(args: ToolArgs): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    runtime.logger.log("info", "mcp.status.start", { profileName });

    const status = await runtime.auth.status({ profileName });

    runtime.logger.log("info", "mcp.status.done", {
      profileName,
      authenticated: status.authenticated
    });

    return toToolResult({ run_id: runtime.runId, ...status });
  } finally {
    runtime.close();
  }
}

async function handleOpenLogin(
  args: ToolArgs
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const timeoutMs = readPositiveNumber(args, "timeoutMs", 10 * 60_000);

    runtime.logger.log("info", "mcp.open_login.start", {
      profileName,
      timeoutMs
    });

    const status = await runtime.auth.openLogin({
      profileName,
      timeoutMs
    });

    runtime.logger.log("info", "mcp.open_login.done", {
      profileName,
      authenticated: status.authenticated,
      timedOut: status.timedOut
    });

    return toToolResult({ run_id: runtime.runId, ...status });
  } finally {
    runtime.close();
  }
}

const server = new Server(
  {
    name: "linkedin-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: LINKEDIN_STATUS_TOOL,
        description: "Checks whether the profile has an authenticated LinkedIn session.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            }
          }
        }
      },
      {
        name: LINKEDIN_OPEN_LOGIN_TOOL,
        description:
          "Opens LinkedIn login using a persistent profile and waits for authentication.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            timeoutMs: {
              type: "number",
              description: "How long to wait before timing out login check."
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as ToolArgs;

    try {
      if (name === LINKEDIN_STATUS_TOOL) {
        return await handleStatus(args);
      }

      if (name === LINKEDIN_OPEN_LOGIN_TOOL) {
        return await handleOpenLogin(args);
      }

      return toErrorResult(`Unknown tool: ${name}`);
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
