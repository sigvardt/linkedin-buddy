import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright-core";

export const LINKEDIN_FIXTURE_MANIFEST_FORMAT_VERSION = 1;
export const DEFAULT_FIXTURE_STALENESS_DAYS = 30;
export const DEFAULT_FIXTURE_MANIFEST_PATH = path.resolve(
  process.cwd(),
  "test/fixtures/manifest.json"
);
export const REPLAY_ROUTE_PATH = "/__linkedin_fixture__/replay";
export const FIXTURE_REPLAY_ENV_KEYS = [
  "LINKEDIN_E2E_REPLAY",
  "LINKEDIN_E2E_FIXTURE_SERVER_URL",
  "LINKEDIN_E2E_FIXTURE_SET",
  "LINKEDIN_E2E_FIXTURE_MANIFEST"
] as const;
export const LINKEDIN_REPLAY_PAGE_TYPES = [
  "feed",
  "profile",
  "messaging",
  "notifications",
  "composer",
  "search",
  "connections",
  "jobs"
] as const;

export type LinkedInReplayPageType = (typeof LINKEDIN_REPLAY_PAGE_TYPES)[number];

export interface LinkedInFixtureViewport {
  width: number;
  height: number;
}

export interface LinkedInFixturePageEntry {
  pageType: LinkedInReplayPageType;
  url: string;
  htmlPath: string;
  recordedAt: string;
  title?: string;
}

export interface LinkedInFixtureSetSummary {
  setName: string;
  rootDir: string;
  locale: string;
  capturedAt: string;
  viewport: LinkedInFixtureViewport;
  routesPath: string;
  description?: string;
  harPath?: string;
  pages: Partial<Record<LinkedInReplayPageType, LinkedInFixturePageEntry>>;
}

export interface LinkedInFixtureManifest {
  format: number;
  updatedAt: string;
  defaultSetName?: string;
  sets: Record<string, LinkedInFixtureSetSummary>;
}

export interface LinkedInFixtureRoute {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  bodyPath?: string;
  bodyText?: string;
  pageType?: LinkedInReplayPageType;
}

export interface LinkedInFixtureRouteFile {
  format: number;
  setName: string;
  routes: LinkedInFixtureRoute[];
}

export interface LinkedInFixtureSet {
  manifestPath: string;
  setName: string;
  baseDir: string;
  summary: LinkedInFixtureSetSummary;
  routes: LinkedInFixtureRoute[];
}

export interface FixtureStalenessWarning {
  ageDays: number;
  maxAgeDays: number;
  message: string;
  pageType?: LinkedInReplayPageType;
  recordedAt: string;
  setName: string;
}

export interface FixtureReplayEnvironment {
  enabled: boolean;
  manifestPath: string;
  serverUrl?: string;
  setName?: string;
}

export interface StartedFixtureReplayServer {
  baseUrl: string;
  close: () => void;
  manifestPath: string;
  setName: string;
  summary: LinkedInFixtureSetSummary;
}

interface ReplayLookupEntry {
  body: Buffer;
  headers: Record<string, string>;
  status: number;
}

interface ReplayRequestPayload {
  method: string;
  url: string;
}

interface MutableSharedServerState {
  promise: Promise<StartedFixtureReplayServer> | undefined;
  started: StartedFixtureReplayServer | undefined;
}

const sharedServerState: MutableSharedServerState = {
  promise: undefined,
  started: undefined
};

const linkedInReplayPageTypes = new Set<string>(LINKEDIN_REPLAY_PAGE_TYPES);

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnabledFlag(name: string): boolean {
  const value = readTrimmedEnv(name);
  return value === "1" || value === "true";
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asString(value: unknown, label: string): string {
  const resolved = asOptionalString(value);
  if (!resolved) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return resolved;
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }

  return value;
}

function asPageType(value: unknown, label: string): LinkedInReplayPageType {
  const resolved = asString(value, label);
  if (linkedInReplayPageTypes.has(resolved)) {
    return resolved as LinkedInReplayPageType;
  }

  throw new Error(`${label} must be one of ${LINKEDIN_REPLAY_PAGE_TYPES.join(", ")}.`);
}

function parseViewport(value: unknown, label: string): LinkedInFixtureViewport {
  const record = asRecord(value, label);
  return {
    width: asFiniteNumber(record.width, `${label}.width`),
    height: asFiniteNumber(record.height, `${label}.height`)
  };
}

