import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright-core";

/** Current on-disk schema version for replay manifests and route files. */
export const LINKEDIN_FIXTURE_MANIFEST_FORMAT_VERSION = 1;
/** Default max age, in days, used by `linkedin fixtures check`. */
export const DEFAULT_FIXTURE_STALENESS_DAYS = 30;
/** Default replay manifest loaded by `npm run test:e2e:fixtures`. */
export const DEFAULT_FIXTURE_MANIFEST_PATH = path.resolve(
  process.cwd(),
  "test/fixtures/manifest.json"
);
/** Internal HTTP endpoint exposed by the local replay server. */
export const REPLAY_ROUTE_PATH = "/__linkedin_fixture__/replay";
/** Environment variables that toggle or configure the replay lane. */
export const FIXTURE_REPLAY_ENV_KEYS = [
  "LINKEDIN_E2E_REPLAY",
  "LINKEDIN_E2E_FIXTURE_SERVER_URL",
  "LINKEDIN_E2E_FIXTURE_SET",
  "LINKEDIN_E2E_FIXTURE_MANIFEST"
] as const;
/** Supported LinkedIn surfaces that can be recorded into a fixture set. */
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

const MAX_FIXTURE_JSON_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FIXTURE_HAR_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FIXTURE_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_REPLAY_REQUEST_BODY_BYTES = 64 * 1024;
const FIXTURE_REPLAY_FETCH_TIMEOUT_MS = 15_000;
const FIXTURE_REPLAY_SERVER_TIMEOUT_MS = 30_000;

/** Union of every supported LinkedIn page type that can be recorded and replayed. */
export type LinkedInReplayPageType = (typeof LINKEDIN_REPLAY_PAGE_TYPES)[number];

/** Browser viewport recorded alongside each fixture set. */
export interface LinkedInFixtureViewport {
  width: number;
  height: number;
}

/** Metadata for one replayable LinkedIn page snapshot inside a fixture set. */
export interface LinkedInFixturePageEntry {
  pageType: LinkedInReplayPageType;
  url: string;
  /** Path relative to the fixture set root directory. */
  htmlPath: string;
  recordedAt: string;
  title?: string;
}

/**
 * Summary metadata stored under one manifest entry.
 *
 * `rootDir`, `routesPath`, `harPath`, and each page `htmlPath` stay relative to
 * the manifest or set root so fixture sets remain relocatable inside the repo.
 */
export interface LinkedInFixtureSetSummary {
  setName: string;
  /** Path relative to the manifest directory. */
  rootDir: string;
  locale: string;
  capturedAt: string;
  viewport: LinkedInFixtureViewport;
  /** Path relative to `rootDir`. */
  routesPath: string;
  description?: string;
  /** Optional HAR file path relative to `rootDir`. */
  harPath?: string;
  pages: Partial<Record<LinkedInReplayPageType, LinkedInFixturePageEntry>>;
}

/** Top-level JSON document that declares the available replay fixture sets. */
export interface LinkedInFixtureManifest {
  format: number;
  updatedAt: string;
  defaultSetName?: string;
  sets: Record<string, LinkedInFixtureSetSummary>;
}

/**
 * Replayable HTTP response metadata.
 *
 * Routes may inline `bodyText` for small text payloads or point `bodyPath` at a
 * response body file relative to the fixture set root.
 */
export interface LinkedInFixtureRoute {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  /** Path relative to the fixture set root. Mutually exclusive with `bodyText`. */
  bodyPath?: string;
  bodyText?: string;
  pageType?: LinkedInReplayPageType;
}

/** JSON file stored under each fixture set that lists its replayable routes. */
export interface LinkedInFixtureRouteFile {
  format: number;
  setName: string;
  routes: LinkedInFixtureRoute[];
}

/** Fully resolved replay fixture set loaded from disk. */
export interface LinkedInFixtureSet {
  manifestPath: string;
  setName: string;
  baseDir: string;
  summary: LinkedInFixtureSetSummary;
  routes: LinkedInFixtureRoute[];
}

