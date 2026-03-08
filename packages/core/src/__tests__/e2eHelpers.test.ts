import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callMcpToolWith,
  getCliCoverageFixtures,
  getDefaultConnectionTarget,
  getDefaultProfileName,
  getLastJsonObject,
  mapMcpToolResult,
  runCliCommandWith
} from "./e2e/helpers.js";

const tempDirs: string[] = [];
const originalEnv = {
  profile: process.env.LINKEDIN_E2E_PROFILE,
  connectionTarget: process.env.LINKEDIN_E2E_CONNECTION_TARGET,
  fixtureFile: process.env.LINKEDIN_E2E_FIXTURE_FILE,
  refreshFixtures: process.env.LINKEDIN_E2E_REFRESH_FIXTURES
};

function createTempAssistantHome(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-e2e-helper-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createFixtureRuntime() {
  return {
    inbox: {
      listThreads: vi.fn(async () => [
        {
          thread_id: "thread-123",
          title: "Simon Miller",
          thread_url: "https://www.linkedin.com/messaging/thread-123"
        }
      ])
    },
    feed: {
      viewFeed: vi.fn(async () => [
        {
          post_id: "post-123",
          post_url: "https://www.linkedin.com/feed/update/post-123",
          author_name: "Fixture Author"
        }
      ])
    },
    jobs: {
      searchJobs: vi.fn(async () => ({
        results: [
          {
            job_id: "job-123",
            title: "Fixture Job"
          }
        ]
      }))
    }
  } as unknown as Parameters<typeof getCliCoverageFixtures>[0];
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }

  if (originalEnv.profile === undefined) {
    delete process.env.LINKEDIN_E2E_PROFILE;
  } else {
    process.env.LINKEDIN_E2E_PROFILE = originalEnv.profile;
  }

  if (originalEnv.connectionTarget === undefined) {
    delete process.env.LINKEDIN_E2E_CONNECTION_TARGET;
  } else {
    process.env.LINKEDIN_E2E_CONNECTION_TARGET = originalEnv.connectionTarget;
  }

  if (originalEnv.fixtureFile === undefined) {
    delete process.env.LINKEDIN_E2E_FIXTURE_FILE;
  } else {
    process.env.LINKEDIN_E2E_FIXTURE_FILE = originalEnv.fixtureFile;
  }

  if (originalEnv.refreshFixtures === undefined) {
    delete process.env.LINKEDIN_E2E_REFRESH_FIXTURES;
  } else {
    process.env.LINKEDIN_E2E_REFRESH_FIXTURES = originalEnv.refreshFixtures;
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

describe("E2E fixture helpers", () => {
  it("reads env overrides dynamically instead of freezing them at import time", () => {
    process.env.LINKEDIN_E2E_PROFILE = "primary";
    process.env.LINKEDIN_E2E_CONNECTION_TARGET = "target-a";

    expect(getDefaultProfileName()).toBe("primary");
    expect(getDefaultConnectionTarget()).toBe("target-a");

    process.env.LINKEDIN_E2E_PROFILE = "secondary";
    process.env.LINKEDIN_E2E_CONNECTION_TARGET = "target-b";

    expect(getDefaultProfileName()).toBe("secondary");
    expect(getDefaultConnectionTarget()).toBe("target-b");
  });

  it("replays saved CLI coverage fixtures without rediscovering live targets", async () => {
    const tempDir = createTempAssistantHome();
    const fixturePath = path.join(tempDir, "fixtures.json");
    process.env.LINKEDIN_E2E_PROFILE = "fixture-profile";
    process.env.LINKEDIN_E2E_FIXTURE_FILE = fixturePath;

    writeFileSync(
      fixturePath,
      `${JSON.stringify(
        {
          format: 1,
          profileName: "fixture-profile",
          threadId: "thread-from-file",
          postUrl: "https://www.linkedin.com/feed/update/from-file",
          jobId: "job-from-file",
          connectionTarget: "fixture-target"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const runtime = createFixtureRuntime();
    const fixtures = await getCliCoverageFixtures(runtime);

    expect(fixtures).toEqual({
      threadId: "thread-from-file",
      postUrl: "https://www.linkedin.com/feed/update/from-file",
      jobId: "job-from-file",
      connectionTarget: "fixture-target"
    });
    expect(runtime.inbox.listThreads).not.toHaveBeenCalled();
    expect(runtime.feed.viewFeed).not.toHaveBeenCalled();
    expect(runtime.jobs.searchJobs).not.toHaveBeenCalled();
  });

  it("refreshes and rewrites the coverage fixture file when requested", async () => {
    const tempDir = createTempAssistantHome();
    const fixturePath = path.join(tempDir, "fixtures.json");
    process.env.LINKEDIN_E2E_PROFILE = "refresh-profile";
    process.env.LINKEDIN_E2E_CONNECTION_TARGET = "refresh-target";
    process.env.LINKEDIN_E2E_FIXTURE_FILE = fixturePath;
    process.env.LINKEDIN_E2E_REFRESH_FIXTURES = "1";

    const runtime = createFixtureRuntime();
    const fixtures = await getCliCoverageFixtures(runtime);

    expect(fixtures).toEqual({
      threadId: "thread-123",
      postUrl: "https://www.linkedin.com/feed/update/post-123",
      jobId: "job-123",
      connectionTarget: "refresh-target"
    });

    const savedFixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    expect(savedFixtures).toMatchObject({
      format: 1,
      profileName: "refresh-profile",
      threadId: "thread-123",
      postUrl: "https://www.linkedin.com/feed/update/post-123",
      jobId: "job-123",
      connectionTarget: "refresh-target"
    });
    expect(typeof savedFixtures.capturedAt).toBe("string");
  });

  it("fails with actionable guidance when the saved fixture file is invalid", async () => {
    const tempDir = createTempAssistantHome();
    const fixturePath = path.join(tempDir, "fixtures.json");
    process.env.LINKEDIN_E2E_FIXTURE_FILE = fixturePath;

    writeFileSync(
      fixturePath,
      `${JSON.stringify(
        {
          format: 1,
          threadId: "thread-only"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(getCliCoverageFixtures(createFixtureRuntime())).rejects.toThrow(
      "--refresh-fixtures"
    );
  });
});
