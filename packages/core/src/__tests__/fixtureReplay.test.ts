import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REPLAY_ROUTE_PATH,
  attachFixtureReplayToContext,
  buildFixtureRouteKey,
  checkLinkedInFixtureStaleness,
  createEmptyFixtureManifest,
  ensureSharedFixtureReplayServer,
  getFixtureReplayEnvironment,
  isLinkedInFixtureReplayUrl,
  loadLinkedInFixtureSet,
  normalizeFixtureRouteHeaders,
  readLinkedInFixtureManifest,
  resolveFixtureManifestPath,
  shutdownSharedFixtureReplayServer,
  type LinkedInFixtureManifest,
  type LinkedInFixtureRoute,
  type LinkedInReplayPageType
} from "../fixtureReplay.js";

interface TestFixturePageEntry {
  htmlPath: string;
  pageType: LinkedInReplayPageType;
  recordedAt: string;
  title?: string;
  url: string;
}

interface CreateFixtureSetInput {
  capturedAt?: string;
  harBody?: Buffer | string;
  harPath?: string;
  locale?: string;
  manifestFormat?: number;
  pages?: Partial<Record<LinkedInReplayPageType, TestFixturePageEntry>>;
  responseFiles?: Record<string, Buffer | string>;
  rootDir?: string;
  routeFormat?: number;
  routes?: LinkedInFixtureRoute[];
  routesPath?: string;
  setName?: string;
}

interface CreatedFixtureSet {
  manifestPath: string;
  setName: string;
  setRootDir: string;
  tempDir: string;
}

interface TestReplayRoute {
  abort: ReturnType<typeof vi.fn>;
  continue: ReturnType<typeof vi.fn>;
  fulfill: ReturnType<typeof vi.fn>;
  request(): {
    method(): string;
    url(): string;
  };
}

const originalReplayEnabled = process.env.LINKEDIN_E2E_REPLAY;
const originalFixtureManifest = process.env.LINKEDIN_E2E_FIXTURE_MANIFEST;
const originalFixtureSet = process.env.LINKEDIN_E2E_FIXTURE_SET;
const originalFixtureServerUrl = process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL;

let tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeJsonFixture(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createFixtureSet(input: CreateFixtureSetInput = {}): Promise<CreatedFixtureSet> {
  const tempDir = await createTempDir("linkedin-fixture-replay-");
  const setName = input.setName ?? "ci";
  const rootDir = input.rootDir ?? setName;
  const routesPath = input.routesPath ?? "routes.json";
  const capturedAt = input.capturedAt ?? "2026-03-09T10:00:00.000Z";
  const manifestPath = path.join(tempDir, "manifest.json");
  const setRootDir = path.join(tempDir, rootDir);
  const pages = input.pages ?? {
    feed: {
      pageType: "feed",
      url: "https://www.linkedin.com/feed/",
      htmlPath: "pages/feed.html",
      recordedAt: capturedAt,
      title: "Feed"
    }
  };

  const manifest: LinkedInFixtureManifest = {
    format: input.manifestFormat ?? 1,
    updatedAt: capturedAt,
    defaultSetName: setName,
    sets: {
      [setName]: {
        setName,
        rootDir,
        locale: input.locale ?? "en-US",
        capturedAt,
        viewport: {
          width: 1440,
          height: 900
        },
        routesPath,
        ...(input.harPath ? { harPath: input.harPath } : {}),
        pages
      }
    }
  };

  await writeJsonFixture(manifestPath, manifest);
  await writeJsonFixture(path.join(setRootDir, routesPath), {
    format: input.routeFormat ?? 1,
    setName,
    routes: input.routes ?? []
  });

  for (const [relativePath, body] of Object.entries(input.responseFiles ?? {})) {
    const absolutePath = path.join(setRootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, body);
  }

  if (input.harPath && input.harBody !== undefined) {
    const absoluteHarPath = path.join(setRootDir, input.harPath);
    await mkdir(path.dirname(absoluteHarPath), { recursive: true });
    await writeFile(absoluteHarPath, input.harBody);
  }

  const providedResponsePaths = new Set(Object.keys(input.responseFiles ?? {}));
  for (const page of Object.values(pages)) {
    if (!page || providedResponsePaths.has(page.htmlPath)) {
      continue;
    }

    const absolutePagePath = path.join(setRootDir, page.htmlPath);
    await mkdir(path.dirname(absolutePagePath), { recursive: true });
    await writeFile(
      absolutePagePath,
      `<html><body>${page.pageType} fixture</body></html>`,
      "utf8"
    );
  }

  return {
    manifestPath,
    setName,
    setRootDir,
    tempDir
  };
}

function enableReplay(manifestPath: string, setName?: string): void {
  process.env.LINKEDIN_E2E_REPLAY = "1";
  process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = manifestPath;
  if (setName === undefined) {
    delete process.env.LINKEDIN_E2E_FIXTURE_SET;
  } else {
    process.env.LINKEDIN_E2E_FIXTURE_SET = setName;
  }
  delete process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL;
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

function createRouteMock(url: string, method: string = "GET"): TestReplayRoute {
  return {
    abort: vi.fn(async () => undefined),
    continue: vi.fn(async () => undefined),
    fulfill: vi.fn(async () => undefined),
    request: () => ({
      method: () => method,
      url: () => url
    })
  };
}

afterEach(async () => {
  shutdownSharedFixtureReplayServer();
  restoreFixtureReplayEnvironment();
  vi.restoreAllMocks();
  vi.resetModules();

  await Promise.all(
    tempDirs.map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    })
  );
  tempDirs = [];
});