/** Staleness warning returned by `checkLinkedInFixtureStaleness()`. */
export interface FixtureStalenessWarning {
  ageDays: number;
  maxAgeDays: number;
  message: string;
  pageType?: LinkedInReplayPageType;
  recordedAt: string;
  setName: string;
}

/** Snapshot of the effective replay configuration resolved from environment variables. */
export interface FixtureReplayEnvironment {
  /** Whether replay should be attached to the current E2E run. */
  enabled: boolean;
  /** Resolved manifest path used for validation and set loading. */
  manifestPath: string;
  /** Optional externally managed replay server URL. */
  serverUrl?: string;
  /** Optional fixture set override. */
  setName?: string;
}

/** Running replay server metadata returned by the shared replay bootstrap. */
export interface StartedFixtureReplayServer {
  baseUrl: string;
  close: () => void;
  manifestPath: string;
  setName: string;
  summary: LinkedInFixtureSetSummary;
}

interface ReplayLookupEntry {
  body: () => Promise<Buffer>;
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

class FixtureReplayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string
  ) {
    super(message);
    this.name = "FixtureReplayHttpError";
  }
}

const sharedServerState: MutableSharedServerState = {
  promise: undefined,
  started: undefined
};

const linkedInReplayPageTypes = new Set<string>(LINKEDIN_REPLAY_PAGE_TYPES);

function formatAvailableFixtureSets(setNames: string[]): string {
  if (setNames.length === 0) {
    return "No fixture sets are defined in this manifest.";
  }

  return `Available fixture sets: ${[...setNames].sort((left, right) => left.localeCompare(right)).join(", ")}.`;
}

function createUnknownFixtureSetError(
  requestedSetName: string,
  manifestPath: string,
  setNames: string[]
): Error {
  return new Error(
    `Fixture set ${requestedSetName} is not defined in ${manifestPath}. ` +
      formatAvailableFixtureSets(setNames)
  );
}

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

function asTimestampString(value: unknown, label: string): string {
  const resolved = asString(value, label);
  if (!Number.isFinite(Date.parse(resolved))) {
    throw new Error(`${label} must be a valid ISO-8601 timestamp.`);
  }

  return resolved;
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }

  return value;
}

function asPositiveInteger(value: unknown, label: string): number {
  const resolved = asFiniteNumber(value, label);
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return resolved;
}

function asStatusCode(value: unknown, label: string): number {
  const resolved = asPositiveInteger(value, label);
  if (resolved < 100 || resolved > 599) {
    throw new Error(`${label} must be a valid HTTP status code.`);
  }

  return resolved;
}

function asHttpMethod(value: unknown, label: string): string {
  const resolved = asString(value, label).toUpperCase();
  if (!/^[A-Z]+$/.test(resolved)) {
    throw new Error(`${label} must be a valid HTTP method token.`);
  }

  return resolved;
}

