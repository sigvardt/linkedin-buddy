import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import type { BrowserContext } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readlineMocks = vi.hoisted(() => ({
  close: vi.fn(),
  createInterface: vi.fn(),
  question: vi.fn(async () => "")
}));

vi.mock("@linkedin-assistant/core", async () =>
  await import("../../core/src/index.js")
);

vi.mock("node:readline/promises", () => ({
  createInterface: readlineMocks.createInterface.mockImplementation(() => ({
    close: readlineMocks.close,
    question: readlineMocks.question
  }))
}));

import * as core from "@linkedin-assistant/core";
import { runCli } from "../src/bin/linkedin.js";

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
}

interface FixtureRecordRouteFile {
  routes: Array<{
    bodyPath?: string;
    url: string;
  }>;
}

interface TestFixtureCaptureResponse {
  body(): Promise<Buffer>;
  headers(): Record<string, string>;
  request(): {
    method(): string;
  };
  status(): number;
  url(): string;
}

const originalReplayEnabled = process.env.LINKEDIN_E2E_REPLAY;
const originalFixtureManifest = process.env.LINKEDIN_E2E_FIXTURE_MANIFEST;
const originalFixtureSet = process.env.LINKEDIN_E2E_FIXTURE_SET;
const originalFixtureServerUrl = process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL;

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = (error: Error) => {
      reject(error);
    };
  });

  promise.catch(() => undefined);

  if (!resolveFn || !rejectFn) {
    throw new Error("Deferred promise did not initialize its resolvers.");
  }

  return {
    promise,
    reject: rejectFn,
    resolve: resolveFn
  };
}

function createFixtureResponse(
  url: string,
  body: Promise<Buffer>,
  contentType: string = "application/json; charset=utf-8"
): TestFixtureCaptureResponse {
  return {
    body: async () => await body,
    headers: () => ({
      "Content-Length": "15",
      "Content-Type": contentType
    }),
    request: () => ({
      method: () => "GET"
    }),
    status: () => 200,
    url: () => url
  };
}

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

function restoreFixtureReplayEnvironment(): void {
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

  if (originalFixtureServerUrl === undefined) {
    delete process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL;
  } else {
    process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL = originalFixtureServerUrl;
  }
}

