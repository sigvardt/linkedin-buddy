import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreRuntime } from "../runtime.js";
import { TEST_ECHO_ACTION_TYPE } from "../twoPhaseCommit.js";
import {
  callMcpTool,
  getLastJsonObject,
  MCP_TOOL_NAMES,
  runCliCommand,
  type PreparedActionResult
} from "./e2e/helpers.js";

const originalAssistantHome = process.env.LINKEDIN_BUDDY_HOME;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }

  if (originalAssistantHome === undefined) {
    delete process.env.LINKEDIN_BUDDY_HOME;
    return;
  }

  process.env.LINKEDIN_BUDDY_HOME = originalAssistantHome;
});

function createTempAssistantHome(): string {
  const baseDir = mkdtempSync(path.join(tmpdir(), "linkedin-e2e-contracts-"));
  tempDirs.push(baseDir);
  return baseDir;
}

function prepareEchoAction(
  assistantHome: string,
  profileName: string = "default"
): PreparedActionResult {
  const runtime = createCoreRuntime({ baseDir: assistantHome });
  const text = `echo-${Date.now()}`;
  const target = {
    profile_name: profileName
  } satisfies Record<string, unknown>;

  try {
    return runtime.twoPhaseCommit.prepare({
      actionType: TEST_ECHO_ACTION_TYPE,
      target,
      payload: {
        text
      },
      preview: {
        summary: `Echo action for ${profileName}`,
        target,
        outbound: {
          text
        }
      }
    });
  } finally {
    runtime.close();
  }
}

function readPreparedActionStatus(
  assistantHome: string,
  preparedActionId: string
): string | null | undefined {
  const runtime = createCoreRuntime({ baseDir: assistantHome });

  try {
    return runtime.db.getPreparedActionById(preparedActionId)?.status;
  } finally {
    runtime.close();
  }
}

describe("E2E helper contract hardening", () => {
  it("extracts the last JSON object from mixed CLI output", () => {
    const payload = getLastJsonObject(`
[linkedin] warning about attached browser session
{"preview":true}
Preview summary: not-json {still not json}
{"result":{"text":"value with } brace"}}
`);

    expect(payload).toEqual({
      result: {
        text: "value with } brace"
      }
    });
  });
});

describe("CLI confirm contract hardening", () => {
  it("reports profile mismatches without consuming the prepared action", async () => {
    const assistantHome = createTempAssistantHome();
    const prepared = prepareEchoAction(assistantHome, "primary");

    const result = await runCliCommand(
      [
        "actions",
        "confirm",
        "--profile",
        "secondary",
        "--token",
        prepared.confirmToken,
        "--yes"
      ],
      { assistantHome }
    );

    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
    expect(getLastJsonObject(result.stderr)).toMatchObject({
      code: "ACTION_PRECONDITION_FAILED",
      details: {
        expected_profile_name: "primary",
        provided_profile_name: "secondary"
      }
    });
    expect(readPreparedActionStatus(assistantHome, prepared.preparedActionId)).toBe(
      "prepared"
    );
  });

  it("rejects non-interactive confirmations without mutating the prepared action", async () => {
    const assistantHome = createTempAssistantHome();
    const prepared = prepareEchoAction(assistantHome);

    const result = await runCliCommand(
      ["actions", "confirm", "--profile", "default", "--token", prepared.confirmToken],
      { assistantHome }
    );

    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
    expect(getLastJsonObject(result.stderr)).toMatchObject({
      code: "ACTION_PRECONDITION_FAILED",
      message: expect.stringContaining("without --yes")
    });
    expect(readPreparedActionStatus(assistantHome, prepared.preparedActionId)).toBe(
      "prepared"
    );
  });

  it("returns TARGET_NOT_FOUND for unknown confirmation tokens", async () => {
    const assistantHome = createTempAssistantHome();

    const result = await runCliCommand(
      ["actions", "confirm", "--profile", "default", "--token", "ct_missing", "--yes"],
      { assistantHome }
    );

    expect(result.exitCode).toBe(1);
    expect(result.error).toBeDefined();
    expect(getLastJsonObject(result.stderr)).toMatchObject({
      code: "TARGET_NOT_FOUND"
    });
  });
});

describe("MCP confirm contract hardening", () => {
  it("reports profile mismatches without consuming the prepared action", async () => {
    const assistantHome = createTempAssistantHome();
    const prepared = prepareEchoAction(assistantHome, "primary");

    const result = await callMcpTool(
      MCP_TOOL_NAMES.actionsConfirm,
      {
        profileName: "secondary",
        token: prepared.confirmToken
      },
      { assistantHome }
    );

    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({
      code: "ACTION_PRECONDITION_FAILED",
      details: {
        expected_profile_name: "primary",
        provided_profile_name: "secondary"
      }
    });
    expect(readPreparedActionStatus(assistantHome, prepared.preparedActionId)).toBe(
      "prepared"
    );
  });

  it("returns TARGET_NOT_FOUND for unknown confirmation tokens", async () => {
    const assistantHome = createTempAssistantHome();

    const result = await callMcpTool(
      MCP_TOOL_NAMES.actionsConfirm,
      {
        profileName: "default",
        token: "ct_missing"
      },
      { assistantHome }
    );

    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({
      code: "TARGET_NOT_FOUND"
    });
  });
});
