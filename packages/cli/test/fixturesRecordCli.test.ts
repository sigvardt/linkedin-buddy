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

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });

  if (!resolveFn) {
    throw new Error("Deferred promise did not initialize its resolver.");
  }

  return {
    promise,
    resolve: resolveFn
  };
}

function createFixtureResponse(
  url: string,
  body: Promise<Buffer>
): TestFixtureCaptureResponse {
  return {
    body: async () => await body,
    headers: () => ({
      "Content-Length": "15",
      "Content-Type": "application/json; charset=utf-8"
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
});
