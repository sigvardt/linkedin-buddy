import { mkdtempSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedInBuddyError } from "../errors.js";
import {
  buildUpdateCommand,
  checkForUpdate,
  DEFAULT_UPDATE_CHECK_CACHE_TTL_MS,
  detectInstallMethod,
  fetchLatestVersion,
  isNewerVersion,
  LINKEDIN_BUDDY_UPDATE_CHECK_ENV,
  NPM_REGISTRY_BASE_URL,
  readUpdateCheckCache,
  resolveUpdateCheckConfig,
  UPDATE_CHECK_PACKAGE_NAME,
  writeUpdateCheckCache
} from "../updateCheck.js";

const ORIGINAL_ARGV = [...process.argv];

let server: Server | null = null;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.argv = [...ORIGINAL_ARGV];

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server = null;
  }
});

beforeEach(() => {
  vi.restoreAllMocks();
});

async function startServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse<IncomingMessage>
  ) => void
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an AddressInfo object.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function stubNpmFetch(baseUrl: string): void {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: Record<string, unknown>) => {
    const sourceUrl =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : input;
    if (sourceUrl.startsWith(NPM_REGISTRY_BASE_URL)) {
      const redirectedUrl = `${baseUrl}${sourceUrl.slice(NPM_REGISTRY_BASE_URL.length)}`;
      return originalFetch(redirectedUrl, init);
    }
    return originalFetch(input, init);
  });
}

describe("isNewerVersion", () => {
  it("handles calver and suffix comparisons", () => {
    expect(isNewerVersion("2025.3.17", "2025.3.18")).toBe(true);
    expect(isNewerVersion("2025.3.17", "2025.4.1")).toBe(true);
    expect(isNewerVersion("2025.3.17", "2025.3.17")).toBe(false);
    expect(isNewerVersion("2025.3.18", "2025.3.17")).toBe(false);
    expect(isNewerVersion("0.1.0", "2025.3.17")).toBe(true);
    expect(isNewerVersion("2025.3.17", "2025.3.17-1")).toBe(true);
    expect(isNewerVersion("2025.3.17-1", "2025.3.17-2")).toBe(true);
    expect(isNewerVersion("2025.3.17-2", "2025.3.17-1")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  it("returns the version string for successful responses", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"name":"pkg","version":"2025.3.18"}');
    });
    stubNpmFetch(baseUrl);

    await expect(fetchLatestVersion("pkg", 5_000)).resolves.toBe("2025.3.18");
  });

  it("throws NETWORK_ERROR on non-200 responses", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"service unavailable"}');
    });
    stubNpmFetch(baseUrl);

    await expect(fetchLatestVersion("pkg", 5_000)).rejects.toMatchObject({
      code: "NETWORK_ERROR"
    });
  });

  it("throws TIMEOUT when request exceeds timeout", async () => {
    const baseUrl = await startServer(() => {
      return;
    });
    stubNpmFetch(baseUrl);

    await expect(fetchLatestVersion("pkg", 100)).rejects.toMatchObject({
      code: "TIMEOUT"
    });
  });

  it("throws NETWORK_ERROR for invalid JSON payloads", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
    });
    stubNpmFetch(baseUrl);

    await expect(fetchLatestVersion("pkg", 5_000)).rejects.toBeInstanceOf(
      LinkedInBuddyError
    );
    await expect(fetchLatestVersion("pkg", 5_000)).rejects.toMatchObject({
      code: "NETWORK_ERROR"
    });
  });
});

