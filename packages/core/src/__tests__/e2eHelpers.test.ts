import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callMcpToolWith,
  getLastJsonObject,
  mapMcpToolResult,
  runCliCommandWith
} from "./e2e/helpers.js";

const tempDirs: string[] = [];

function createTempAssistantHome(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-e2e-helper-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("E2E helper command wrappers", () => {
  it("retries transient CLI failures and returns the final attempt output", async () => {
    const runner = vi.fn(async () => {
      if (runner.mock.calls.length === 1) {
        throw new Error("Target closed while attaching to the browser");
      }

      process.stdout.write('{"ok":true}\n');
    });

    const result = await runCliCommandWith(runner, ["status"], {
      assistantHome: createTempAssistantHome(),
      maxAttempts: 2,
      retryDelayMs: 0
    });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(getLastJsonObject(result.stdout)).toEqual({ ok: true });
  });

  it("surfaces CLI timeouts as structured error output", async () => {
    const runner = vi.fn(async () => {
      await new Promise<void>(() => undefined);
    });

    const result = await runCliCommandWith(runner, ["status"], {
      assistantHome: createTempAssistantHome(),
      timeoutMs: 1
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
    expect(getLastJsonObject(result.stderr)).toMatchObject({
      message: expect.stringContaining("timed out after 1ms")
    });
  });
});

describe("E2E helper MCP wrappers", () => {
  it("uses the last text content item when mapping MCP tool results", () => {
    const result = mapMcpToolResult("linkedin.test", {
      isError: true,
      content: [
        {
          type: "text",
          text: "warmup log"
        },
        {
          type: "resource",
          uri: "memory://example"
        },
        {
          type: "text",
          text: 'log prefix\n{"ok":true}'
        }
      ]
    });

    expect(result).toEqual({
      payload: { ok: true },
      isError: true
    });
  });

  it("retries transient MCP failures before returning a payload", async () => {
    const caller = vi.fn(async () => {
      if (caller.mock.calls.length === 1) {
        throw new Error("Browser has been closed unexpectedly");
      }

      return {
        content: [
          {
            type: "text",
            text: '{"ok":true}'
          }
        ]
      };
    });

    const result = await callMcpToolWith(
      caller,
      "linkedin.test",
      {
        sample: true
      },
      {
        assistantHome: createTempAssistantHome(),
        maxAttempts: 2,
        retryDelayMs: 0
      }
    );

    expect(caller).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      payload: { ok: true },
      isError: false
    });
  });

  it("throws a clear error when MCP output contains no JSON object", () => {
    expect(() =>
      mapMcpToolResult("linkedin.test", {
        content: [
          {
            type: "text",
            text: "plain text only"
          }
        ]
      })
    ).toThrow("Tool linkedin.test payload did not contain a JSON object");
  });
});
