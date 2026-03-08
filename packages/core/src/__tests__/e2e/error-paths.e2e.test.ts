import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LinkedInAssistantError } from "../../errors.js";
import { createCoreRuntime, type CoreRuntime } from "../../runtime.js";
import {
  LinkedInSelectorAuditService,
  type SelectorAuditPageDefinition
} from "../../selectorAudit.js";
import { getFeedPost } from "./helpers.js";
import { getCdpUrl, setupE2ESuite } from "./setup.js";

const LIKE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.like_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 30
} as const;

async function createIsolatedRuntime(): Promise<{
  runtime: CoreRuntime;
  dispose: () => Promise<void>;
}> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-e2e-"));
  const runtime = createCoreRuntime({
    baseDir,
    cdpUrl: getCdpUrl()
  });

  return {
    runtime,
    dispose: async () => {
      runtime.close();
      await rm(baseDir, { recursive: true, force: true });
    }
  };
}

async function expectAssistantError(
  promise: Promise<unknown>,
  expectedCode: string
): Promise<LinkedInAssistantError> {
  try {
    await promise;
    throw new Error(`Expected ${expectedCode} error.`);
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedInAssistantError);
    const assistantError = error as LinkedInAssistantError;
    expect(assistantError.code).toBe(expectedCode);
    return assistantError;
  }
}

describe("E2E error paths", () => {
  const e2e = setupE2ESuite();

  it("rejects expired confirmation tokens before execution", async () => {
    if (!e2e.canRun()) return;

    const isolated = await createIsolatedRuntime();
    try {
      const post = await getFeedPost(isolated.runtime);
      const prepared = isolated.runtime.feed.prepareLikePost({
        postUrl: post.post_url,
        reaction: "like"
      });

      const error = await expectAssistantError(
        isolated.runtime.twoPhaseCommit.confirmByToken({
          confirmToken: prepared.confirmToken,
          nowMs: prepared.expiresAtMs + 1
        }),
        "ACTION_PRECONDITION_FAILED"
      );
      expect(error.message).toContain("expired");

      const row = isolated.runtime.db.getPreparedActionById(prepared.preparedActionId);
      expect(row?.status).toBe("prepared");
    } finally {
      await isolated.dispose();
    }
  }, 120_000);

  it("surfaces rate limit failures without performing the action", async () => {
    if (!e2e.canRun()) return;

    const isolated = await createIsolatedRuntime();
    try {
      const post = await getFeedPost(isolated.runtime);
      const prepared = isolated.runtime.feed.prepareLikePost({
        postUrl: post.post_url,
        reaction: "like"
      });
      const windowNow = Date.now();

      for (let count = 0; count < LIKE_RATE_LIMIT_CONFIG.limit; count += 1) {
        isolated.runtime.rateLimiter.consume({
          ...LIKE_RATE_LIMIT_CONFIG,
          nowMs: windowNow
        });
      }

      const error = await expectAssistantError(
        isolated.runtime.twoPhaseCommit.confirmByToken({
          confirmToken: prepared.confirmToken,
          nowMs: windowNow
        }),
        "RATE_LIMITED"
      );
      expect(error.details).toHaveProperty("rate_limit");

      const row = isolated.runtime.db.getPreparedActionById(prepared.preparedActionId);
      expect(row?.status).toBe("failed");
      expect(row?.error_code).toBe("RATE_LIMITED");
    } finally {
      await isolated.dispose();
    }
  }, 120_000);

  it("detects UI drift through selector audit failure artifacts", async () => {
    if (!e2e.canRun()) return;

    const isolated = await createIsolatedRuntime();
    try {
      const registry: SelectorAuditPageDefinition[] = [
        {
          page: "feed",
          url: "https://www.linkedin.com/feed/",
          selectors: [
            {
              key: "impossible_feed_selector",
              description: "Deliberately impossible selector used to validate UI drift reporting.",
              candidates: [
                {
                  key: "impossible-primary",
                  strategy: "primary",
                  selectorHint: "text=__linkedin_e2e_missing_selector__",
                  locatorFactory: (page) =>
                    page.locator("text=__linkedin_e2e_missing_selector__")
                }
              ]
            }
          ]
        }
      ];

      const selectorAudit = new LinkedInSelectorAuditService(isolated.runtime, {
        registry,
        candidateTimeoutMs: 250,
        pageReadyTimeoutMs: 1_000,
        pageNavigationTimeoutMs: 15_000
      });
      const report = await selectorAudit.auditSelectors();

      expect(report.outcome).toBe("fail");
      expect(report.fail_count).toBe(1);
      expect(report.failed_selectors).toHaveLength(1);
      expect(report.failed_selectors[0]).toMatchObject({
        page: "feed",
        selector_key: "impossible_feed_selector"
      });
      expect(report.failed_selectors[0]?.failure_artifacts.screenshot_path).toEqual(
        expect.any(String)
      );
      expect(report.failed_selectors[0]?.failure_artifacts.dom_snapshot_path).toEqual(
        expect.any(String)
      );
    } finally {
      await isolated.dispose();
    }
  }, 120_000);
});