describe("fixtureReplay helpers", () => {
  it("normalizes route keys before replay lookup", () => {
    expect(
      buildFixtureRouteKey({
        method: "get",
        url: "https://www.linkedin.com/jobs/search/?location=Copenhagen&keywords=software%20engineer#results"
      })
    ).toBe(
      buildFixtureRouteKey({
        method: "GET",
        url: "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen"
      })
    );
  });

  it("normalizes response headers and strips unsafe transfer metadata", () => {
    expect(
      normalizeFixtureRouteHeaders({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": "123",
        "Content-Encoding": "gzip",
        "Transfer-Encoding": "chunked",
        "X-Trace-Id": "fixture-1"
      })
    ).toEqual({
      "content-type": "application/json; charset=utf-8",
      "x-trace-id": "fixture-1"
    });
  });

  it("matches only real linkedin and licdn replay targets", () => {
    expect(isLinkedInFixtureReplayUrl("https://www.linkedin.com/feed/")).toBe(true);
    expect(isLinkedInFixtureReplayUrl("https://media.licdn.com/dms/image/foo")).toBe(true);
    expect(isLinkedInFixtureReplayUrl("https://static.linkedin.com/sc/h/app.js")).toBe(true);
    expect(isLinkedInFixtureReplayUrl("https://evil-linkedin.com/feed/")).toBe(false);
    expect(isLinkedInFixtureReplayUrl("https://examplelicdn.com/media/image")).toBe(false);
    expect(isLinkedInFixtureReplayUrl("https://example.com/feed/")).toBe(false);
    expect(isLinkedInFixtureReplayUrl("data:text/html,fixture")).toBe(false);
  });
});

