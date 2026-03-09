import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Dirent
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, type TestContext } from "vitest";
import {
  ensureSharedFixtureReplayServer,
  isFixtureReplayEnabled,
  shutdownSharedFixtureReplayServer
} from "../../fixtureReplay.js";
import { createCoreRuntime, type CoreRuntime } from "../../runtime.js";

/** Default CDP endpoint used by the shared real-session E2E harness. */
export const DEFAULT_E2E_CDP_URL = "http://localhost:18800";

/** Prefix used for temporary assistant-home directories created by E2E suites. */
export const E2E_BASE_DIR_PREFIX = "linkedin-e2e-shared-";

/** Metadata file stored inside each temporary E2E assistant-home directory. */
export const E2E_OWNER_METADATA_FILE = ".owner.json";

let sharedRuntime: CoreRuntime | undefined;
let sharedAvailability: E2EAvailability | undefined;
let sharedBaseDir: string | undefined;
const activeSuites = new Set<symbol>();
let exitCleanupRegistered = false;

interface E2EOwnerMetadata {
  pid: number;
  createdAtMs: number;
}

interface ErrnoLikeError extends Error {
  code?: string;
}

/**
 * Cached availability result for the shared real-session E2E harness.
 */
export interface E2EAvailability {
  cdpAvailable: boolean;
  authenticated: boolean;
  canRun: boolean;
  reason: string;
}

/**
 * Shared suite wrapper that exposes the live runtime, availability state, and
 * any optional suite fixtures.
 */
export interface E2ESuite<TFixtures = void> {
  availability(): E2EAvailability;
  canRun(): boolean;
  runtime(): CoreRuntime;
  fixtures(): TFixtures;
}

interface E2ESuiteOptions<TFixtures> {
  fixtures?: (runtime: CoreRuntime) => Promise<TFixtures>;
  timeoutMs?: number;
}

const UNINITIALIZED_AVAILABILITY: E2EAvailability = {
  cdpAvailable: false,
  authenticated: false,
  canRun: false,
  reason: "E2E availability has not been initialized."
};

function summarizeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function isReplayE2EEnabled(): boolean {
  return isFixtureReplayEnabled();
}

function readConfiguredCdpUrl(): string | undefined {
  if (isReplayE2EEnabled()) {
    return undefined;
  }

  const value = process.env.LINKEDIN_CDP_URL;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : DEFAULT_E2E_CDP_URL;
}

function getCdpUrlValidationError(cdpUrl: string): string | undefined {
  try {
    const url = new URL(cdpUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return undefined;
    }

    return `LINKEDIN_CDP_URL must use http:// or https://. Received: ${cdpUrl}.`;
  } catch {
    return `LINKEDIN_CDP_URL must be an absolute http(s) URL. Received: ${cdpUrl}.`;
  }
}

function getCdpVersionEndpoint(cdpUrl: string): string {
  return new URL("/json/version", cdpUrl).toString();
}

function getOwnerMetadataPath(baseDir: string): string {
  return path.join(baseDir, E2E_OWNER_METADATA_FILE);
}

function writeOwnerMetadata(baseDir: string): void {
  const metadata: E2EOwnerMetadata = {
    pid: process.pid,
    createdAtMs: Date.now()
  };

  writeFileSync(getOwnerMetadataPath(baseDir), JSON.stringify(metadata), "utf8");
}

function readOwnerMetadata(baseDir: string): E2EOwnerMetadata | undefined {
  const metadataPath = getOwnerMetadataPath(baseDir);
  if (!existsSync(metadataPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const pid = record.pid;
    const createdAtMs = record.createdAtMs;
    if (
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof createdAtMs !== "number" ||
      !Number.isFinite(createdAtMs)
    ) {
      return undefined;
    }

    return { pid, createdAtMs };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as ErrnoLikeError).code !== "ESRCH";
  }
}

function cleanupStaleE2EBaseDirs(): void {
  const tmpDir = os.tmpdir();
  const entries = readdirSync(tmpDir, {
    withFileTypes: true
  });

  for (const entry of entries) {
    if (!isStaleE2EDirectoryEntry(entry)) {
      continue;
    }

    const candidateDir = path.join(tmpDir, entry.name);
    const owner = readOwnerMetadata(candidateDir);
    if (!owner || isProcessAlive(owner.pid)) {
      continue;
    }

    rmSync(candidateDir, { recursive: true, force: true });
  }
}

function isStaleE2EDirectoryEntry(entry: Dirent): boolean {
  return entry.isDirectory() && entry.name.startsWith(E2E_BASE_DIR_PREFIX);
}

function ensureExitCleanupRegistered(): void {
  if (exitCleanupRegistered) {
    return;
  }

  process.once("exit", cleanupRuntime);
  exitCleanupRegistered = true;
}