function parsePageEntry(
  key: string,
  value: unknown,
  label: string
): LinkedInFixturePageEntry {
  const record = asRecord(value, label);
  return {
    pageType: asPageType(record.pageType ?? key, `${label}.pageType`),
    url: asString(record.url, `${label}.url`),
    htmlPath: asString(record.htmlPath, `${label}.htmlPath`),
    recordedAt: asString(record.recordedAt, `${label}.recordedAt`),
    ...(asOptionalString(record.title) ? { title: asString(record.title, `${label}.title`) } : {})
  };
}

function parseSetSummary(key: string, value: unknown, label: string): LinkedInFixtureSetSummary {
  const record = asRecord(value, label);
  const pagesRecord = asRecord(record.pages ?? {}, `${label}.pages`);
  const pages: Partial<Record<LinkedInReplayPageType, LinkedInFixturePageEntry>> = {};

  for (const [pageKey, pageValue] of Object.entries(pagesRecord)) {
    const page = parsePageEntry(pageKey, pageValue, `${label}.pages.${pageKey}`);
    pages[page.pageType] = page;
  }

  return {
    setName: asString(record.setName ?? key, `${label}.setName`),
    rootDir: asString(record.rootDir, `${label}.rootDir`),
    locale: asString(record.locale, `${label}.locale`),
    capturedAt: asString(record.capturedAt, `${label}.capturedAt`),
    viewport: parseViewport(record.viewport, `${label}.viewport`),
    routesPath: asString(record.routesPath, `${label}.routesPath`),
    ...(asOptionalString(record.description)
      ? { description: asString(record.description, `${label}.description`) }
      : {}),
    ...(asOptionalString(record.harPath)
      ? { harPath: asString(record.harPath, `${label}.harPath`) }
      : {}),
    pages
  };
}

function parseRoute(value: unknown, label: string): LinkedInFixtureRoute {
  const record = asRecord(value, label);
  const headersRecord = asRecord(record.headers ?? {}, `${label}.headers`);
  const headers: Record<string, string> = {};
  for (const [headerKey, headerValue] of Object.entries(headersRecord)) {
    headers[headerKey] = String(headerValue);
  }

  const pageTypeValue = record.pageType;
  return {
    method: asString(record.method, `${label}.method`).toUpperCase(),
    url: asString(record.url, `${label}.url`),
    status: asFiniteNumber(record.status, `${label}.status`),
    headers: normalizeFixtureRouteHeaders(headers),
    ...(asOptionalString(record.bodyPath)
      ? { bodyPath: asString(record.bodyPath, `${label}.bodyPath`) }
      : {}),
    ...(typeof record.bodyText === "string" ? { bodyText: record.bodyText } : {}),
    ...(pageTypeValue !== undefined
      ? { pageType: asPageType(pageTypeValue, `${label}.pageType`) }
      : {})
  };
}

function parseManifest(value: unknown, manifestPath: string): LinkedInFixtureManifest {
  const record = asRecord(value, `Fixture manifest ${manifestPath}`);
  const setsRecord = asRecord(record.sets ?? {}, `Fixture manifest ${manifestPath}.sets`);
  const sets: Record<string, LinkedInFixtureSetSummary> = {};

  for (const [key, setValue] of Object.entries(setsRecord)) {
    const parsedSet = parseSetSummary(key, setValue, `Fixture manifest ${manifestPath}.sets.${key}`);
    sets[key] = parsedSet;
  }

  return {
    format: asFiniteNumber(record.format, `Fixture manifest ${manifestPath}.format`),
    updatedAt: asString(record.updatedAt, `Fixture manifest ${manifestPath}.updatedAt`),
    ...(asOptionalString(record.defaultSetName)
      ? { defaultSetName: asString(record.defaultSetName, `Fixture manifest ${manifestPath}.defaultSetName`) }
      : {}),
    sets
  };
}

function parseRouteFile(value: unknown, routePath: string): LinkedInFixtureRouteFile {
  const record = asRecord(value, `Fixture route file ${routePath}`);
  const routesValue = record.routes;
  if (!Array.isArray(routesValue)) {
    throw new Error(`Fixture route file ${routePath}.routes must be an array.`);
  }

  return {
    format: asFiniteNumber(record.format, `Fixture route file ${routePath}.format`),
    setName: asString(record.setName, `Fixture route file ${routePath}.setName`),
    routes: routesValue.map((route, index) =>
      parseRoute(route, `Fixture route file ${routePath}.routes[${index}]`)
    )
  };
}

function normalizeRouteUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();

  const sortedSearchParams = [...parsed.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) {
      return leftValue.localeCompare(rightValue);
    }
    return leftKey.localeCompare(rightKey);
  });

  parsed.search = "";
  for (const [key, value] of sortedSearchParams) {
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}