function asHttpUrl(value: unknown, label: string): string {
  const resolved = asString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL.`);
  }

  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new Error(`${label} must use the http or https protocol.`);
  }

  return resolved;
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
    width: asPositiveInteger(record.width, `${label}.width`),
    height: asPositiveInteger(record.height, `${label}.height`)
  };
}

function parsePageEntry(
  key: string,
  value: unknown,
  label: string
): LinkedInFixturePageEntry {
  const record = asRecord(value, label);
  const pageType = asPageType(record.pageType ?? key, `${label}.pageType`);
  if (pageType !== key) {
    throw new Error(`${label}.pageType must match page key ${key}.`);
  }

  return {
    pageType,
    url: asHttpUrl(record.url, `${label}.url`),
    htmlPath: asString(record.htmlPath, `${label}.htmlPath`),
    recordedAt: asTimestampString(record.recordedAt, `${label}.recordedAt`),
    ...(asOptionalString(record.title) ? { title: asString(record.title, `${label}.title`) } : {})
  };
}

function parseSetSummary(key: string, value: unknown, label: string): LinkedInFixtureSetSummary {
  const record = asRecord(value, label);
  const setName = asString(record.setName ?? key, `${label}.setName`);
  if (setName !== key) {
    throw new Error(`${label}.setName must match set key ${key}.`);
  }

  const pagesRecord = asRecord(record.pages ?? {}, `${label}.pages`);
  const pages: Partial<Record<LinkedInReplayPageType, LinkedInFixturePageEntry>> = {};

  for (const [pageKey, pageValue] of Object.entries(pagesRecord)) {
    const page = parsePageEntry(pageKey, pageValue, `${label}.pages.${pageKey}`);
    if (pages[page.pageType] !== undefined) {
      throw new Error(`${label}.pages.${pageKey} duplicates pageType ${page.pageType}.`);
    }
    pages[page.pageType] = page;
  }

  return {
    setName,
    rootDir: asString(record.rootDir, `${label}.rootDir`),
    locale: asString(record.locale, `${label}.locale`),
    capturedAt: asTimestampString(record.capturedAt, `${label}.capturedAt`),
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
  const bodyPath = asOptionalString(record.bodyPath);
  const bodyText = typeof record.bodyText === "string" ? record.bodyText : undefined;
  if (bodyPath && bodyText !== undefined) {
    throw new Error(`${label} must not define both bodyPath and bodyText.`);
  }

  return {
    method: asHttpMethod(record.method, `${label}.method`),
    url: asHttpUrl(record.url, `${label}.url`),
    status: asStatusCode(record.status, `${label}.status`),
    headers: normalizeFixtureRouteHeaders(headers),
    ...(bodyPath ? { bodyPath: asString(bodyPath, `${label}.bodyPath`) } : {}),
    ...(bodyText !== undefined ? { bodyText } : {}),
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

  const defaultSetName = asOptionalString(record.defaultSetName);
  if (defaultSetName && Object.keys(sets).length > 0 && sets[defaultSetName] === undefined) {
    throw new Error(
      `Fixture manifest ${manifestPath}.defaultSetName must reference a defined fixture set. ` +
        formatAvailableFixtureSets(Object.keys(sets))
    );
  }

  return {
    format: asFiniteNumber(record.format, `Fixture manifest ${manifestPath}.format`),
    updatedAt: asTimestampString(record.updatedAt, `Fixture manifest ${manifestPath}.updatedAt`),
    ...(defaultSetName
      ? { defaultSetName }
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

function summarizeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sanitizeForErrorMessage(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0x20;
    return codePoint < 0x20 || codePoint === 0x7f ? " " : character;
  }).join("").trim();
}

/**
 * Builds the normalized deduplication key used for stored routes and replay lookups.
 */
export function buildFixtureRouteKey(
  route: Pick<LinkedInFixtureRoute, "method" | "url">
): string {
  return `${route.method.toUpperCase()} ${normalizeRouteUrl(route.url)}`;
}

function resolveFixtureSetBaseDir(
  manifestPath: string,
  summary: LinkedInFixtureSetSummary
): string {
  return resolveFixtureRelativePath(
    path.dirname(manifestPath),
    summary.rootDir,
    `Fixture set ${summary.setName} rootDir`
  );
}

function getResolvedRouteFilePath(
  manifestPath: string,
  summary: LinkedInFixtureSetSummary
): string {
  return resolveFixtureRelativePath(
    resolveFixtureSetBaseDir(manifestPath, summary),
    summary.routesPath,
    `Fixture set ${summary.setName} routesPath`
  );
}

/**
 * Returns whether a URL targets an eligible `linkedin.com` or `licdn.com` http(s) origin.
 */
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

function resolveFixtureRelativePath(
  baseDir: string,
  relativePath: string,
  label: string
): string {
  const normalizedBaseDir = path.resolve(baseDir);
  const resolvedPath = path.resolve(normalizedBaseDir, relativePath);
  const normalizedRelativePath = path.relative(normalizedBaseDir, resolvedPath);

  if (
    path.isAbsolute(relativePath) ||
    normalizedRelativePath === "" ||
    normalizedRelativePath === "." ||
    normalizedRelativePath.startsWith("..") ||
    path.isAbsolute(normalizedRelativePath)
  ) {
    if (relativePath === "." || relativePath === "./") {
      return resolvedPath;
    }

    throw new Error(`${label} ${relativePath} must stay within ${normalizedBaseDir}.`);
  }

  return resolvedPath;
}

function createFixtureReadError(fileLabel: string, filePath: string, error: unknown): Error {
  const errorCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;

  if (errorCode === "ENOENT") {
    return new Error(`${fileLabel} ${filePath} does not exist.`);
  }

  if (errorCode === "EACCES" || errorCode === "EPERM") {
    return new Error(
      `${fileLabel} ${filePath} is not readable because of filesystem permissions.`
    );
  }

  if (errorCode === "EISDIR") {
    return new Error(`${fileLabel} ${filePath} must be a file.`);
  }

  return new Error(`${fileLabel} ${filePath} could not be read. ${summarizeUnknownError(error)}`);
}

function createFixtureWriteError(fileLabel: string, filePath: string, error: unknown): Error {
  const errorCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;

  if (errorCode === "ENOSPC") {
    return new Error(`${fileLabel} ${filePath} could not be written because the disk is full.`);
  }

  if (errorCode === "EACCES" || errorCode === "EPERM") {
    return new Error(
      `${fileLabel} ${filePath} could not be written because of filesystem permissions.`
    );
  }

  return new Error(`${fileLabel} ${filePath} could not be written. ${summarizeUnknownError(error)}`);
}

async function assertFixtureFile(
  filePath: string,
  fileLabel: string,
  maxBytes: number
): Promise<number> {
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      throw new Error(`${fileLabel} ${filePath} must be a file.`);
    }

    if (fileStats.size > maxBytes) {
      throw new Error(`${fileLabel} ${filePath} exceeds the ${maxBytes}-byte replay limit.`);
    }

    return fileStats.size;
  } catch (error) {
    if (error instanceof Error && !("code" in error)) {
      throw error;
    }
    throw createFixtureReadError(fileLabel, filePath, error);
  }
}

/**
 * Normalizes persisted response headers for replay by lowercasing names and
 * stripping transport-only fields that should be regenerated by the server.
 */
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
  const method = sanitizeForErrorMessage(payload.method.toUpperCase());
  const url = sanitizeForErrorMessage(payload.url);
  return Buffer.from(
    JSON.stringify(
      {
        error: "fixture_not_found",
        message: `No replay fixture exists for ${method} ${url}.`,
        method,
        url
      },
      null,
      2
    ),
    "utf8"
  );
}

async function readReplayRequestPayload(request: IncomingMessage): Promise<ReplayRequestPayload> {
  if (request.method === "GET") {
    try {
      const parsed = new URL(request.url ?? REPLAY_ROUTE_PATH, "http://127.0.0.1");
      return {
        method: asHttpMethod(parsed.searchParams.get("method"), "replay request method"),
        url: asHttpUrl(parsed.searchParams.get("url"), "replay request url")
      };
    } catch (error) {
      throw new FixtureReplayHttpError(
        400,
        "fixture_replay_invalid_request",
        `Replay request query is invalid. ${summarizeUnknownError(error)}`
      );
    }
  }

  if (request.method !== "POST") {
    throw new FixtureReplayHttpError(
      405,
      "fixture_replay_method_not_allowed",
      `Replay requests must use GET or POST, received ${request.method ?? "UNKNOWN"}.`
    );
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REPLAY_REQUEST_BODY_BYTES) {
      throw new FixtureReplayHttpError(
        413,
        "fixture_replay_request_too_large",
        `Replay request body exceeded ${MAX_REPLAY_REQUEST_BODY_BYTES} bytes.`
      );
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new FixtureReplayHttpError(
      400,
      "fixture_replay_invalid_request",
      `Replay request body must be valid JSON. ${summarizeUnknownError(error)}`
    );
  }

  try {
    const record = asRecord(parsedJson, "replay request body");
    return {
      method: asHttpMethod(record.method, "replay request body.method"),
      url: asHttpUrl(record.url, "replay request body.url")
    };
  } catch (error) {
    throw new FixtureReplayHttpError(
      400,
      "fixture_replay_invalid_request",
      `Replay request body is invalid. ${summarizeUnknownError(error)}`
    );
  }
}

function createReplayErrorBody(errorCode: string, message: string): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        error: errorCode,
        message
      },
      null,
      2
    ),
    "utf8"
  );
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
  return resolveFixtureRelativePath(baseDir, bodyPath, "Fixture route bodyPath");
}

async function readJsonFile(
  filePath: string,
  fileLabel: string,
  maxBytes: number = MAX_FIXTURE_JSON_FILE_BYTES
): Promise<unknown> {
  await assertFixtureFile(filePath, fileLabel, maxBytes);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw createFixtureReadError(fileLabel, filePath, error);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${fileLabel} ${filePath} contains invalid JSON. ${summarizeUnknownError(error)}`);
  }
}