describe("linkedin fixtures record", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-fixture-record-"));
    process.exitCode = undefined;
    setInteractiveMode(true, true);
    vi.clearAllMocks();
    readlineMocks.createInterface.mockImplementation(() => ({
      close: readlineMocks.close,
      question: readlineMocks.question
    }));
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    process.exitCode = undefined;
    restoreFixtureReplayEnvironment();
    core.shutdownSharedFixtureReplayServer();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("assigns unique response files when fixture captures resolve out of order", async () => {
    const firstBody = createDeferred<Buffer>();
    const secondBody = createDeferred<Buffer>();
    const manifestPath = path.join(tempDir, "manifest.json");
    let responseHandler:
      | ((response: TestFixtureCaptureResponse) => void)
      | undefined;

    const fakePage = {
      content: vi.fn(async () => "<html><body>Fixture</body></html>"),
      evaluate: vi.fn(async () => "en-US"),
      goto: vi.fn(async () => {
        responseHandler?.(
          createFixtureResponse(
            "https://www.linkedin.com/voyager/api/graphql?queryId=feed.fixture&variables=%7B%22start%22%3A0%7D",
            firstBody.promise
          )
        );
        responseHandler?.(
          createFixtureResponse(
            "https://www.linkedin.com/voyager/api/graphql?queryId=profile.fixture&variables=%7B%22start%22%3A0%7D",
            secondBody.promise
          )
        );
        secondBody.resolve(Buffer.from('{"fixture":"second"}', "utf8"));
        firstBody.resolve(Buffer.from('{"fixture":"first"}', "utf8"));
      }),
      title: vi.fn(async () => "Feed"),
      url: vi.fn(() => "https://www.linkedin.com/feed/"),
      viewportSize: vi.fn(() => ({
        height: 900,
        width: 1440
      })),
      waitForTimeout: vi.fn(async () => undefined)
    };
    const fakeContext = {
      addInitScript: vi.fn(),
      newPage: vi.fn(async () => fakePage),
      on: vi.fn((event: string, handler: (response: TestFixtureCaptureResponse) => void) => {
        if (event === "response") {
          responseHandler = handler;
        }
      }),
      pages: vi.fn(() => [fakePage]),
      route: vi.fn()
    };
    const runWithPersistentContextSpy = vi
      .spyOn(core.ProfileManager.prototype, "runWithPersistentContext")
      .mockImplementation(async (_profileName, _options, callback) => {
        return await callback(fakeContext as unknown as BrowserContext);
      });

    try {
      await runCli([
        "node",
        "linkedin",
        "fixtures",
        "record",
        "--manifest",
        manifestPath,
        "--set",
        "manual",
        "--page",
        "feed",
        "--no-har"
      ]);
    } finally {
      runWithPersistentContextSpy.mockRestore();
    }

    const routeFile = JSON.parse(
      await readFile(path.join(tempDir, "manual", "routes.json"), "utf8")
    ) as FixtureRecordRouteFile;

    expect(routeFile.routes).toHaveLength(2);
    expect(routeFile.routes.map((route) => route.url)).toEqual([
      "https://www.linkedin.com/voyager/api/graphql?queryId=feed.fixture&variables=%7B%22start%22%3A0%7D",
      "https://www.linkedin.com/voyager/api/graphql?queryId=profile.fixture&variables=%7B%22start%22%3A0%7D"
    ]);
    expect(routeFile.routes.map((route) => route.bodyPath)).toEqual([
      "responses/0001-www.linkedin.com-voyager-api-graphql.json",
      "responses/0002-www.linkedin.com-voyager-api-graphql.json"
    ]);
  });

  it("restores replay environment variables when manual capture fails", async () => {
    const manifestPath = path.join(tempDir, "manifest.json");
    process.env.LINKEDIN_E2E_REPLAY = "1";
    process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = "/tmp/original-manifest.json";
    process.env.LINKEDIN_E2E_FIXTURE_SET = "original-set";
    process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL = "http://127.0.0.1:45555";

    const runWithPersistentContextSpy = vi
      .spyOn(core.ProfileManager.prototype, "runWithPersistentContext")
      .mockImplementation(async () => {
        expect(process.env.LINKEDIN_E2E_REPLAY).toBeUndefined();
        expect(process.env.LINKEDIN_E2E_FIXTURE_MANIFEST).toBeUndefined();
        expect(process.env.LINKEDIN_E2E_FIXTURE_SET).toBeUndefined();
        expect(process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL).toBeUndefined();
        throw new Error("capture failed");
      });

    try {
      await expect(
        runCli([
          "node",
          "linkedin",
          "fixtures",
          "record",
          "--manifest",
          manifestPath,
          "--set",
          "manual",
          "--page",
          "feed",
          "--no-har"
        ])
      ).rejects.toThrow("capture failed");
    } finally {
      runWithPersistentContextSpy.mockRestore();
    }

    expect(process.env.LINKEDIN_E2E_REPLAY).toBe("1");
    expect(process.env.LINKEDIN_E2E_FIXTURE_MANIFEST).toBe("/tmp/original-manifest.json");
    expect(process.env.LINKEDIN_E2E_FIXTURE_SET).toBe("original-set");
    expect(process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL).toBe("http://127.0.0.1:45555");
  });

  it("rejects non-numeric viewport flags before recording starts", async () => {
    await expect(
      runCli([
        "node",
        "linkedin",
        "fixtures",
        "record",
        "--page",
        "feed",
        "--width",
        "1440px"
      ])
    ).rejects.toThrow("width must be a positive integer.");

    await expect(
      runCli([
        "node",
        "linkedin",
        "fixtures",
        "record",
        "--page",
        "feed",
        "--height",
        "900px"
      ])
    ).rejects.toThrow("height must be a positive integer.");
  });

  it("fails fast when --page resolves to an empty selection", async () => {
    await expect(
      runCli([
        "node",
        "linkedin",
        "fixtures",
        "record",
        "--page",
        ","
      ])
    ).rejects.toThrow("page must include at least one page type when --page is provided.");
  });

  it("writes empty fallback bodies and ignores non-linkedin responses", async () => {
    const manifestPath = path.join(tempDir, "manifest.json");
    let responseHandler:
      | ((response: TestFixtureCaptureResponse) => void)
      | undefined;

    const failingBody = createDeferred<Buffer>();
    const fakePage = {
      content: vi.fn(async () => "<html><body>Fixture</body></html>"),
      evaluate: vi.fn(async () => "en-US"),
      goto: vi.fn(async () => {
        responseHandler?.(
          createFixtureResponse(
            "https://example.com/not-captured.json",
            Promise.resolve(Buffer.from('{"ignore":true}', "utf8"))
          )
        );
        responseHandler?.(
          createFixtureResponse(
            "https://www.linkedin.com/voyager/api/graphql?queryId=feed.partial&variables=%7B%22start%22%3A0%7D",
            failingBody.promise
          )
        );
        failingBody.reject(new Error("socket hang up"));
      }),
      title: vi.fn(async () => "Feed"),
      url: vi.fn(() => "https://www.linkedin.com/feed/"),
      viewportSize: vi.fn(() => ({
        height: 900,
        width: 1440
      })),
      waitForTimeout: vi.fn(async () => undefined)
    };
    const fakeContext = {
      addInitScript: vi.fn(),
      newPage: vi.fn(async () => fakePage),
      on: vi.fn((event: string, handler: (response: TestFixtureCaptureResponse) => void) => {
        if (event === "response") {
          responseHandler = handler;
        }
      }),
      pages: vi.fn(() => [fakePage]),
      route: vi.fn()
    };
    const runWithPersistentContextSpy = vi
      .spyOn(core.ProfileManager.prototype, "runWithPersistentContext")
      .mockImplementation(async (_profileName, _options, callback) => {
        return await callback(fakeContext as unknown as BrowserContext);
      });

    try {
      await runCli([
        "node",
        "linkedin",
        "fixtures",
        "record",
        "--manifest",
        manifestPath,
        "--set",
        "manual",
        "--page",
        "feed",
        "--no-har"
      ]);
    } finally {
      runWithPersistentContextSpy.mockRestore();
    }

    const routeFile = JSON.parse(
      await readFile(path.join(tempDir, "manual", "routes.json"), "utf8")
    ) as FixtureRecordRouteFile;
    const savedBodyPath = routeFile.routes[0]?.bodyPath;

    expect(routeFile.routes).toHaveLength(1);
    expect(routeFile.routes[0]?.url).toBe(
      "https://www.linkedin.com/voyager/api/graphql?queryId=feed.partial&variables=%7B%22start%22%3A0%7D"
    );
    if (!savedBodyPath) {
      throw new Error("Expected a recorded response body path.");
    }

    const savedBody = await readFile(path.join(tempDir, "manual", savedBodyPath));
    expect(savedBody).toHaveLength(0);
  });

  it("records fixtures that can be replayed end-to-end", async () => {
    const manifestPath = path.join(tempDir, "manifest.json");
    const setName = "manual ø";
    const feedHtml = "<html><body>Recorded feed</body></html>";
    let responseHandler:
      | ((response: TestFixtureCaptureResponse) => void)
      | undefined;

    const fakePage = {
      content: vi.fn(async () => feedHtml),
      evaluate: vi.fn(async () => "da-DK"),
      goto: vi.fn(async () => {
        responseHandler?.(
          createFixtureResponse(
            "https://www.linkedin.com/feed/",
            Promise.resolve(Buffer.from(feedHtml, "utf8")),
            "text/html; charset=utf-8"
          )
        );
      }),
      title: vi.fn(async () => "Feed"),
      url: vi.fn(() => "https://www.linkedin.com/feed/"),
      viewportSize: vi.fn(() => ({
        height: 900,
        width: 1440
      })),
      waitForTimeout: vi.fn(async () => undefined)
    };
    const fakeContext = {
      addInitScript: vi.fn(),
      newPage: vi.fn(async () => fakePage),
      on: vi.fn((event: string, handler: (response: TestFixtureCaptureResponse) => void) => {
        if (event === "response") {
          responseHandler = handler;
        }
      }),
      pages: vi.fn(() => [fakePage]),
      route: vi.fn()
    };
    const runWithPersistentContextSpy = vi
      .spyOn(core.ProfileManager.prototype, "runWithPersistentContext")
      .mockImplementation(async (_profileName, _options, callback) => {
        return await callback(fakeContext as unknown as BrowserContext);
      });

    try {
      await runCli([
        "node",
        "linkedin",
        "fixtures",
        "record",
        "--manifest",
        manifestPath,
        "--set",
        setName,
        "--page",
        "feed",
        "--no-har"
      ]);
    } finally {
      runWithPersistentContextSpy.mockRestore();
    }

    process.env.LINKEDIN_E2E_REPLAY = "1";
    process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = manifestPath;
    process.env.LINKEDIN_E2E_FIXTURE_SET = setName;

    const replayServer = await core.ensureSharedFixtureReplayServer();
    const response = await fetch(`${replayServer?.baseUrl}${core.REPLAY_ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        method: "GET",
        url: "https://www.linkedin.com/feed/"
      })
    });

    expect(replayServer).toMatchObject({
      setName
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Recorded feed");
  });
});