export function buildFixtureRouteKey(
  route: Pick<LinkedInFixtureRoute, "method" | "url">
): string {
  return `${route.method.toUpperCase()} ${normalizeRouteUrl(route.url)}`;
}

function resolveFixtureSetBaseDir(
  manifestPath: string,
  summary: LinkedInFixtureSetSummary
): string {
  return path.resolve(path.dirname(manifestPath), summary.rootDir);
}

function getResolvedRouteFilePath(
  manifestPath: string,
  summary: LinkedInFixtureSetSummary
): string {
  return path.resolve(resolveFixtureSetBaseDir(manifestPath, summary), summary.routesPath);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export function isLinkedInFixtureReplayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "linkedin.com" ||
      hostname.endsWith(".linkedin.com") ||
      hostname === "licdn.com" ||
      hostname.endsWith(".licdn.com")
    );
  } catch {
    return false;
  }
}

function getAgeDays(recordedAt: string): number {
  const recordedMs = Date.parse(recordedAt);
  if (!Number.isFinite(recordedMs)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor((Date.now() - recordedMs) / (24 * 60 * 60 * 1000));
}

export function normalizeFixtureRouteHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  delete normalizedHeaders["content-length"];
  delete normalizedHeaders["content-encoding"];
  delete normalizedHeaders["transfer-encoding"];
  return normalizedHeaders;
}

function assertFixtureFileFormat(
  fileLabel: string,
  filePath: string,
  format: number
): void {
  if (format === LINKEDIN_FIXTURE_MANIFEST_FORMAT_VERSION) {
    return;
  }

  throw new Error(
    `${fileLabel} ${filePath} uses unsupported format ${format}. ` +
      `Expected ${LINKEDIN_FIXTURE_MANIFEST_FORMAT_VERSION}.`
  );
}

function createReplayMissBody(payload: ReplayRequestPayload): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        error: "fixture_not_found",
        message: `No replay fixture exists for ${payload.method.toUpperCase()} ${payload.url}.`,
        method: payload.method.toUpperCase(),
        url: payload.url
      },
      null,
      2
    ),
    "utf8"
  );
}

async function readReplayRequestPayload(request: IncomingMessage): Promise<ReplayRequestPayload> {
  if (request.method === "GET") {
    const parsed = new URL(request.url ?? REPLAY_ROUTE_PATH, "http://127.0.0.1");
    return {
      method: asString(parsed.searchParams.get("method"), "replay request method"),
      url: asString(parsed.searchParams.get("url"), "replay request url")
    };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const record = asRecord(JSON.parse(raw) as unknown, "replay request body");
  return {
    method: asString(record.method, "replay request body.method"),
    url: asString(record.url, "replay request body.url")
  };
}

function writeServerResponse(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer
): void {
  response.writeHead(status, {
    ...headers,
    "content-length": String(body.byteLength)
  });
  response.end(body);
}

function resolveFixtureBodyPath(baseDir: string, bodyPath: string): string {
  const normalizedBaseDir = path.resolve(baseDir);
  const resolvedPath = path.resolve(normalizedBaseDir, bodyPath);
  const relativePath = path.relative(normalizedBaseDir, resolvedPath);

  if (
    path.isAbsolute(bodyPath) ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `Fixture route bodyPath ${bodyPath} must stay within ${normalizedBaseDir}.`
    );
  }

  return resolvedPath;
}

async function buildReplayLookup(
  baseDir: string,
  routes: LinkedInFixtureRoute[]
): Promise<Map<string, ReplayLookupEntry>> {
  const lookup = new Map<string, ReplayLookupEntry>();

  for (const route of routes) {
    const body = route.bodyPath
      ? await readFile(resolveFixtureBodyPath(baseDir, route.bodyPath))
      : Buffer.from(route.bodyText ?? "", "utf8");
    lookup.set(buildFixtureRouteKey(route), {
      body,
      headers: normalizeFixtureRouteHeaders(route.headers),
      status: route.status
    });
  }

  return lookup;
}