describe("fixtureReplay manifests and staleness", () => {
  it("loads fixture sets from env-resolved manifests and special-character paths", async () => {
    const fixtureSet = await createFixtureSet({
      setName: "manual ø",
      rootDir: "fixture set/ø-zone",
      routes: [
        {
          method: "GET",
          url: "https://www.linkedin.com/feed/",
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          },
          bodyPath: "responses/feed snapshot.html"
        },
        {
          method: "POST",
          url: "https://www.linkedin.com/voyager/api/graphql?b=2&a=1",
          status: 201,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          },
          bodyText: '{"ok":true}'
        }
      ],
      responseFiles: {
        "responses/feed snapshot.html": "<html><body>fixture</body></html>"
      }
    });

    process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = fixtureSet.manifestPath;

    expect(resolveFixtureManifestPath()).toBe(path.resolve(fixtureSet.manifestPath));
    expect(createEmptyFixtureManifest({ defaultSetName: fixtureSet.setName })).toMatchObject({
      defaultSetName: fixtureSet.setName,
      sets: {}
    });
    expect(getFixtureReplayEnvironment()).toMatchObject({
      enabled: false,
      manifestPath: path.resolve(fixtureSet.manifestPath)
    });

    const manifest = await readLinkedInFixtureManifest(fixtureSet.manifestPath);
    const loadedSet = await loadLinkedInFixtureSet(
      fixtureSet.manifestPath,
      fixtureSet.setName
    );

    expect(manifest.defaultSetName).toBe(fixtureSet.setName);
    expect(loadedSet.baseDir).toBe(path.resolve(fixtureSet.setRootDir));
    expect(loadedSet.routes).toHaveLength(2);
    expect(loadedSet.routes[0]?.bodyPath).toBe("responses/feed snapshot.html");
    expect(loadedSet.routes[1]?.bodyText).toBe('{"ok":true}');
  });

  it("validates externally managed replay server URLs before startup", async () => {
    process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL = "not-a-url";

    expect(() => getFixtureReplayEnvironment()).toThrow(
      "LINKEDIN_E2E_FIXTURE_SERVER_URL must be an absolute http(s) URL."
    );
  });

  it("rejects empty and corrupt fixture manifests", async () => {
    const tempDir = await createTempDir("linkedin-fixture-empty-");
    const emptyManifestPath = path.join(tempDir, "empty-manifest.json");
    const corruptManifestPath = path.join(tempDir, "corrupt-manifest.json");

    await writeJsonFixture(emptyManifestPath, createEmptyFixtureManifest());
    await writeFile(corruptManifestPath, "{\n  not-json\n", "utf8");

    await expect(loadLinkedInFixtureSet(emptyManifestPath)).rejects.toThrow(
      "does not define any sets"
    );
    await expect(readLinkedInFixtureManifest(corruptManifestPath)).rejects.toThrow();
  });

  it("rejects malformed route files, duplicate route keys, and missing response bodies", async () => {
    const malformedFixtureSet = await createFixtureSet();
    await writeJsonFixture(path.join(malformedFixtureSet.setRootDir, "routes.json"), {
      format: 1,
      setName: malformedFixtureSet.setName,
      routes: {
        invalid: true
      }
    });

    await expect(
      loadLinkedInFixtureSet(malformedFixtureSet.manifestPath, malformedFixtureSet.setName)
    ).rejects.toThrow("routes must be an array");

    const missingBodyFixtureSet = await createFixtureSet({
      routes: [
        {
          method: "GET",
          url: "https://www.linkedin.com/feed/",
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          },
          bodyPath: "responses/missing.html"
        }
      ]
    });

    enableReplay(missingBodyFixtureSet.manifestPath, missingBodyFixtureSet.setName);

    await expect(ensureSharedFixtureReplayServer()).rejects.toThrow("does not exist");

    const duplicateRouteFixtureSet = await createFixtureSet({
      routes: [
        {
          method: "GET",
          url: "https://www.linkedin.com/jobs/search/?location=Copenhagen&keywords=software%20engineer",
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          },
          bodyText: '{"variant":1}'
        },
        {
          method: "GET",
          url: "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen",
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          },
          bodyText: '{"variant":2}'
        }
      ]
    });

    await expect(
      loadLinkedInFixtureSet(duplicateRouteFixtureSet.manifestPath, duplicateRouteFixtureSet.setName)
    ).rejects.toThrow("duplicates replay key");
  });

  it("rejects replay route body paths that escape the fixture set directory", async () => {
    const fixtureSet = await createFixtureSet({
      routes: [
        {
          method: "GET",
          url: "https://www.linkedin.com/feed/",
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          },
          bodyPath: "../outside.html"
        }
      ]
    });

    enableReplay(fixtureSet.manifestPath, fixtureSet.setName);

    await expect(ensureSharedFixtureReplayServer()).rejects.toThrow(
      "must stay within"
    );
  });

  it("rejects invalid timestamps, inconsistent route metadata, and missing page files", async () => {
    const invalidTimestampFixtureSet = await createFixtureSet({
      pages: {
        feed: {
          pageType: "feed",
          url: "https://www.linkedin.com/feed/",
          htmlPath: "pages/feed.html",
          recordedAt: "not-a-date",
          title: "Feed"
        }
      }
    });

    await expect(readLinkedInFixtureManifest(invalidTimestampFixtureSet.manifestPath)).rejects.toThrow(
      "valid ISO-8601 timestamp"
    );

    const routeSetMismatchFixtureSet = await createFixtureSet();
    await writeJsonFixture(path.join(routeSetMismatchFixtureSet.setRootDir, "routes.json"), {
      format: 1,
      setName: "other-set",
      routes: []
    });

    await expect(
      loadLinkedInFixtureSet(
        routeSetMismatchFixtureSet.manifestPath,
        routeSetMismatchFixtureSet.setName
      )
    ).rejects.toThrow("declares setName other-set");

    const missingPageFixtureSet = await createFixtureSet();
    await rm(path.join(missingPageFixtureSet.setRootDir, "pages/feed.html"));

    await expect(
      loadLinkedInFixtureSet(missingPageFixtureSet.manifestPath, missingPageFixtureSet.setName)
    ).rejects.toThrow("Fixture page HTML");
  });

  it("rejects rootDir, routesPath, and page htmlPath traversal", async () => {
    const tempDir = await createTempDir("linkedin-fixture-traversal-");
    const manifestPath = path.join(tempDir, "manifest.json");
    const capturedAt = "2026-03-09T10:00:00.000Z";

    await writeJsonFixture(manifestPath, {
      format: 1,
      updatedAt: capturedAt,
      defaultSetName: "ci",
      sets: {
        ci: {
          setName: "ci",
          rootDir: "../outside",
          locale: "en-US",
          capturedAt,
          viewport: {
            width: 1440,
            height: 900
          },
          routesPath: "routes.json",
          pages: {}
        }
      }
    } satisfies LinkedInFixtureManifest);

    await expect(loadLinkedInFixtureSet(manifestPath, "ci")).rejects.toThrow("rootDir");

    const setRootDir = path.join(tempDir, "ci");
    await mkdir(setRootDir, { recursive: true });
    await writeJsonFixture(path.join(setRootDir, "routes.json"), {
      format: 1,
      setName: "ci",
      routes: []
    });

    await writeJsonFixture(manifestPath, {
      format: 1,
      updatedAt: capturedAt,
      defaultSetName: "ci",
      sets: {
        ci: {
          setName: "ci",
          rootDir: "ci",
          locale: "en-US",
          capturedAt,
          viewport: {
            width: 1440,
            height: 900
          },
          routesPath: "../routes.json",
          pages: {}
        }
      }
    } satisfies LinkedInFixtureManifest);

    await expect(loadLinkedInFixtureSet(manifestPath, "ci")).rejects.toThrow("routesPath");

    await writeJsonFixture(manifestPath, {
      format: 1,
      updatedAt: capturedAt,
      defaultSetName: "ci",
      sets: {
        ci: {
          setName: "ci",
          rootDir: "ci",
          locale: "en-US",
          capturedAt,
          viewport: {
            width: 1440,
            height: 900
          },
          routesPath: "routes.json",
          pages: {
            feed: {
              pageType: "feed",
              url: "https://www.linkedin.com/feed/",
              htmlPath: "../pages/feed.html",
              recordedAt: capturedAt,
              title: "Feed"
            }
          }
        }
      }
    } satisfies LinkedInFixtureManifest);

    await expect(loadLinkedInFixtureSet(manifestPath, "ci")).rejects.toThrow("htmlPath");
  });

  it("warns on stale empty sets", async () => {
    const emptyFixtureSet = await createFixtureSet({
      capturedAt: "2025-01-01T00:00:00.000Z",
      pages: {}
    });

    const emptyWarnings = await checkLinkedInFixtureStaleness(emptyFixtureSet.manifestPath, {
      maxAgeDays: 30
    });

    expect(emptyWarnings).toHaveLength(1);
    expect(emptyWarnings[0]).toMatchObject({
      setName: emptyFixtureSet.setName
    });
    expect(emptyWarnings[0]).not.toHaveProperty("pageType");
    await expect(
      checkLinkedInFixtureStaleness(emptyFixtureSet.manifestPath, {
        setName: "missing",
        maxAgeDays: 30
      })
    ).rejects.toThrow(
      `Fixture set missing is not defined in ${emptyFixtureSet.manifestPath}. Available fixture sets: ${emptyFixtureSet.setName}.`
    );
  });
});

