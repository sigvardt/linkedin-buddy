import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import type {
  LinkedInReplayPageType,
  ReadOnlyValidationOperationResult,
  ReadOnlyValidationReport
} from "@linkedin-assistant/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface BrowserRequestDefinition {
  method: string;
  resourceType: string;
  url: string;
}

interface BrowserMockState {
  extraRequestsByUrl: Map<string, BrowserRequestDefinition[]>;
  networkIdleTimeoutUrls: Set<string>;
  redirects: Map<string, string>;
  replayBaseUrl: string;
}

interface ReplayPageFixture {
  bodyPath: string;
  html: string;
  pageType: LinkedInReplayPageType;
  title: string;
  url: string;
}

interface ReplayRouteFixture {
  bodyPath: string;
  html: string;
  method?: string;
  pageType?: LinkedInReplayPageType;
  status?: number;
  url: string;
}

interface CreatedReplayFixtureSet {
  manifestPath: string;
  setName: string;
}

const browserMockState = vi.hoisted<BrowserMockState>(() => ({
  extraRequestsByUrl: new Map<string, BrowserRequestDefinition[]>(),
  networkIdleTimeoutUrls: new Set<string>(),
  redirects: new Map<string, string>(),
  replayBaseUrl: ""
}));

vi.mock("playwright-core", () => {
  const REPLAY_ROUTE_PATH = "/__linkedin_fixture__/replay";
  const VISIBLE_PREFIX = "<!-- visible:";

  class TimeoutError extends Error {}

  class FakeRequest {
    constructor(private readonly input: BrowserRequestDefinition) {}

    method(): string {
      return this.input.method;
    }

    resourceType(): string {
      return this.input.resourceType;
    }

    url(): string {
      return this.input.url;
    }
  }

  class FakeRoute {
    constructor(private readonly input: BrowserRequestDefinition) {}

    async abort(): Promise<void> {
      return undefined;
    }

    async continue(): Promise<void> {
      return undefined;
    }

    request(): FakeRequest {
      return new FakeRequest(this.input);
    }
  }

  class FakePage {
    private currentHtml = "";

    private currentUrl = "about:blank";

    constructor(private readonly contextInstance: FakeContext) {}

    context(): FakeContext {
      return this.contextInstance;
    }

    async goto(url: string): Promise<void> {
      await this.contextInstance.dispatchRequests(url);

      const finalUrl = browserMockState.redirects.get(url) ?? url;
      this.currentUrl = finalUrl;
      this.currentHtml = await this.lookupHtml(finalUrl);
    }

    locator(selector: string): FakeLocator {
      return new FakeLocator(this, selector);
    }

    setDefaultNavigationTimeout(): void {
      // No-op for the fixture-backed mock page.
    }

    setDefaultTimeout(): void {
      // No-op for the fixture-backed mock page.
    }

    url(): string {
      return this.currentUrl;
    }

    async waitForLoadState(): Promise<void> {
      if (browserMockState.networkIdleTimeoutUrls.has(this.currentUrl)) {
        throw new TimeoutError(`Timed out waiting for networkidle on ${this.currentUrl}`);
      }
    }

    matchesSelector(selector: string): boolean {
      return this.currentHtml.includes(`${VISIBLE_PREFIX}${selector} -->`);
    }

    async clickSelector(selector: string): Promise<void> {
      if (!this.matchesSelector(selector)) {
        throw new TimeoutError(`Selector ${selector} is not visible.`);
      }

      if (
        selector.includes("/messaging/thread/") ||
        selector.includes("/messaging/detail/")
      ) {
        const threadMatch = /href=(['"])([^'"]*\/messaging\/(?:thread|detail)\/[^'"]*)\1/u.exec(
          this.currentHtml
        );
        if (!threadMatch || !threadMatch[2]) {
          throw new Error("Fixture messaging page did not include a clickable thread link.");
        }

        const threadUrl = new URL(threadMatch[2], this.currentUrl).toString();
        await this.goto(threadUrl);
      }
    }

    private async lookupHtml(url: string): Promise<string> {
      if (!browserMockState.replayBaseUrl) {
        throw new Error("Fixture replay base URL is not configured for the mock browser.");
      }

      const response = await fetch(`${browserMockState.replayBaseUrl}${REPLAY_ROUTE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          method: "GET",
          url
        })
      });

      return await response.text();
    }
  }

  class FakeLocator {
    constructor(
      private readonly page: FakePage,
      private readonly selector: string
    ) {}

    first(): FakeLocator {
      return this;
    }

    async click(): Promise<void> {
      await this.page.clickSelector(this.selector);
    }

    async isVisible(): Promise<boolean> {
      return this.page.matchesSelector(this.selector);
    }

    async waitFor(): Promise<void> {
      if (!this.page.matchesSelector(this.selector)) {
        throw new TimeoutError(`Selector ${this.selector} is not visible.`);
      }
    }
  }

  class FakeContext {
    private page: FakePage | undefined;

    private routeHandler:
      | ((route: FakeRoute) => Promise<void>)
      | undefined;

    constructor(
      private readonly storageState: {
        cookies?: readonly Record<string, unknown>[];
      }
    ) {}

    async close(): Promise<void> {
      return undefined;
    }

    async cookies(): Promise<readonly Record<string, unknown>[]> {
      return this.storageState.cookies ?? [];
    }

    async newPage(): Promise<FakePage> {
      this.page = new FakePage(this);
      return this.page;
    }

    pages(): FakePage[] {
      return this.page ? [this.page] : [];
    }

    async route(
      _pattern: string,
      handler: (route: FakeRoute) => Promise<void>
    ): Promise<void> {
      this.routeHandler = handler;
    }

    setDefaultNavigationTimeout(): void {
      // No-op for the fixture-backed mock context.
    }

    setDefaultTimeout(): void {
      // No-op for the fixture-backed mock context.
    }

    async dispatchRequests(navigationUrl: string): Promise<void> {
      if (!this.routeHandler) {
        return;
      }

      const requestDefinitions: BrowserRequestDefinition[] = [
        {
          method: "GET",
          resourceType: "document",
          url: navigationUrl
        },
        ...(browserMockState.extraRequestsByUrl.get(navigationUrl) ?? [])
      ];

      for (const requestDefinition of requestDefinitions) {
        await this.routeHandler(new FakeRoute(requestDefinition));
      }
    }
  }

  class FakeBrowser {
    async close(): Promise<void> {
      return undefined;
    }

    async newContext(options: {
      storageState: {
        cookies?: readonly Record<string, unknown>[];
      };
    }): Promise<FakeContext> {
      return new FakeContext(options.storageState);
    }
  }

  return {
    chromium: {
      connectOverCDP: vi.fn(),
      launch: vi.fn(async () => new FakeBrowser()),
      launchPersistentContext: vi.fn()
    },
    errors: {
      TimeoutError
    }
  };
});

vi.mock("@linkedin-assistant/core", async () =>
  await import("../../core/src/index.js")
);

import * as core from "@linkedin-assistant/core";
import { runCli } from "../src/bin/linkedin.js";

const FEED_URL = "https://www.linkedin.com/feed/";
const PROFILE_URL = "https://www.linkedin.com/in/me/";
const NOTIFICATIONS_URL = "https://www.linkedin.com/notifications/";
const MESSAGING_URL = "https://www.linkedin.com/messaging/";
const MESSAGING_THREAD_URL = "https://www.linkedin.com/messaging/thread/abc/";
const CONNECTIONS_URL =
  "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const LOGIN_URL = "https://www.linkedin.com/login";

const originalAssistantHome = process.env.LINKEDIN_ASSISTANT_HOME;
const originalReplayEnabled = process.env.LINKEDIN_E2E_REPLAY;
const originalFixtureManifest = process.env.LINKEDIN_E2E_FIXTURE_MANIFEST;
const originalFixtureSet = process.env.LINKEDIN_E2E_FIXTURE_SET;

function setInteractiveMode(inputIsTty: boolean, outputIsTty: boolean): void {
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: inputIsTty
  });
  Object.defineProperty(stdout, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
}

function visible(selector: string): string {
  return `<!-- visible:${selector} -->`;
}

function restoreFixtureReplayEnvironment(): void {
  if (originalAssistantHome === undefined) {
    delete process.env.LINKEDIN_ASSISTANT_HOME;
  } else {
    process.env.LINKEDIN_ASSISTANT_HOME = originalAssistantHome;
  }

  if (originalReplayEnabled === undefined) {
    delete process.env.LINKEDIN_E2E_REPLAY;
  } else {
    process.env.LINKEDIN_E2E_REPLAY = originalReplayEnabled;
  }

  if (originalFixtureManifest === undefined) {
    delete process.env.LINKEDIN_E2E_FIXTURE_MANIFEST;
  } else {
    process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = originalFixtureManifest;
  }

  if (originalFixtureSet === undefined) {
    delete process.env.LINKEDIN_E2E_FIXTURE_SET;
  } else {
    process.env.LINKEDIN_E2E_FIXTURE_SET = originalFixtureSet;
  }
}

async function writeJsonFixture(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createReplayFixtureSet(
  tempDir: string,
  input: {
    extraRoutes?: ReplayRouteFixture[];
    pages: ReplayPageFixture[];
    setName?: string;
  }
): Promise<CreatedReplayFixtureSet> {
  const setName = input.setName ?? "ci";
  const recordedAt = "2026-03-09T10:00:00.000Z";
  const rootDir = path.join(tempDir, setName);
  const manifestPath = path.join(tempDir, "manifest.json");
  const routeFixtures = [...input.pages, ...(input.extraRoutes ?? [])];

  await writeJsonFixture(manifestPath, {
    format: 1,
    updatedAt: recordedAt,
    defaultSetName: setName,
    sets: {
      [setName]: {
        setName,
        rootDir: setName,
        locale: "en-US",
        capturedAt: recordedAt,
        viewport: {
          width: 1440,
          height: 900
        },
        routesPath: "routes.json",
        pages: Object.fromEntries(
          input.pages.map((page) => [
            page.pageType,
            {
              htmlPath: page.bodyPath,
              pageType: page.pageType,
              recordedAt,
              title: page.title,
              url: page.url
            }
          ])
        )
      }
    }
  });

  await writeJsonFixture(path.join(rootDir, "routes.json"), {
    format: 1,
    routes: routeFixtures.map((routeFixture) => ({
      bodyPath: routeFixture.bodyPath,
      headers: {
        "content-type": "text/html; charset=utf-8"
      },
      method: routeFixture.method ?? "GET",
      ...(routeFixture.pageType ? { pageType: routeFixture.pageType } : {}),
      status: routeFixture.status ?? 200,
      url: routeFixture.url
    })),
    setName
  });

  for (const routeFixture of routeFixtures) {
    const filePath = path.join(rootDir, routeFixture.bodyPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, routeFixture.html, "utf8");
  }

  return {
    manifestPath,
    setName
  };
}

function enableReplay(manifestPath: string, setName: string): void {
  process.env.LINKEDIN_ASSISTANT_HOME = path.dirname(manifestPath);
  process.env.LINKEDIN_E2E_REPLAY = "1";
  process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = manifestPath;
  process.env.LINKEDIN_E2E_FIXTURE_SET = setName;
}

async function seedStoredSession(
  assistantHome: string,
  sessionName: string,
  withAuthCookie: boolean = true
): Promise<void> {
  const store = new core.LinkedInSessionStore(assistantHome);
  await store.save(sessionName, {
    cookies: withAuthCookie
      ? [
          {
            domain: ".linkedin.com",
            expires: 1_901_318_400,
            httpOnly: true,
            name: "li_at",
            path: "/",
            sameSite: "Lax",
            secure: true,
            value: "stored-auth-cookie"
          }
        ]
      : [],
    origins: []
  });
}

function findOperation(
  report: ReadOnlyValidationReport,
  operationId: ReadOnlyValidationOperationResult["operation"]
): ReadOnlyValidationOperationResult {
  const operation = report.operations.find(
    (candidate) => candidate.operation === operationId
  );

  if (!operation) {
    throw new Error(`Expected report to include ${operationId}.`);
  }

  return operation;
}

describe("linkedin live validation CLI integration", () => {
  const tempDirs: string[] = [];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    browserMockState.extraRequestsByUrl.clear();
    browserMockState.networkIdleTimeoutUrls.clear();
    browserMockState.redirects.clear();
    browserMockState.replayBaseUrl = "";
    process.exitCode = undefined;
    stderrChunks = [];
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        const [chunk] = args;
        stderrChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    core.shutdownSharedFixtureReplayServer();
    restoreFixtureReplayEnvironment();
    process.exitCode = undefined;

    await Promise.all(
      tempDirs.splice(0).map(async (tempDir) => {
        await rm(tempDir, { recursive: true, force: true });
      })
    );
  });

  it("runs the real CLI against fixture-backed replay pages and emits structured JSON", async () => {
    setInteractiveMode(false, false);

    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((handler: Parameters<typeof setTimeout>[0], _delay?: number, ...args: unknown[]) => {
        return realSetTimeout(handler as never, 0, ...args);
      }) as unknown as typeof setTimeout
    );

    const assistantHome = await mkdtemp(
      path.join(os.tmpdir(), "linkedin-live-validation-cli-")
    );
    tempDirs.push(assistantHome);

    const { manifestPath, setName } = await createReplayFixtureSet(assistantHome, {
      setName: "smoke",
      pages: [
        {
          bodyPath: "pages/feed.html",
          html: [
            "<html><body>",
            visible("main [data-urn]"),
            visible("header nav"),
            "<header><nav></nav></header>",
            "<main role=\"main\"><div data-urn=\"urn:li:activity:1\"></div></main>",
            "</body></html>"
          ].join(""),
          pageType: "feed",
          title: "Feed",
          url: FEED_URL
        },
        {
          bodyPath: "pages/profile.html",
          html: [
            "<html><body>",
            visible("main h1"),
            visible("main"),
            "<main><h1>Jane Doe</h1></main>",
            "</body></html>"
          ].join(""),
          pageType: "profile",
          title: "Profile",
          url: PROFILE_URL
        },
        {
          bodyPath: "pages/notifications.html",
          html: [
            "<html><body>",
            visible("main"),
            visible("a[href*='/notifications/']"),
            "<main><a href=\"/notifications/item\">Notification</a></main>",
            "</body></html>"
          ].join(""),
          pageType: "notifications",
          title: "Notifications",
          url: NOTIFICATIONS_URL
        },
        {
          bodyPath: "pages/messaging.html",
          html: [
            "<html><body>",
            visible(".msg-conversations-container__conversations-list"),
            visible("a[href*='/messaging/thread/']"),
            `<main><div class="msg-conversations-container__conversations-list"></div><a href="${MESSAGING_THREAD_URL}">Thread</a></main>`,
            "</body></html>"
          ].join(""),
          pageType: "messaging",
          title: "Messaging",
          url: MESSAGING_URL
        },
        {
          bodyPath: "pages/connections.html",
          html: "<html><body><main",
          pageType: "connections",
          title: "Connections",
          url: CONNECTIONS_URL
        }
      ],
      extraRoutes: [
        {
          bodyPath: "pages/thread.html",
          html: [
            "<html><body>",
            visible("li.msg-s-message-list__event"),
            "<main><ul><li class=\"msg-s-message-list__event\">Hi</li></ul></main>",
            "</body></html>"
          ].join(""),
          url: MESSAGING_THREAD_URL
        }
      ]
    });

    enableReplay(manifestPath, setName);
    const replayServer = await core.ensureSharedFixtureReplayServer();
    if (!replayServer) {
      throw new Error("Expected the shared fixture replay server to start.");
    }
    browserMockState.replayBaseUrl = replayServer.baseUrl;
    browserMockState.extraRequestsByUrl.set(FEED_URL, [
      {
        method: "POST",
        resourceType: "xhr",
        url: "https://www.linkedin.com/voyager/api/graphql"
      },
      {
        method: "GET",
        resourceType: "script",
        url: "https://example.com/tracker.js"
      }
    ]);
    browserMockState.networkIdleTimeoutUrls.add(NOTIFICATIONS_URL);

    await seedStoredSession(assistantHome, "smoke");

    const previousReportPath = path.join(
      assistantHome,
      "artifacts",
      "live-readonly",
      "latest-report.json"
    );
    await mkdir(path.dirname(previousReportPath), { recursive: true });
    await writeFile(
      previousReportPath,
      `${JSON.stringify(
        {
          operations: [
            {
              operation: "feed",
              selector_results: [
                {
                  description: "Feed content surface",
                  matched_candidate_key: "feed-update-card",
                  matched_candidate_rank: 0,
                  matched_selector: "div.feed-shared-update-v2",
                  selector_key: "feed_surface",
                  status: "pass"
                },
                {
                  description: "Authenticated global navigation",
                  matched_candidate_key: "global-nav",
                  matched_candidate_rank: 0,
                  matched_selector: "nav.global-nav",
                  selector_key: "global_nav",
                  status: "pass"
                }
              ]
            },
            {
              operation: "connections",
              selector_results: [
                {
                  description: "Connections list or container",
                  matched_candidate_key: "connections-list",
                  matched_candidate_rank: 0,
                  matched_selector: "main ul[role='list']",
                  selector_key: "connections_surface",
                  status: "pass"
                },
                {
                  description: "Connection profile entry",
                  matched_candidate_key: "connection-profile-link",
                  matched_candidate_rank: 0,
                  matched_selector: "main a[href*='/in/']",
                  selector_key: "connection_entry",
                  status: "pass"
                }
              ]
            }
          ],
          report_path: "/tmp/live-readonly/previous-report.json"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    try {
      await runCli([
        "node",
        "linkedin",
        "test:live",
        "--read-only",
        "--yes",
        "--json",
        "--session",
        "smoke"
      ]);

      const report = JSON.parse(
        String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "")
      ) as ReadOnlyValidationReport;

      expect(process.exitCode).toBe(1);
      expect(report).toMatchObject({
        blocked_request_count: 2,
        operation_count: 5,
        outcome: "fail",
        previous_report_path: "/tmp/live-readonly/previous-report.json",
        session: {
          session_name: "smoke"
        }
      });
      expect(report.summary).toContain(
        "Checked 5 read-only LinkedIn operations. 4 passed. 1 failed."
      );
      expect(report.summary).toContain("4 selector regressions detected");
      expect(report.request_limits).toMatchObject({
        max_requests_reached: false,
        used_requests: 5
      });
      expect(report.recommended_actions).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Review failed selector groups"),
          expect.stringContaining("Compare this run with /tmp/live-readonly/previous-report.json")
        ])
      );
      expect(report.diff.regressions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            change: "fallback_drift",
            operation: "feed",
            selector_key: "feed_surface"
          }),
          expect.objectContaining({
            change: "fallback_drift",
            operation: "feed",
            selector_key: "global_nav"
          }),
          expect.objectContaining({
            change: "new_failure",
            operation: "connections",
            selector_key: "connections_surface"
          }),
          expect.objectContaining({
            change: "new_failure",
            operation: "connections",
            selector_key: "connection_entry"
          })
        ])
      );

      expect(findOperation(report, "feed")).toMatchObject({
        status: "pass"
      });
      expect(findOperation(report, "feed").selector_results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            matched_candidate_key: "feed-data-urn",
            matched_candidate_rank: 1,
            selector_key: "feed_surface",
            status: "pass"
          }),
          expect.objectContaining({
            matched_candidate_key: "header-nav",
            matched_candidate_rank: 1,
            selector_key: "global_nav",
            status: "pass"
          })
        ])
      );
      expect(findOperation(report, "notifications")).toMatchObject({
        status: "pass"
      });
      expect(findOperation(report, "connections")).toMatchObject({
        failed_count: 2,
        status: "fail"
      });

      const persistedLatestReport = JSON.parse(
        await readFile(previousReportPath, "utf8")
      ) as ReadOnlyValidationReport;
      expect(persistedLatestReport.outcome).toBe("fail");
      expect(persistedLatestReport.report_path).toBe(report.report_path);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("formats auth failures cleanly when the stored session is missing or expired", async () => {
    setInteractiveMode(true, true);

    const assistantHome = await mkdtemp(
      path.join(os.tmpdir(), "linkedin-live-validation-auth-")
    );
    tempDirs.push(assistantHome);

    const { manifestPath, setName } = await createReplayFixtureSet(assistantHome, {
      setName: "auth",
      pages: [
        {
          bodyPath: "pages/feed.html",
          html: "<html><body>feed</body></html>",
          pageType: "feed",
          title: "Feed",
          url: FEED_URL
        }
      ],
      extraRoutes: [
        {
          bodyPath: "pages/login.html",
          html: "<html><body><form><input name=\"session_key\"></form></body></html>",
          url: LOGIN_URL
        }
      ]
    });

    enableReplay(manifestPath, setName);
    const replayServer = await core.ensureSharedFixtureReplayServer();
    if (!replayServer) {
      throw new Error("Expected the shared fixture replay server to start.");
    }
    browserMockState.replayBaseUrl = replayServer.baseUrl;
    browserMockState.redirects.set(FEED_URL, LOGIN_URL);

    await seedStoredSession(assistantHome, "smoke", false);

    await runCli([
      "node",
      "linkedin",
      "test",
      "live",
      "--read-only",
      "--yes",
      "--session",
      "smoke"
    ]);

    expect(process.exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain("Live validation failed [AUTH_REQUIRED]");
    expect(stderrChunks.join("")).toContain(
      'Stored LinkedIn session "smoke" is missing or expired while running feed.'
    );
  });
});