async function startFixtureReplayServer(
  manifestPath: string,
  requestedSetName?: string
): Promise<StartedFixtureReplayServer> {
  const fixtureSet = await loadLinkedInFixtureSet(manifestPath, requestedSetName);
  const lookup = await buildReplayLookup(fixtureSet.baseDir, fixtureSet.routes);

  const server = createServer(async (request, response) => {
    try {
      const parsedUrl = new URL(request.url ?? REPLAY_ROUTE_PATH, "http://127.0.0.1");
      if (parsedUrl.pathname !== REPLAY_ROUTE_PATH) {
        writeServerResponse(
          response,
          404,
          { "content-type": "application/json; charset=utf-8" },
          Buffer.from(JSON.stringify({ error: "not_found" }), "utf8")
        );
        return;
      }

      const payload = await readReplayRequestPayload(request);
      const lookupEntry = lookup.get(buildFixtureRouteKey(payload));
      if (!lookupEntry) {
        writeServerResponse(
          response,
          404,
          { "content-type": "application/json; charset=utf-8" },
          createReplayMissBody(payload)
        );
        return;
      }

      writeServerResponse(
        response,
        lookupEntry.status,
        lookupEntry.headers,
        lookupEntry.body
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeServerResponse(
        response,
        500,
        { "content-type": "application/json; charset=utf-8" },
        Buffer.from(
          JSON.stringify(
            {
              error: "fixture_replay_error",
              message
            },
            null,
            2
          ),
          "utf8"
        )
      );
    }
  });

  const started = await new Promise<StartedFixtureReplayServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fixture replay server did not expose a TCP address."));
        return;
      }

      server.removeListener("error", reject);
      server.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => {
          server.close();
        },
        manifestPath,
        setName: fixtureSet.setName,
        summary: fixtureSet.summary
      });
    });
  });

  sharedServerState.started = started;
  return started;
}

export function createEmptyFixtureManifest(
  input: { defaultSetName?: string } = {}
): LinkedInFixtureManifest {
  return {
    format: LINKEDIN_FIXTURE_MANIFEST_FORMAT_VERSION,
    updatedAt: new Date().toISOString(),
    ...(input.defaultSetName ? { defaultSetName: input.defaultSetName } : {}),
    sets: {}
  };
}

export function resolveFixtureManifestPath(manifestPath?: string): string {
  const resolvedPath = manifestPath ?? readTrimmedEnv("LINKEDIN_E2E_FIXTURE_MANIFEST");
  return resolvedPath ? path.resolve(resolvedPath) : DEFAULT_FIXTURE_MANIFEST_PATH;
}

export function getFixtureReplayEnvironment(): FixtureReplayEnvironment {
  const serverUrl = readTrimmedEnv("LINKEDIN_E2E_FIXTURE_SERVER_URL");
  const setName = readTrimmedEnv("LINKEDIN_E2E_FIXTURE_SET");

  return {
    enabled: readEnabledFlag("LINKEDIN_E2E_REPLAY") || serverUrl !== undefined,
    manifestPath: resolveFixtureManifestPath(),
    ...(serverUrl ? { serverUrl } : {}),
    ...(setName ? { setName } : {})
  };
}

export function isFixtureReplayEnabled(): boolean {
  return getFixtureReplayEnvironment().enabled;
}

export async function readLinkedInFixtureManifest(
  manifestPath: string = resolveFixtureManifestPath()
): Promise<LinkedInFixtureManifest> {
  const parsed = parseManifest(await readJsonFile(manifestPath), manifestPath);
  assertFixtureFileFormat("Fixture manifest", manifestPath, parsed.format);

  return parsed;
}