describe("cache roundtrip", () => {
  it("writes and reads cache entries", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "update-check-cache-"));
    const cachePath = path.join(tempDir, "cache.json");

    writeUpdateCheckCache(cachePath, {
      latestVersion: "2025.3.18",
      checkedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(readUpdateCheckCache(cachePath)).toEqual({
      latestVersion: "2025.3.18",
      checkedAt: "2026-01-01T00:00:00.000Z"
    });
  });

  it("returns null for missing cache file", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "update-check-cache-"));
    const cachePath = path.join(tempDir, "missing.json");

    expect(readUpdateCheckCache(cachePath)).toBeNull();
  });

  it("returns null for corrupt cache JSON", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "update-check-cache-"));
    const cachePath = path.join(tempDir, "cache.json");
    writeFileSync(cachePath, "{ not valid json", "utf8");

    expect(readUpdateCheckCache(cachePath)).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("returns cached result when cache is fresh", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "update-check-cache-"));
    const cachePath = path.join(tempDir, "update-check.json");
    writeUpdateCheckCache(cachePath, {
      latestVersion: "2025.3.18",
      checkedAt: new Date().toISOString()
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await checkForUpdate(
      {
        enabled: true,
        cacheTtlMs: DEFAULT_UPDATE_CHECK_CACHE_TTL_MS,
        timeoutMs: 5_000,
        cacheFilePath: cachePath
      },
      "2025.3.17"
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      cached: true,
      updateAvailable: true,
      latestVersion: "2025.3.18"
    });
  });

  it("fetches latest version when cache is stale", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "update-check-cache-"));
    const cachePath = path.join(tempDir, "update-check.json");
    writeUpdateCheckCache(cachePath, {
      latestVersion: "2025.3.16",
      checkedAt: "2000-01-01T00:00:00.000Z"
    });

    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"name":"pkg","version":"2025.3.20"}');
    });
    stubNpmFetch(baseUrl);

    const result = await checkForUpdate(
      {
        enabled: true,
        cacheTtlMs: 1,
        timeoutMs: 5_000,
        cacheFilePath: cachePath
      },
      "2025.3.17"
    );

    expect(result).toMatchObject({
      cached: false,
      updateAvailable: true,
      latestVersion: "2025.3.20"
    });
  });

  it("returns updateAvailable false on fetch error", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "update-check-cache-"));
    const cachePath = path.join(tempDir, "update-check.json");

    vi.stubGlobal("fetch", () => Promise.reject(new Error("unreachable")));

    const result = await checkForUpdate(
      {
        enabled: true,
        cacheTtlMs: 1,
        timeoutMs: 100,
        cacheFilePath: cachePath
      },
      "2025.3.17"
    );

    expect(result).toMatchObject({
      updateAvailable: false,
      latestVersion: "2025.3.17",
      updateCommand: ""
    });
  });

  it("returns updateAvailable false when disabled", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "update-check-cache-"));
    const cachePath = path.join(tempDir, "update-check.json");
    const result = await checkForUpdate(
      {
        enabled: false,
        cacheTtlMs: 1,
        timeoutMs: 100,
        cacheFilePath: cachePath
      },
      "2025.3.17"
    );

    expect(result).toMatchObject({
      updateAvailable: false,
      latestVersion: "2025.3.17",
      updateCommand: "",
      cached: false
    });
  });
});

describe("resolveUpdateCheckConfig", () => {
  it("uses defaults with update checks enabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "");
    const config = resolveUpdateCheckConfig();
    expect(config.enabled).toBe(true);
    expect(config.cacheTtlMs).toBe(DEFAULT_UPDATE_CHECK_CACHE_TTL_MS);
    expect(config.cacheFilePath.endsWith("update-check.json")).toBe(true);
  });

  it("disables update checks from env flag", () => {
    vi.stubEnv(LINKEDIN_BUDDY_UPDATE_CHECK_ENV, "false");

    expect(resolveUpdateCheckConfig().enabled).toBe(false);
  });

  it("disables update checks in CI", () => {
    vi.stubEnv("CI", "true");

    expect(resolveUpdateCheckConfig().enabled).toBe(false);
  });

  it("disables update checks in NODE_ENV=test", () => {
    vi.stubEnv("NODE_ENV", "test");

    expect(resolveUpdateCheckConfig().enabled).toBe(false);
  });

  it("honors explicit option override", () => {
    expect(resolveUpdateCheckConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe("detectInstallMethod", () => {
  it("returns npx when npm user agent indicates npx", () => {
    vi.stubEnv("npm_config_user_agent", "npx/10.5.0 node/v22");

    expect(detectInstallMethod()).toBe("npx");
  });

  it("returns global-npm when argv points at global node_modules", () => {
    vi.stubEnv("npm_config_user_agent", "npm/10.5.0 node/v22");
    process.argv = [
      "node",
      "/usr/local/lib/node_modules/@linkedin-buddy/cli/dist/bin/linkedin.js"
    ];

    expect(detectInstallMethod()).toBe("global-npm");
  });
});

describe("buildUpdateCommand", () => {
  it("returns the expected command for each install method", () => {
    expect(buildUpdateCommand("global-npm")).toBe(
      "npm install -g @linkedin-buddy/cli@latest"
    );
    expect(buildUpdateCommand("npx")).toBe(
      "npx @linkedin-buddy/cli@latest (always runs latest)"
    );
    expect(buildUpdateCommand("local-npm")).toBe(
      "npm install @linkedin-buddy/cli@latest"
    );
    expect(buildUpdateCommand("unknown")).toBe(
      "npm install -g @linkedin-buddy/cli@latest"
    );
  });
});

describe("constants", () => {
  it("keeps package name stable", () => {
    expect(UPDATE_CHECK_PACKAGE_NAME).toBe("@linkedin-buddy/cli");
  });
});