async function probeCdpEndpoint(cdpUrl: string): Promise<{
  available: boolean;
  reason: string;
}> {
  const validationError = getCdpUrlValidationError(cdpUrl);
  if (validationError) {
    return {
      available: false,
      reason: validationError
    };
  }

  try {
    const resp = await fetch(getCdpVersionEndpoint(cdpUrl));
    if (resp.ok) {
      return {
        available: true,
        reason: `CDP endpoint is reachable at ${cdpUrl}.`
      };
    }

    return {
      available: false,
      reason:
        `CDP endpoint at ${cdpUrl} responded with HTTP ${resp.status}. ` +
        "Start the local browser bridge or set LINKEDIN_CDP_URL to a reachable endpoint."
    };
  } catch (error) {
    return {
      available: false,
      reason:
        `No CDP endpoint is reachable at ${cdpUrl}. ` +
        `Start the local browser bridge or set LINKEDIN_CDP_URL to a reachable endpoint. (${summarizeUnknownError(error)})`
    };
  }
}

async function probeFixtureReplay(): Promise<{
  available: boolean;
  reason: string;
}> {
  try {
    const replayServer = await ensureSharedFixtureReplayServer();
    if (!replayServer) {
      return {
        available: false,
        reason: "Fixture replay is disabled."
      };
    }

    return {
      available: true,
      reason:
        `Fixture replay is active for set ${replayServer.setName} ` +
        `(${replayServer.summary.locale}, ${replayServer.summary.viewport.width}x${replayServer.summary.viewport.height}).`
    };
  } catch (error) {
    throw new Error(`Fixture replay could not start. ${summarizeUnknownError(error)}`);
  }
}

async function probeAuthentication(): Promise<{
  authenticated: boolean;
  reason: string;
}> {
  if (isReplayE2EEnabled()) {
    const replay = await probeFixtureReplay();
    return {
      authenticated: replay.available,
      reason: replay.reason
    };
  }

  const cdpUrl = getCdpUrl();
  if (!cdpUrl) {
    return {
      authenticated: false,
      reason: "No CDP URL is configured."
    };
  }

  try {
    const status = await getRuntime().auth.status();
    if (status.authenticated) {
      return {
        authenticated: true,
        reason: `Authenticated LinkedIn session detected via ${cdpUrl}.`
      };
    }

    return {
      authenticated: false,
      reason:
        `LinkedIn session is not authenticated via ${cdpUrl}. ` +
        "Complete login in the attached browser session and retry."
    };
  } catch (error) {
    return {
      authenticated: false,
      reason:
        `Could not verify LinkedIn authentication via ${cdpUrl}. ` +
        summarizeUnknownError(error)
    };
  }
}

/**
 * Returns the shared runtime instance used by all live E2E suites in the
 * current process.
 */
export function getRuntime(): CoreRuntime {
  if (!sharedRuntime) {
    const cdpUrl = getCdpUrl();
    if (cdpUrl) {
      const validationError = getCdpUrlValidationError(cdpUrl);
      if (validationError) {
        throw new Error(validationError);
      }
    }

    sharedRuntime = createCoreRuntime(
      cdpUrl
        ? {
            baseDir: getE2EBaseDir(),
            cdpUrl
          }
        : {
            baseDir: getE2EBaseDir()
          }
    );
  }
  return sharedRuntime;
}

/**
 * Resolves the effective CDP URL for the E2E harness.
 */
export function getCdpUrl(): string | undefined {
  return readConfiguredCdpUrl();
}

/**
 * Returns the shared assistant-home directory used by the E2E harness,
 * creating and ownership-tagging it on first use.
 */
export function getE2EBaseDir(): string {
  if (!sharedBaseDir) {
    cleanupStaleE2EBaseDirs();
    ensureExitCleanupRegistered();

    sharedBaseDir = mkdtempSync(path.join(os.tmpdir(), E2E_BASE_DIR_PREFIX));
    writeOwnerMetadata(sharedBaseDir);
  }

  return sharedBaseDir;
}

/**
 * Temporarily overrides `LINKEDIN_ASSISTANT_HOME` while executing `callback`.
 */
export async function withAssistantHome<T>(
  assistantHome: string,
  callback: () => Promise<T>
): Promise<T> {
  const previousHome = process.env.LINKEDIN_ASSISTANT_HOME;
  process.env.LINKEDIN_ASSISTANT_HOME = assistantHome;

  try {
    return await callback();
  } finally {
    if (previousHome === undefined) {
      delete process.env.LINKEDIN_ASSISTANT_HOME;
    } else {
      process.env.LINKEDIN_ASSISTANT_HOME = previousHome;
    }
  }
}

/**
 * Runs `callback` inside the shared E2E assistant-home directory.
 */
export async function withE2EEnvironment<T>(callback: () => Promise<T>): Promise<T> {
  return withAssistantHome(getE2EBaseDir(), callback);
}

/**
 * Probes whether the configured CDP endpoint is reachable.
 */