async function readFixtureBodyFile(filePath: string, fileLabel: string): Promise<Buffer> {
  await assertFixtureFile(filePath, fileLabel, MAX_FIXTURE_RESPONSE_BODY_BYTES);

  try {
    return await readFile(filePath);
  } catch (error) {
    throw createFixtureReadError(fileLabel, filePath, error);
  }
}

async function validateFixtureSetAssets(
  manifestPath: string,
  summary: LinkedInFixtureSetSummary,
  routes: LinkedInFixtureRoute[]
): Promise<string> {
  const baseDir = resolveFixtureSetBaseDir(manifestPath, summary);
  const seenRouteKeys = new Set<string>();

  // Validate every referenced asset up front so replay fails before the browser
  // starts issuing requests against a broken fixture set.
  if (summary.harPath) {
    const harPath = resolveFixtureRelativePath(
      baseDir,
      summary.harPath,
      `Fixture set ${summary.setName} harPath`
    );
    await assertFixtureFile(
      harPath,
      `Fixture HAR file for set ${summary.setName}`,
      MAX_FIXTURE_HAR_FILE_BYTES
    );
  }

  for (const page of Object.values(summary.pages)) {
    if (!page) {
      continue;
    }

    const pagePath = resolveFixtureRelativePath(
      baseDir,
      page.htmlPath,
      `Fixture page ${summary.setName}/${page.pageType} htmlPath`
    );
    await assertFixtureFile(
      pagePath,
      `Fixture page HTML for ${summary.setName}/${page.pageType}`,
      MAX_FIXTURE_RESPONSE_BODY_BYTES
    );
  }

  for (const [index, route] of routes.entries()) {
    const routeLabel = `Fixture route ${summary.setName}.routes[${index}]`;
    const routeKey = buildFixtureRouteKey(route);
    if (seenRouteKeys.has(routeKey)) {
      throw new Error(`${routeLabel} duplicates replay key ${routeKey}.`);
    }
    seenRouteKeys.add(routeKey);

    if (route.pageType && summary.pages[route.pageType] === undefined) {
      throw new Error(`${routeLabel}.pageType ${route.pageType} is not defined in the manifest pages map.`);
    }

    if (route.bodyPath) {
      const bodyFilePath = resolveFixtureBodyPath(baseDir, route.bodyPath);
      await assertFixtureFile(
        bodyFilePath,
        `Fixture response body for ${routeLabel}`,
        MAX_FIXTURE_RESPONSE_BODY_BYTES
      );
      continue;
    }

    if (
      route.bodyText !== undefined &&
      Buffer.byteLength(route.bodyText, "utf8") > MAX_FIXTURE_RESPONSE_BODY_BYTES
    ) {
      throw new Error(`${routeLabel}.bodyText exceeds the ${MAX_FIXTURE_RESPONSE_BODY_BYTES}-byte replay limit.`);
    }
  }

  return baseDir;
}

