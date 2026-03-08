import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { ArtifactHelpers } from "../artifacts.js";
import { executeConfirmActionWithArtifacts } from "../confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig, ConfigPaths } from "../config.js";
import { ensureConfigPaths, resolveConfigPaths } from "../config.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "../errors.js";

interface TestRuntime {
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
  logger: {
    log: ReturnType<typeof vi.fn>;
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTestRuntime(traceMaxBytes: number): TestRuntime {
  const baseDir = mkdtempSync(path.join(tmpdir(), "linkedin-confirm-artifacts-"));
  tempDirs.push(baseDir);
  const paths: ConfigPaths = resolveConfigPaths(baseDir);
  ensureConfigPaths(paths);

  return {
    artifacts: new ArtifactHelpers(paths, "run-test"),
    confirmFailureArtifacts: {
      traceMaxBytes
    },
    logger: {
      log: vi.fn()
    }
  };
}

function createTraceArchive(): Uint8Array {
  return zipSync(
    {
      "trace.trace": strToU8(JSON.stringify({ events: [{ type: "before" }] })),
      "trace.network": strToU8(JSON.stringify({ requests: [] })),
      "resources/large-resource.txt": new Uint8Array(8_192).fill(65)
    },
    { level: 0 }
  );
}

function createContext(traceArchive: Uint8Array, accessibilityTree: unknown): BrowserContext {
  const cdpSession = {
    send: vi.fn(async () => accessibilityTree),
    detach: vi.fn(async () => undefined)
  };

  return {
    tracing: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async (options?: { path?: string }) => {
        if (options?.path) {
          writeFileSync(options.path, Buffer.from(traceArchive));
        }
      })
    },
    newCDPSession: vi.fn(async () => cdpSession)
  } as unknown as BrowserContext;
}

function createPage(context: BrowserContext, currentUrl: string): Page {
  return {
    screenshot: vi.fn(async (options?: { path?: string }) => {
      if (options?.path) {
        writeFileSync(options.path, Buffer.from("png"));
      }
    }),
    content: vi.fn(async () => "<html><body><main>Failure snapshot</main></body></html>"),
    context: vi.fn(() => context),
    url: vi.fn(() => currentUrl)
  } as unknown as Page;
}

describe("executeConfirmActionWithArtifacts", () => {
  it("captures screenshot, DOM, accessibility, and a capped trace on failure", async () => {
    const runtime = createTestRuntime(600);
    const traceArchive = createTraceArchive();
    const context = createContext(traceArchive, {
      nodes: [{ role: { value: "RootWebArea" } }]
    });
    const page = createPage(
      context,
      "https://www.linkedin.com/feed/update/urn:li:activity:123"
    );

    let thrownError: unknown;
    try {
      await executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId: "act-1",
        actionType: "feed.like_post",
        profileName: "default",
        targetUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123",
        errorDetails: {
          post_url: "https://www.linkedin.com/feed/update/urn:li:activity:123"
        },
        mapError: (error) =>
          asLinkedInAssistantError(error, "UNKNOWN", "Like action failed."),
        execute: async () => {
          throw new LinkedInAssistantError("UNKNOWN", "boom", {
            selector_key: "reaction_button"
          });
        }
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(LinkedInAssistantError);
    const assistantError = thrownError as LinkedInAssistantError;
    const artifactPaths = assistantError.details.artifact_paths as string[];

    expect(assistantError.details.artifacts).toEqual(artifactPaths);
    expect(assistantError.details.action_id).toBe("act-1");
    expect(assistantError.details.post_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:123"
    );
    expect(artifactPaths).toHaveLength(4);
    expect(artifactPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining("screenshot-confirm-error-feed-like-post"),
        expect.stringContaining("dom-confirm-error-feed-like-post"),
        expect.stringContaining("accessibility-confirm-error-feed-like-post"),
        expect.stringContaining("trace-confirm-feed-like-post")
      ])
    );

    for (const artifactPath of artifactPaths) {
      expect(statSync(runtime.artifacts.resolve(artifactPath)).size).toBeGreaterThan(0);
    }

    const tracePath = artifactPaths.find((artifactPath) =>
      artifactPath.includes("trace-confirm-feed-like-post")
    );
    expect(tracePath).toBeDefined();

    const absoluteTracePath = runtime.artifacts.resolve(tracePath!);
    expect(statSync(absoluteTracePath).size).toBeLessThanOrEqual(600);
    const traceEntries = Object.keys(unzipSync(readFileSync(absoluteTracePath)));
    expect(traceEntries).toContain("trace.trace");
    expect(traceEntries).toContain("trace.network");
    expect(traceEntries).not.toContain("resources/large-resource.txt");

    expect(runtime.logger.log).toHaveBeenCalledWith(
      "info",
      "confirm.trace.pruned",
      expect.objectContaining({
        action_id: "act-1",
        action_type: "feed.like_post",
        max_bytes: 600
      })
    );
  });

  it("can persist a trace on successful confirm actions", async () => {
    const runtime = createTestRuntime(2_048);
    const context = createContext(createTraceArchive(), {
      nodes: [{ role: { value: "RootWebArea" } }]
    });
    const page = createPage(
      context,
      "https://www.linkedin.com/messaging/thread/123/"
    );

    const result = await executeConfirmActionWithArtifacts({
      runtime,
      context,
      page,
      actionId: "act-2",
      actionType: "send_message",
      profileName: "default",
      targetUrl: "https://www.linkedin.com/messaging/thread/123/",
      persistTraceOnSuccess: true,
      mapError: (error) => asLinkedInAssistantError(error, "UNKNOWN", "Send failed."),
      execute: async () => ({
        ok: true,
        result: {
          sent: true
        },
        artifacts: []
      })
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toContain("trace-confirm-send-message");
    expect(statSync(runtime.artifacts.resolve(result.artifacts[0])).size).toBeGreaterThan(0);
  });
});
