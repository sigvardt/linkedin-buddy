import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { vi } from "vitest";
import { ArtifactHelpers } from "../artifacts.js";
import { ensureConfigPaths, resolveConfigPaths } from "../config.js";
import {
  LinkedInSelectorAuditService,
  type LinkedInSelectorAuditPage,
  type LinkedInSelectorAuditRuntime,
  type LinkedInSelectorAuditStrategy,
  type SelectorAuditCandidate,
  type SelectorAuditPageDefinition,
  type SelectorAuditSelectorDefinition
} from "../selectorAudit.js";

const tempDirs: string[] = [];

export interface MockSelectorAuditPageOptions {
  initialUrl?: string;
  visibleSelectors?: string[];
  gotoError?: unknown;
  waitForLoadStateError?: unknown;
  locatorErrors?: Record<string, unknown>;
  contentError?: unknown;
  screenshotError?: unknown;
  accessibilitySnapshotError?: unknown;
  accessibilitySnapshotValue?: unknown;
  includeAccessibility?: boolean;
  contentHtml?: string;
}

export interface SelectorAuditTestHarnessOptions extends MockSelectorAuditPageOptions {
  registry?: SelectorAuditPageDefinition[];
  authError?: unknown;
  cdpUrl?: string;
  existingPages?: Page[];
  newPageError?: unknown;
}

interface MockPageAccessibility {
  snapshot: ReturnType<typeof vi.fn>;
}

export interface SelectorAuditTestRuntime {
  runId: string;
  auth: {
    ensureAuthenticated: ReturnType<typeof vi.fn>;
  };
  cdpUrl?: string;
  profileManager: {
    runWithContext: ReturnType<typeof vi.fn>;
  };
  logger: {
    log: ReturnType<typeof vi.fn>;
  };
  artifacts: ArtifactHelpers;
}

export interface SelectorAuditTestHarness {
  service: LinkedInSelectorAuditService;
  runtime: SelectorAuditTestRuntime;
  context: BrowserContext;
  page: Page;
  baseDir: string;
}

class MockLocatorImpl {
  constructor(
    private readonly selector: string,
    private readonly visibleSelectors: ReadonlySet<string>,
    private readonly locatorErrors: ReadonlyMap<string, unknown>
  ) {}

  first(): Locator {
    return this as unknown as Locator;
  }