describe("fixtureReplay server", () => {
  it("starts one shared server for concurrent callers and serves concurrent lookups", async () => {
    const largeBody = JSON.stringify({
      payload: "x".repeat(256 * 1024)
    });
    const fixtureSet = await createFixtureSet({
      routes: [
        {
          method: "GET",
          url: "https://www.linkedin.com/feed/",
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          },
          bodyText: "<html><body>feed fixture</body></html>"
        },
        {
          method: "GET",
          url: "https://www.linkedin.com/voyager/api/graphql?queryId=fixture.large&variables=%7B%22start%22%3A0%7D",
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          },
          bodyPath: "responses/large payload.json"
        }
      ],
      responseFiles: {
        "responses/large payload.json": largeBody
      }
    });

    enableReplay(fixtureSet.manifestPath, fixtureSet.setName);

    const [firstServer, secondServer, thirdServer] = await Promise.all([
      ensureSharedFixtureReplayServer(),
      ensureSharedFixtureReplayServer(),
      ensureSharedFixtureReplayServer()
    ]);
    const reusedServer = await ensureSharedFixtureReplayServer();

    expect(firstServer?.baseUrl).toBe(secondServer?.baseUrl);
    expect(firstServer?.baseUrl).toBe(thirdServer?.baseUrl);
    expect(reusedServer).toBe(firstServer);

    const postResponse = await fetch(`${firstServer?.baseUrl}${REPLAY_ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        method: "GET",
        url: "https://www.linkedin.com/feed/"
      })
    });

    expect(postResponse.status).toBe(200);
    expect(await postResponse.text()).toContain("feed fixture");

    const replayLookupUrl =
      `${firstServer?.baseUrl}${REPLAY_ROUTE_PATH}` +
      "?method=GET&url=" +
      encodeURIComponent(
        "https://www.linkedin.com/voyager/api/graphql?queryId=fixture.large&variables=%7B%22start%22%3A0%7D"
      );

    const concurrentBodies = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const response = await fetch(replayLookupUrl);
        return {
          body: await response.text(),
          status: response.status
        };
      })
    );

    expect(concurrentBodies.every((entry) => entry.status === 200)).toBe(true);
    expect(concurrentBodies.every((entry) => entry.body === largeBody)).toBe(true);
  });

  it("returns structured fixture misses, request parsing failures, and request-size limits", async () => {
    const fixtureSet = await createFixtureSet();
    enableReplay(fixtureSet.manifestPath, fixtureSet.setName);

    const replayServer = await ensureSharedFixtureReplayServer();
    const missingRouteResponse = await fetch(`${replayServer?.baseUrl}${REPLAY_ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        method: "GET",
        url: "https://www.linkedin.com/does-not-exist/"
      })
    });
    const malformedPayloadResponse = await fetch(
      `${replayServer?.baseUrl}${REPLAY_ROUTE_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{"
      }
    );
    const unknownPathResponse = await fetch(`${replayServer?.baseUrl}/not-found`);

    expect(missingRouteResponse.status).toBe(404);
    expect(await missingRouteResponse.json()).toMatchObject({
      error: "fixture_not_found",
      method: "GET",
      url: "https://www.linkedin.com/does-not-exist/"
    });

    expect(malformedPayloadResponse.status).toBe(400);
    expect(await malformedPayloadResponse.json()).toMatchObject({
      error: "fixture_replay_invalid_request"
    });

    const oversizedPayloadResponse = await fetch(`${replayServer?.baseUrl}${REPLAY_ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body:
        '{"method":"GET","url":"https://www.linkedin.com/feed/","pad":"' +
        "x".repeat(70_000) +
        '"}'
    });

    expect(oversizedPayloadResponse.status).toBe(413);
    expect(await oversizedPayloadResponse.json()).toMatchObject({
      error: "fixture_replay_request_too_large"
    });

    expect(unknownPathResponse.status).toBe(404);
    expect(await unknownPathResponse.json()).toEqual({
      error: "not_found"
    });
  });

  it("returns structured errors when fixture bodies disappear after server startup", async () => {
    const fixtureSet = await createFixtureSet({
      routes: [
        {
          method: "GET",
          url: "https://www.linkedin.com/feed/",
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          },
          bodyPath: "responses/feed.html"
        }
      ],
      responseFiles: {
        "responses/feed.html": "<html><body>fixture</body></html>"
      }
    });
    enableReplay(fixtureSet.manifestPath, fixtureSet.setName);

    const replayServer = await ensureSharedFixtureReplayServer();
    await rm(path.join(fixtureSet.setRootDir, "responses/feed.html"));

    const replayResponse = await fetch(`${replayServer?.baseUrl}${REPLAY_ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        method: "GET",
        url: "https://www.linkedin.com/feed/"
      })
    });

    expect(replayResponse.status).toBe(500);
    expect(await replayResponse.json()).toMatchObject({
      error: "fixture_replay_error",
      message: expect.stringContaining("does not exist")
    });
  });

  it("uses an externally managed replay server when configured", async () => {
    const fixtureSet = await createFixtureSet({
      setName: "external"
    });

    process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = fixtureSet.manifestPath;
    process.env.LINKEDIN_E2E_FIXTURE_SET = fixtureSet.setName;
    process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL = " http://127.0.0.1:45555 ";
    delete process.env.LINKEDIN_E2E_REPLAY;

    expect(getFixtureReplayEnvironment()).toMatchObject({
      enabled: true,
      manifestPath: path.resolve(fixtureSet.manifestPath),
      serverUrl: "http://127.0.0.1:45555",
      setName: fixtureSet.setName
    });

    const replayServer = await ensureSharedFixtureReplayServer();

    expect(replayServer).toMatchObject({
      baseUrl: "http://127.0.0.1:45555",
      manifestPath: fixtureSet.manifestPath,
      setName: fixtureSet.setName
    });
  });

  it("surfaces replay server startup failures such as port conflicts", async () => {
    const fixtureSet = await createFixtureSet();
    enableReplay(fixtureSet.manifestPath, fixtureSet.setName);

    let errorHandler: ((error: Error) => void) | undefined;
    const fakeServer = {
      address: vi.fn(() => null),
      close: vi.fn(),
      listen: vi.fn(() => {
        errorHandler?.(
          Object.assign(
            new Error("listen EADDRINUSE: address already in use 127.0.0.1"),
            {
              code: "EADDRINUSE"
            }
          )
        );
        return fakeServer;
      }),
      once: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") {
          errorHandler = handler;
        }
        return fakeServer;
      }),
      removeListener: vi.fn(() => fakeServer),
      unref: vi.fn()
    };

    vi.doMock("node:http", async () => {
      const actual = await vi.importActual<typeof import("node:http")>("node:http");
      return {
        ...actual,
        createServer: vi.fn(() => fakeServer)
      };
    });

    const fixtureReplayModule = await import("../fixtureReplay.js");

    await expect(fixtureReplayModule.ensureSharedFixtureReplayServer()).rejects.toThrow(
      "EADDRINUSE"
    );

    fixtureReplayModule.shutdownSharedFixtureReplayServer();
    vi.doUnmock("node:http");
  });
});

describe("fixtureReplay browser routing", () => {
  it("returns undefined without mutating browser contexts when replay is disabled", async () => {
    delete process.env.LINKEDIN_E2E_REPLAY;
    delete process.env.LINKEDIN_E2E_FIXTURE_MANIFEST;
    delete process.env.LINKEDIN_E2E_FIXTURE_SET;
    delete process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL;

    const context = {
      addInitScript: vi.fn(async () => undefined),
      route: vi.fn(async () => undefined)
    };

    const replayServer = await attachFixtureReplayToContext(
      context as unknown as BrowserContext
    );

    expect(replayServer).toBeUndefined();
    expect(context.addInitScript).not.toHaveBeenCalled();
    expect(context.route).not.toHaveBeenCalled();
  });

  it("attaches replay routing to browser contexts and fails closed for third-party traffic", async () => {
    const fixtureSet = await createFixtureSet({
      routes: [
        {
          method: "GET",
          url: "https://www.linkedin.com/feed/",
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-Fixture": "feed"
          },
          bodyText: "<html><body>feed fixture</body></html>"
        }
      ]
    });
    enableReplay(fixtureSet.manifestPath, fixtureSet.setName);

    let routeHandler: ((route: TestReplayRoute) => Promise<void>) | undefined;
    const context = {
      addInitScript: vi.fn(async () => undefined),
      route: vi.fn(async (_matcher: string, handler: (route: TestReplayRoute) => Promise<void>) => {
        routeHandler = handler;
      })
    };

    const replayServer = await attachFixtureReplayToContext(
      context as unknown as BrowserContext
    );
    if (!routeHandler || !replayServer) {
      throw new Error("Fixture replay route handler was not attached.");
    }

    expect(context.addInitScript).toHaveBeenCalledTimes(1);
    expect(context.route).toHaveBeenCalledWith("**/*", expect.any(Function));

    const dataRoute = createRouteMock("data:text/html,fixture");
    const replayOriginRoute = createRouteMock(`${replayServer.baseUrl}${REPLAY_ROUTE_PATH}`);
    const thirdPartyRoute = createRouteMock("https://example.com/app.js");
    const linkedInRoute = createRouteMock("https://www.linkedin.com/feed/");

    await routeHandler(dataRoute);
    await routeHandler(replayOriginRoute);
    await routeHandler(thirdPartyRoute);
    await routeHandler(linkedInRoute);

    expect(dataRoute.continue).toHaveBeenCalledTimes(1);
    expect(replayOriginRoute.continue).toHaveBeenCalledTimes(1);
    expect(thirdPartyRoute.abort).toHaveBeenCalledTimes(1);
    expect(linkedInRoute.fulfill).toHaveBeenCalledTimes(1);
    expect(linkedInRoute.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        headers: expect.objectContaining({
          "content-type": "text/html; charset=utf-8",
          "x-fixture": "feed"
        })
      })
    );

    const fulfilledBody = linkedInRoute.fulfill.mock.calls[0]?.[0]?.body;
    expect(fulfilledBody).toEqual(Buffer.from("<html><body>feed fixture</body></html>"));
  });

  it("returns structured route failures when the configured replay server is unreachable", async () => {
    const fixtureSet = await createFixtureSet({
      setName: "remote"
    });

    process.env.LINKEDIN_E2E_FIXTURE_MANIFEST = fixtureSet.manifestPath;
    process.env.LINKEDIN_E2E_FIXTURE_SET = fixtureSet.setName;
    process.env.LINKEDIN_E2E_FIXTURE_SERVER_URL = "http://127.0.0.1:1";
    delete process.env.LINKEDIN_E2E_REPLAY;

    let routeHandler: ((route: TestReplayRoute) => Promise<void>) | undefined;
    const context = {
      addInitScript: vi.fn(async () => undefined),
      route: vi.fn(async (_matcher: string, handler: (route: TestReplayRoute) => Promise<void>) => {
        routeHandler = handler;
      })
    };

    await attachFixtureReplayToContext(context as unknown as BrowserContext);
    if (!routeHandler) {
      throw new Error("Fixture replay route handler was not attached.");
    }

    const linkedInRoute = createRouteMock("https://www.linkedin.com/feed/");

    await routeHandler(linkedInRoute);

    expect(linkedInRoute.fulfill).toHaveBeenCalledTimes(1);
    expect(linkedInRoute.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 502,
        headers: {
          "content-type": "application/json; charset=utf-8"
        }
      })
    );

    const fulfilledBody = linkedInRoute.fulfill.mock.calls[0]?.[0]?.body;
    expect(JSON.parse(String(fulfilledBody))).toMatchObject({
      error: "fixture_replay_unavailable"
    });
  });
});