export async function checkCdpAvailable(): Promise<boolean> {
  if (isReplayE2EEnabled()) {
    return (await probeFixtureReplay()).available;
  }

  const cdpUrl = getCdpUrl();
  if (!cdpUrl) {
    return false;
  }

  return (await probeCdpEndpoint(cdpUrl)).available;
}

/**
 * Probes whether the configured CDP session is already authenticated with
 * LinkedIn.
 */
export async function checkAuthenticated(): Promise<boolean> {
  return (await probeAuthentication()).authenticated;
}

/**
 * Returns the cached E2E availability result, probing CDP and authentication on
 * first access.
 */
export async function getE2EAvailability(): Promise<E2EAvailability> {
  if (sharedAvailability) {
    return sharedAvailability;
  }

  if (isReplayE2EEnabled()) {
    const replay = await probeFixtureReplay();
    sharedAvailability = {
      cdpAvailable: replay.available,
      authenticated: replay.available,
      canRun: replay.available,
      reason: replay.reason
    };
    return sharedAvailability;
  }

  const cdpUrl = getCdpUrl();
  if (!cdpUrl) {
    sharedAvailability = {
      cdpAvailable: false,
      authenticated: false,
      canRun: false,
      reason: "No CDP endpoint is configured."
    };
    return sharedAvailability;
  }

  const cdp = await probeCdpEndpoint(cdpUrl);
  if (!cdp.available) {
    sharedAvailability = {
      cdpAvailable: false,
      authenticated: false,
      canRun: false,
      reason: cdp.reason
    };
    return sharedAvailability;
  }

  const auth = await probeAuthentication();
  sharedAvailability = {
    cdpAvailable: true,
    authenticated: auth.authenticated,
    canRun: auth.authenticated,
    reason: auth.reason
  };

  return sharedAvailability;
}

/**
 * Registers a real-session E2E suite that shares one runtime and optional
 * runtime-backed fixtures across all tests in the suite.
 */
export function setupE2ESuite<TFixtures = void>(
  options: E2ESuiteOptions<TFixtures> = {}
): E2ESuite<TFixtures> {
  const suiteId = Symbol("e2e-suite");
  let availability = UNINITIALIZED_AVAILABILITY;
  let suiteFixtures: TFixtures | undefined;
  let suiteRegistered = false;

  beforeAll(async () => {
    // Real-session E2Es share one runtime so the suite only pays the CDP/auth
    // probe cost once. Optional fixtures are resolved after the availability
    // check so callers can safely reuse the same runtime-backed discovery.
    if (!suiteRegistered) {
      activeSuites.add(suiteId);
      suiteRegistered = true;
    }

    availability = await getE2EAvailability();
    if (availability.canRun && options.fixtures) {
      suiteFixtures = await options.fixtures(getRuntime());
    }
  }, options.timeoutMs);

  afterAll(() => {
    const removed = suiteRegistered ? activeSuites.delete(suiteId) : false;
    suiteRegistered = false;
    if (removed && activeSuites.size === 0) {
      cleanupRuntime();
    }

    availability = UNINITIALIZED_AVAILABILITY;
    suiteFixtures = undefined;
  });

  return {
    availability: () => availability,
    canRun: () => availability.canRun,
    runtime: () => getRuntime(),
    fixtures: () => {
      // Fixtures are populated in beforeAll after the suite confirms that a
      // live LinkedIn session is actually runnable. Accessing them earlier is a
      // test bug, so fail loudly with a specific message.
      if (!options.fixtures) {
        throw new Error("This E2E suite does not define fixtures.");
      }
      if (suiteFixtures === undefined) {
        throw new Error("E2E fixtures are not available for this suite.");
      }

      return suiteFixtures;
    }
  };
}

/**
 * Skips the current test when the shared E2E prerequisites are unavailable.
 */
export function skipIfE2EUnavailable<TFixtures>(
  suite: E2ESuite<TFixtures>,
  context?: Pick<TestContext, "skip"> | null
): boolean {
  if (!suite.canRun()) {
    const availability = suite.availability();
    const reason =
      typeof availability?.reason === "string" && availability.reason.trim().length > 0
        ? availability.reason
        : "LinkedIn E2E prerequisites are unavailable.";

    if (context && typeof context.skip === "function") {
      context.skip(`Skipping LinkedIn E2E: ${reason}`);
    }

    return true;
  }

  return false;
}

/**
 * Closes the shared runtime and removes the shared temporary assistant-home
 * directory.
 */
export function cleanupRuntime(): void {
  const runtime = sharedRuntime;
  const baseDir = sharedBaseDir;

  sharedRuntime = undefined;
  sharedBaseDir = undefined;
  sharedAvailability = undefined;
  activeSuites.clear();

  if (runtime) {
    runtime.close();
  }

  shutdownSharedFixtureReplayServer();

  if (baseDir && existsSync(baseDir)) {
    rmSync(baseDir, { recursive: true, force: true });
  }
}