async function buildReplayLookup(
  baseDir: string,
  routes: LinkedInFixtureRoute[]
): Promise<Map<string, ReplayLookupEntry>> {
  const lookup = new Map<string, ReplayLookupEntry>();

  for (const route of routes) {
    // Lazily load file-backed bodies on first use so startup validates the set
    // without preloading every captured response into memory.
    let pendingBodyLoad: Promise<Buffer> | undefined;
    const body = route.bodyPath
      ? async (): Promise<Buffer> => {
          if (!pendingBodyLoad) {
            const resolvedBodyPath = resolveFixtureBodyPath(baseDir, route.bodyPath ?? "");
            pendingBodyLoad = readFixtureBodyFile(
              resolvedBodyPath,
              `Fixture response body for ${buildFixtureRouteKey(route)}`
            ).finally(() => {
              pendingBodyLoad = undefined;
            });
          }

          return await pendingBodyLoad;
        }
      : async (): Promise<Buffer> => Buffer.from(route.bodyText ?? "", "utf8");

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
  // Build the immutable route lookup once at startup so request handling stays
  // fast and deterministic for the lifetime of the server.
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

      const body = await lookupEntry.body();

      writeServerResponse(
        response,
        lookupEntry.status,
        lookupEntry.headers,
        body
      );
    } catch (error) {
      if (error instanceof FixtureReplayHttpError) {
        writeServerResponse(
          response,
          error.status,
          { "content-type": "application/json; charset=utf-8" },
          createReplayErrorBody(error.errorCode, error.message)
        );
        return;
      }

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

  server.headersTimeout = FIXTURE_REPLAY_SERVER_TIMEOUT_MS;
  server.requestTimeout = FIXTURE_REPLAY_SERVER_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;

  const started = await new Promise<StartedFixtureReplayServer>((resolve, reject) => {
    const rejectOnce = (error: Error): void => {
      server.close();
      reject(error);
    };

    server.once("error", rejectOnce);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Fixture replay server did not expose a TCP address."));
        return;
      }

      server.removeListener("error", rejectOnce);
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

/**
 * Creates a new empty replay manifest using the current format version and timestamp.
 */
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

/**
 * Resolves an explicit or environment-provided manifest path, falling back to the repo default.
 */
export function resolveFixtureManifestPath(manifestPath?: string): string {
  const resolvedPath = manifestPath ?? readTrimmedEnv("LINKEDIN_E2E_FIXTURE_MANIFEST");
  return resolvedPath ? path.resolve(resolvedPath) : DEFAULT_FIXTURE_MANIFEST_PATH;
}

/**
 * Reads the replay environment variables and validates any external replay server override.
 */
export function getFixtureReplayEnvironment(): FixtureReplayEnvironment {
  const serverUrl = readTrimmedEnv("LINKEDIN_E2E_FIXTURE_SERVER_URL");
  const setName = readTrimmedEnv("LINKEDIN_E2E_FIXTURE_SET");
  const validatedServerUrl = serverUrl
    ? asHttpUrl(serverUrl, "LINKEDIN_E2E_FIXTURE_SERVER_URL")
    : undefined;

  return {
    enabled: readEnabledFlag("LINKEDIN_E2E_REPLAY") || validatedServerUrl !== undefined,
    manifestPath: resolveFixtureManifestPath(),
    ...(validatedServerUrl ? { serverUrl: validatedServerUrl } : {}),
    ...(setName ? { setName } : {})
  };
}

/** Returns whether fixture replay is enabled for the current process. */
export function isFixtureReplayEnabled(): boolean {
  return getFixtureReplayEnvironment().enabled;
}

/** Reads and validates a replay manifest from disk. */
export async function readLinkedInFixtureManifest(
  manifestPath: string = resolveFixtureManifestPath()
): Promise<LinkedInFixtureManifest> {
  const parsed = parseManifest(
    await readJsonFile(manifestPath, "Fixture manifest"),
    manifestPath
  );
  assertFixtureFileFormat("Fixture manifest", manifestPath, parsed.format);

  return parsed;
}

/** Writes a replay manifest to disk and refreshes its `updatedAt` timestamp. */
export async function writeLinkedInFixtureManifest(
  manifestPath: string,
  manifest: LinkedInFixtureManifest
): Promise<void> {
  const payload = {
    ...manifest,
    updatedAt: new Date().toISOString()
  } satisfies LinkedInFixtureManifest;

  try {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (error) {
    throw createFixtureWriteError("Fixture manifest", manifestPath, error);
  }
}

/**
 * Loads one replay fixture set, resolves all relative paths, and validates its assets.
 */
export async function loadLinkedInFixtureSet(
  manifestPath: string = resolveFixtureManifestPath(),
  requestedSetName?: string
): Promise<LinkedInFixtureSet> {
  const manifest = await readLinkedInFixtureManifest(manifestPath);
  const availableSetNames = Object.keys(manifest.sets);
  const setName = requestedSetName ?? manifest.defaultSetName ?? Object.keys(manifest.sets)[0];
  if (!setName) {
    throw new Error(
      `Fixture manifest ${manifestPath} does not define any sets. ` +
        'Record one with "linkedin fixtures record --set <name> --page feed" or point the replay lane at a populated manifest.'
    );
  }

  const summary = manifest.sets[setName];
  if (!summary) {
    throw createUnknownFixtureSetError(setName, manifestPath, availableSetNames);
  }

  const routeFilePath = getResolvedRouteFilePath(manifestPath, summary);
  const parsedRouteFile = parseRouteFile(
    await readJsonFile(routeFilePath, "Fixture route file"),
    routeFilePath
  );
  assertFixtureFileFormat("Fixture route file", routeFilePath, parsedRouteFile.format);
  if (parsedRouteFile.setName !== setName) {
    throw new Error(
      `Fixture route file ${routeFilePath} declares setName ${parsedRouteFile.setName}, expected ${setName}.`
    );
  }

  const baseDir = await validateFixtureSetAssets(manifestPath, summary, parsedRouteFile.routes);

  return {
    manifestPath,
    setName,
    baseDir,
    summary,
    routes: parsedRouteFile.routes
  };
}

/**
 * Computes staleness warnings for all sets or one selected set in a replay manifest.
 */
export async function checkLinkedInFixtureStaleness(
  manifestPath: string = resolveFixtureManifestPath(),
  options: { maxAgeDays?: number; setName?: string } = {}
): Promise<FixtureStalenessWarning[]> {
  const manifest = await readLinkedInFixtureManifest(manifestPath);
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_FIXTURE_STALENESS_DAYS;

  if (options.setName && manifest.sets[options.setName] === undefined) {
    throw createUnknownFixtureSetError(options.setName, manifestPath, Object.keys(manifest.sets));
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

/**
 * Starts or reuses the shared replay server for the current environment, or
 * returns the configured external server metadata when one is supplied.
 */
export async function ensureSharedFixtureReplayServer(): Promise<StartedFixtureReplayServer | undefined> {
  const environment = getFixtureReplayEnvironment();
  if (!environment.enabled) {
    return undefined;
  }

  if (environment.serverUrl) {
    // Even with an external server URL we still load the selected set so
    // callers get validated metadata and consistent failure messages.
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

/** Shuts down the cached in-process replay server, if one is running. */
export function shutdownSharedFixtureReplayServer(): void {
  sharedServerState.started?.close();
  sharedServerState.started = undefined;
  sharedServerState.promise = undefined;
}

/**
 * Attaches fixture replay routing to a Playwright context and returns the active
 * replay server metadata.
 */
export async function attachFixtureReplayToContext(
  context: BrowserContext
): Promise<StartedFixtureReplayServer | undefined> {
  const replayServer = await ensureSharedFixtureReplayServer();
  if (!replayServer) {
    return undefined;
  }

  // LinkedIn app shells key off the presence of `li_at`; the synthetic cookie
  // keeps fixture pages on the authenticated code path without real credentials.
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
      // Fail closed: only LinkedIn/Licdn traffic is replayed. All other network
      // requests are blocked so tests cannot silently drift back to live hosts.
      await route.abort().catch(() => undefined);
      return;
    }

    try {
      const replayResponse = await fetch(`${replayServer.baseUrl}${REPLAY_ROUTE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          method: route.request().method().toUpperCase(),
          url: requestUrl
        } satisfies ReplayRequestPayload),
        signal: AbortSignal.timeout(FIXTURE_REPLAY_FETCH_TIMEOUT_MS)
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
    } catch (error) {
      await route.fulfill({
        status: 502,
        headers: {
          "content-type": "application/json; charset=utf-8"
        },
        body: createReplayErrorBody(
          "fixture_replay_unavailable",
          `Fixture replay request failed for ${sanitizeForErrorMessage(route.request().method().toUpperCase())} ${sanitizeForErrorMessage(requestUrl)}. ${summarizeUnknownError(error)}`
        )
      });
    }
  });

  return replayServer;
}