export async function writeLinkedInFixtureManifest(
  manifestPath: string,
  manifest: LinkedInFixtureManifest
): Promise<void> {
  const payload = {
    ...manifest,
    updatedAt: new Date().toISOString()
  } satisfies LinkedInFixtureManifest;
  await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function loadLinkedInFixtureSet(
  manifestPath: string = resolveFixtureManifestPath(),
  requestedSetName?: string
): Promise<LinkedInFixtureSet> {
  const manifest = await readLinkedInFixtureManifest(manifestPath);
  const setName = requestedSetName ?? manifest.defaultSetName ?? Object.keys(manifest.sets)[0];
  if (!setName) {
    throw new Error(`Fixture manifest ${manifestPath} does not define any sets.`);
  }

  const summary = manifest.sets[setName];
  if (!summary) {
    throw new Error(`Fixture set ${setName} is not defined in ${manifestPath}.`);
  }

  const routeFilePath = getResolvedRouteFilePath(manifestPath, summary);
  const parsedRouteFile = parseRouteFile(await readJsonFile(routeFilePath), routeFilePath);
  assertFixtureFileFormat("Fixture route file", routeFilePath, parsedRouteFile.format);

  return {
    manifestPath,
    setName,
    baseDir: resolveFixtureSetBaseDir(manifestPath, summary),
    summary,
    routes: parsedRouteFile.routes
  };
}

export async function checkLinkedInFixtureStaleness(
  manifestPath: string = resolveFixtureManifestPath(),
  options: { maxAgeDays?: number; setName?: string } = {}
): Promise<FixtureStalenessWarning[]> {
  const manifest = await readLinkedInFixtureManifest(manifestPath);
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_FIXTURE_STALENESS_DAYS;

  if (options.setName && manifest.sets[options.setName] === undefined) {
    throw new Error(`Fixture set ${options.setName} is not defined in ${manifestPath}.`);
  }

  const entries = options.setName
    ? [[options.setName, manifest.sets[options.setName]] as const]
    : (Object.entries(manifest.sets) as Array<[string, LinkedInFixtureSetSummary]>);
  const warnings: FixtureStalenessWarning[] = [];

  for (const [setName, summary] of entries) {
    if (!summary) {
      continue;
    }

    const pages = Object.values(summary.pages).filter(
      (page): page is LinkedInFixturePageEntry => page !== undefined
    );

    if (pages.length === 0) {
      const ageDays = getAgeDays(summary.capturedAt);
      if (ageDays > maxAgeDays) {
        warnings.push({
          ageDays,
          maxAgeDays,
          recordedAt: summary.capturedAt,
          setName,
          message:
            `Fixture set ${setName} was captured ${ageDays} day(s) ago ` +
            `on ${summary.capturedAt}. Refresh it because it exceeds ${maxAgeDays} days.`
        });
      }
      continue;
    }

    for (const page of pages) {
      const ageDays = getAgeDays(page.recordedAt);
      if (ageDays <= maxAgeDays) {
        continue;
      }

      warnings.push({
        ageDays,
        maxAgeDays,
        pageType: page.pageType,
        recordedAt: page.recordedAt,
        setName,
        message:
          `Fixture page ${setName}/${page.pageType} was recorded ${ageDays} day(s) ago ` +
          `on ${page.recordedAt}. Refresh it because it exceeds ${maxAgeDays} days.`
      });
    }
  }

  return warnings;
}

export async function ensureSharedFixtureReplayServer(): Promise<StartedFixtureReplayServer | undefined> {
  const environment = getFixtureReplayEnvironment();
  if (!environment.enabled) {
    return undefined;
  }

  if (environment.serverUrl) {
    const fixtureSet = await loadLinkedInFixtureSet(environment.manifestPath, environment.setName);
    return {
      baseUrl: environment.serverUrl,
      close: () => undefined,
      manifestPath: environment.manifestPath,
      setName: fixtureSet.setName,
      summary: fixtureSet.summary
    };
  }

  if (sharedServerState.started) {
    return sharedServerState.started;
  }

  if (!sharedServerState.promise) {
    sharedServerState.promise = startFixtureReplayServer(
      environment.manifestPath,
      environment.setName
    ).finally(() => {
      sharedServerState.promise = undefined;
    });
  }

  return sharedServerState.promise;
}

export function shutdownSharedFixtureReplayServer(): void {
  sharedServerState.started?.close();
  sharedServerState.started = undefined;
  sharedServerState.promise = undefined;
}

export async function attachFixtureReplayToContext(
  context: BrowserContext
): Promise<StartedFixtureReplayServer | undefined> {
  const replayServer = await ensureSharedFixtureReplayServer();
  if (!replayServer) {
    return undefined;
  }

  await context.addInitScript(() => {
    globalThis.document.cookie = "li_at=fixture-session; path=/; SameSite=Lax";
  });

  const replayOrigin = new URL(replayServer.baseUrl).origin;

  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (!/^https?:/i.test(requestUrl)) {
      await route.continue().catch(() => undefined);
      return;
    }

    if (requestUrl.startsWith(replayOrigin)) {
      await route.continue().catch(() => undefined);
      return;
    }

    if (!isLinkedInFixtureReplayUrl(requestUrl)) {
      await route.abort().catch(() => undefined);
      return;
    }

    const replayResponse = await fetch(`${replayServer.baseUrl}${REPLAY_ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        method: route.request().method().toUpperCase(),
        url: requestUrl
      } satisfies ReplayRequestPayload)
    });

    const body = Buffer.from(await replayResponse.arrayBuffer());
    const headers = normalizeFixtureRouteHeaders(
      Object.fromEntries(replayResponse.headers.entries())
    );
    await route.fulfill({
      status: replayResponse.status,
      headers,
      body
    });
  });

  return replayServer;
}
