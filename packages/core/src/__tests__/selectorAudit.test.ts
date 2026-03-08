import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { ArtifactHelpers } from "../artifacts.js";
import { ensureConfigPaths, resolveConfigPaths } from "../config.js";
import {
  LinkedInSelectorAuditService,
  type SelectorAuditPageDefinition
} from "../selectorAudit.js";

class MockLocatorImpl {
  constructor(
    private readonly selector: string,
    private readonly visibleSelectors: ReadonlySet<string>
  ) {}

  first(): Locator {
    return this as unknown as Locator;
  }

  async waitFor(): Promise<void> {
    if (!this.visibleSelectors.has(this.selector)) {
      throw new Error(`Selector not visible: ${this.selector}`);
    }
  }
}

function createMockPage(options: {
  initialUrl?: string;
  visibleSelectors: string[];
  gotoError?: Error;
}): Page {
  let currentUrl = options.initialUrl ?? "https://example.test/";
  const visibleSelectors = new Set(options.visibleSelectors);

  return {
    goto: vi.fn(async (url: string) => {
      if (options.gotoError) {
        throw options.gotoError;
      }

      currentUrl = url;
      return null;
    }),
    waitForLoadState: vi.fn(async () => {}),
    url: vi.fn(() => currentUrl),
    locator: vi.fn((selector: string) => {
      return new MockLocatorImpl(selector, visibleSelectors) as unknown as Locator;
    }),
    content: vi.fn(async () => "<html><body>selector audit</body></html>"),
    screenshot: vi.fn(async ({ path: screenshotPath }: { path?: string }) => {
      if (typeof screenshotPath === "string") {
        await writeFile(screenshotPath, "png");
      }
    }),
    accessibility: {
      snapshot: vi.fn(async () => ({ role: "WebArea", name: "selector audit" }))
    }
  } as unknown as Page;
}

function createMockContext(page: Page): BrowserContext {
  return {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page)
  } as unknown as BrowserContext;
}

function createRegistry(): SelectorAuditPageDefinition[] {
  return [
    {
      page: "feed",
      url: "https://example.test/feed",
      selectors: [
        {
          key: "selector_group",
          description: "Selector group",
          candidates: [
            {
              strategy: "primary",
              key: "primary-key",
              selectorHint: "primary",
              locatorFactory: (page) => page.locator("primary")
            },
            {
              strategy: "secondary",
              key: "secondary-key",
              selectorHint: "secondary",
              locatorFactory: (page) => page.locator("secondary")
            },
            {
              strategy: "tertiary",
              key: "tertiary-key",
              selectorHint: "tertiary",
              locatorFactory: (page) => page.locator("tertiary")
            }
          ]
        }
      ]
    }
  ];
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

async function createService(
  options: {
    visibleSelectors?: string[];
    registry?: SelectorAuditPageDefinition[];
    gotoError?: Error;
  } = {}
) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "selector-audit-test-"));
  tempDirs.push(baseDir);

  const paths = resolveConfigPaths(baseDir);
  ensureConfigPaths(paths);

  const artifacts = new ArtifactHelpers(paths, "run_test");
  const page = createMockPage({
    visibleSelectors: options.visibleSelectors ?? [],
    gotoError: options.gotoError
  });
  const context = createMockContext(page);

  const runtime = {
    runId: "run_test",
    auth: {
      ensureAuthenticated: vi.fn(async () => ({ authenticated: true }))
    },
    cdpUrl: undefined,
    profileManager: {
      runWithContext: vi.fn(async (_options, callback) => callback(context))
    },
    logger: {
      log: vi.fn()
    },
    artifacts
  };

  const service = new LinkedInSelectorAuditService(runtime as never, {
    registry: options.registry ?? createRegistry(),
    candidateTimeoutMs: 10,
    pageReadyTimeoutMs: 10
  });

  return { service, page, baseDir };
}

describe("LinkedInSelectorAuditService", () => {
  it("marks fallback usage when secondary selector is the first passing strategy", async () => {
    const { service } = await createService({
      visibleSelectors: ["secondary", "tertiary"]
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.total_count).toBe(1);
    expect(report.pass_count).toBe(1);
    expect(report.fail_count).toBe(0);
    expect(report.fallback_count).toBe(1);
    expect(report.page_summaries).toEqual([
      {
        page: "feed",
        total_count: 1,
        pass_count: 1,
        fail_count: 0,
        fallback_count: 1
      }
    ]);
    expect(report.results[0]).toMatchObject({
      page: "feed",
      selector_key: "selector_group",
      status: "pass",
      matched_strategy: "secondary",
      matched_selector_key: "secondary-key",
      fallback_used: "secondary-key",
      fallback_strategy: "secondary"
    });
    expect(report.results[0]?.strategies.primary.status).toBe("fail");
    expect(report.results[0]?.strategies.secondary.status).toBe("pass");
    await expect(stat(report.report_path)).resolves.toBeTruthy();
  });

  it("captures failure artifacts when no selector strategy matches", async () => {
    const { service } = await createService();

    const report = await service.auditSelectors({ profileName: "default" });
    const [result] = report.results;

    expect(report.total_count).toBe(1);
    expect(report.pass_count).toBe(0);
    expect(report.fail_count).toBe(1);
    expect(report.fallback_count).toBe(0);
    expect(result).toMatchObject({
      page: "feed",
      selector_key: "selector_group",
      status: "fail",
      matched_strategy: null,
      matched_selector_key: null,
      fallback_used: null,
      fallback_strategy: null
    });
    expect(result?.failure_artifacts.screenshot_path).toBeTruthy();
    expect(result?.failure_artifacts.dom_snapshot_path).toBeTruthy();
    expect(result?.failure_artifacts.accessibility_snapshot_path).toBeTruthy();
    await expect(stat(result!.failure_artifacts.screenshot_path!)).resolves.toBeTruthy();
    await expect(stat(result!.failure_artifacts.dom_snapshot_path!)).resolves.toBeTruthy();
    await expect(
      stat(result!.failure_artifacts.accessibility_snapshot_path!)
    ).resolves.toBeTruthy();
    await expect(stat(report.report_path)).resolves.toBeTruthy();
  });

  it("marks selector groups failed when navigation fails", async () => {
    const { service } = await createService({
      gotoError: new Error("Navigation failed")
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.pass_count).toBe(0);
    expect(report.fail_count).toBe(1);
    expect(report.results[0]).toMatchObject({
      page: "feed",
      selector_key: "selector_group",
      status: "fail",
      error: "Navigation failed"
    });
    expect(report.results[0]?.strategies.primary.error).toBe("Navigation failed");
  });

  it("rejects duplicate strategies in injected selector registries", async () => {
    await expect(
      createService({
        registry: [
          {
            page: "feed",
            url: "https://example.test/feed",
            selectors: [
              {
                key: "selector_group",
                description: "Selector group",
                candidates: [
                  {
                    strategy: "primary",
                    key: "primary-one",
                    selectorHint: "primary-one",
                    locatorFactory: (page) => page.locator("primary-one")
                  },
                  {
                    strategy: "primary",
                    key: "primary-two",
                    selectorHint: "primary-two",
                    locatorFactory: (page) => page.locator("primary-two")
                  }
                ]
              }
            ]
          }
        ]
      })
    ).rejects.toThrow("Duplicate selector audit strategy primary on feed:selector_group.");
  });
});