  async waitFor(): Promise<void> {
    const locatorError = this.locatorErrors.get(this.selector);
    if (locatorError !== undefined) {
      throw locatorError;
    }

    if (!this.visibleSelectors.has(this.selector)) {
      throw new Error(`Selector not visible: ${this.selector}`);
    }
  }
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function createSelectorAuditCandidate(options: {
  strategy: LinkedInSelectorAuditStrategy;
  selector: string;
  key?: string;
  selectorHint?: string;
}): SelectorAuditCandidate {
  return {
    strategy: options.strategy,
    key: options.key ?? `${options.strategy}-${sanitizeKey(options.selector)}`,
    selectorHint: options.selectorHint ?? options.selector,
    locatorFactory: (page) => page.locator(options.selector)
  };
}

export function createSelectorAuditSelectorDefinition(options: {
  key: string;
  description?: string;
  candidates: SelectorAuditCandidate[];
}): SelectorAuditSelectorDefinition {
  return {
    key: options.key,
    description: options.description ?? options.key,
    candidates: options.candidates
  };
}

export function createSelectorAuditPageDefinition(options: {
  page: LinkedInSelectorAuditPage;
  url?: string;
  selectors: SelectorAuditSelectorDefinition[];
  readyCandidates?: SelectorAuditCandidate[];
}): SelectorAuditPageDefinition {
  return {
    page: options.page,
    url: options.url ?? `https://example.test/${options.page}`,
    selectors: options.selectors,
    readyCandidates: options.readyCandidates
  };
}

export function createSelectorAuditTestRegistry(): SelectorAuditPageDefinition[] {
  return [
    createSelectorAuditPageDefinition({
      page: "feed",
      selectors: [
        createSelectorAuditSelectorDefinition({
          key: "selector_group",
          description: "Selector group",
          candidates: [
            createSelectorAuditCandidate({
              strategy: "primary",
              key: "primary-key",
              selectorHint: "primary",
              selector: "primary"
            }),
            createSelectorAuditCandidate({
              strategy: "secondary",
              key: "secondary-key",
              selectorHint: "secondary",
              selector: "secondary"
            }),
            createSelectorAuditCandidate({
              strategy: "tertiary",
              key: "tertiary-key",
              selectorHint: "tertiary",
              selector: "tertiary"
            })
          ]
        })
      ]
    })
  ];
}

export function createMockSelectorAuditPage(
  options: MockSelectorAuditPageOptions = {}
): Page {
  let currentUrl = options.initialUrl ?? "https://example.test/";
  const visibleSelectors = new Set(options.visibleSelectors ?? []);
  const locatorErrors = new Map(Object.entries(options.locatorErrors ?? {}));

  const page: Partial<Page> & { accessibility?: MockPageAccessibility } = {
    goto: vi.fn(async (url: string, gotoOptions?: { waitUntil?: string }) => {
      void gotoOptions;

      if (options.gotoError !== undefined) {
        throw options.gotoError;
      }

      currentUrl = url;
      return null;
    }),
    waitForLoadState: vi.fn(async (state?: string, loadOptions?: { timeout?: number }) => {
      void state;
      void loadOptions;

      if (options.waitForLoadStateError !== undefined) {
        throw options.waitForLoadStateError;
      }
    }),
    url: vi.fn(() => currentUrl),
    locator: vi.fn((selector: string) => {
      return new MockLocatorImpl(selector, visibleSelectors, locatorErrors) as unknown as Locator;
    }),
    content: vi.fn(async () => {
      if (options.contentError !== undefined) {
        throw options.contentError;
      }

      return options.contentHtml ?? "<html><body>selector audit</body></html>";
    }),
    screenshot: vi.fn(async (screenshotOptions?: { path?: string; fullPage?: boolean }) => {
      if (options.screenshotError !== undefined) {
        throw options.screenshotError;
      }

      if (typeof screenshotOptions?.path === "string") {
        await writeFile(screenshotOptions.path, "png");
      }
    })
  };

  if (options.includeAccessibility !== false) {
    page.accessibility = {
      snapshot: vi.fn(async () => {
        if (options.accessibilitySnapshotError !== undefined) {
          throw options.accessibilitySnapshotError;
        }

        return options.accessibilitySnapshotValue ?? {
          role: "WebArea",
          name: "selector audit"
        };
      })
    };
  }

  return page as Page;
}

export function createMockSelectorAuditContext(
  page: Page,
  options: {
    existingPages?: Page[];
    newPageError?: unknown;
  } = {}
): BrowserContext {
  return {
    pages: vi.fn(() => options.existingPages ?? [page]),
    newPage: vi.fn(async () => {
      if (options.newPageError !== undefined) {
        throw options.newPageError;
      }

      return page;
    })
  } as unknown as BrowserContext;
}

export async function createSelectorAuditTestHarness(
  options: SelectorAuditTestHarnessOptions = {}
): Promise<SelectorAuditTestHarness> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "selector-audit-test-"));
  tempDirs.push(baseDir);

  const paths = resolveConfigPaths(baseDir);
  ensureConfigPaths(paths);

  const artifacts = new ArtifactHelpers(paths, "run_test");
  const page = createMockSelectorAuditPage(options);
  const context = createMockSelectorAuditContext(page, {
    existingPages: options.existingPages,
    newPageError: options.newPageError
  });

  const runtime: SelectorAuditTestRuntime = {
    runId: "run_test",
    auth: {
      ensureAuthenticated: vi.fn(async () => {
        if (options.authError !== undefined) {
          throw options.authError;
        }

        return { authenticated: true };
      })
    },
    cdpUrl: options.cdpUrl,
    profileManager: {
      runWithContext: vi.fn(async (_runtimeOptions: unknown, callback: (context: BrowserContext) => Promise<unknown>) => {
        return callback(context);
      })
    },
    logger: {
      log: vi.fn()
    },
    artifacts
  };

  const service = new LinkedInSelectorAuditService(
    runtime as unknown as LinkedInSelectorAuditRuntime,
    {
    registry: options.registry ?? createSelectorAuditTestRegistry(),
    candidateTimeoutMs: 10,
    pageReadyTimeoutMs: 10
    }
  );

  return {
    service,
    runtime,
    context,
    page,
    baseDir
  };
}

export async function cleanupSelectorAuditTestHarnesses(): Promise<void> {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
}
