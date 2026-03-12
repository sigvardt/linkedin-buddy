import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Browser, type BrowserContext } from "playwright-core";
import {
  ensureConfigPaths,
  resolveConfigPaths,
  resolveEvasionConfig,
} from "../config.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "../errors.js";
import { wrapLinkedInBrowserContext } from "../linkedinPage.js";
import {
  applyStealthLaunchOptions,
  createStealthChromium,
  hardenBrowserContext,
  resolveStealthConfig,
} from "../stealth.js";
import {
  captureBrowserFingerprint,
  saveBrowserFingerprint,
  type BrowserFingerprint,
} from "./fingerprint.js";
import {
  inspectLinkedInSession,
  type LinkedInSessionInspection,
} from "./sessionInspection.js";

/**
 * Playwright storage-state snapshot used for LinkedIn session persistence.
 */
export type LinkedInBrowserStorageState = Awaited<
  ReturnType<BrowserContext["storageState"]>
>;

const DEFAULT_CAPTURE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CAPTURE_POLL_INTERVAL_MS = 2_000;
const SESSION_STORE_KEY_FILE_NAME = ".session-store.key";
const SESSION_FILE_SUFFIX = ".session.enc.json";
const SESSION_STORE_SCHEMA_VERSION = 1;
const AES_GCM_IV_BYTES = 12;
const LINKEDIN_AUTH_COOKIE_NAMES = new Set([
  "li_at",
  "JSESSIONID",
  "liap",
  "bscookie",
  "bcookie",
]);

type StorageStateCookie = LinkedInBrowserStorageState["cookies"][number];

/**
 * Redacted metadata describing the LinkedIn authentication cookies present in a
 * captured storage-state snapshot.
 */
export interface LinkedInSessionCookieMetadata {
  name: string;
  domain: string;
  path: string;
  expiresAt: string | null;
  expiresInMs: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: StorageStateCookie["sameSite"];
}

function isSupportedSameSite(
  value: unknown,
): value is LinkedInSessionCookieMetadata["sameSite"] | undefined {
  return (
    value === undefined ||
    value === "Lax" ||
    value === "Strict" ||
    value === "None"
  );
}

function isLinkedInCookie(cookie: Pick<StorageStateCookie, "domain">): boolean {
  return cookie.domain.toLowerCase().includes("linkedin.com");
}

function isLinkedInAuthCookie(
  cookie: Pick<StorageStateCookie, "name" | "domain">,
): boolean {
  return (
    isLinkedInCookie(cookie) && LINKEDIN_AUTH_COOKIE_NAMES.has(cookie.name)
  );
}

function toCookieExpiresAt(expires: number): string | null {
  if (!Number.isFinite(expires) || expires <= 0) {
    return null;
  }

  return new Date(expires * 1_000).toISOString();
}

/**
 * Extracts the LinkedIn authentication cookies from a storage-state snapshot
 * and returns them ordered by expiry.
 */
export function summarizeLinkedInSessionCookies(
  cookies: readonly StorageStateCookie[],
  options: { nowMs?: number } = {},
): LinkedInSessionCookieMetadata[] {
  const nowMs = options.nowMs ?? Date.now();

  return cookies
    .filter((cookie) => isLinkedInAuthCookie(cookie))
    .map((cookie) => {
      const expiresAt = toCookieExpiresAt(cookie.expires);
      const expiresInMs =
        expiresAt === null ? null : new Date(expiresAt).getTime() - nowMs;

      return {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        expiresAt,
        expiresInMs,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      };
    })
    .sort((left, right) => {
      const leftExpiry =
        left.expiresAt === null
          ? Number.POSITIVE_INFINITY
          : new Date(left.expiresAt).getTime();
      const rightExpiry =
        right.expiresAt === null
          ? Number.POSITIVE_INFINITY
          : new Date(right.expiresAt).getTime();

      if (leftExpiry !== rightExpiry) {
        return leftExpiry - rightExpiry;
      }

      return left.name.localeCompare(right.name);
    });
}

/**
 * Computes a stable fingerprint for the LinkedIn authentication cookies in a
 * storage-state snapshot.
 */
export function getLinkedInSessionFingerprint(
  storageState: Pick<LinkedInBrowserStorageState, "cookies">,
): string {
  const authCookiePayload = storageState.cookies
    .filter((cookie) => isLinkedInAuthCookie(cookie))
    .sort((left, right) => {
      const leftKey = `${left.name}\u0000${left.domain}\u0000${left.path}`;
      const rightKey = `${right.name}\u0000${right.domain}\u0000${right.path}`;
      return leftKey.localeCompare(rightKey);
    })
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));

  return createHash("sha256")
    .update(JSON.stringify(authCookiePayload))
    .digest("hex");
}

/**
 * Restores the LinkedIn cookies from a storage-state snapshot into an existing
 * Playwright browser context.
 */
export async function restoreLinkedInSessionCookies(
  context: BrowserContext,
  storageState: LinkedInBrowserStorageState,
): Promise<void> {
  const cookiesToRestore = storageState.cookies.filter((cookie) =>
    isLinkedInCookie(cookie),
  );
  if (cookiesToRestore.length === 0) {
    return;
  }

  await context.addCookies(cookiesToRestore);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

interface StoredLinkedInSessionEnvelope {
  version: number;
  algorithm: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  tag: string;
  metadata: StoredLinkedInSessionMetadataRecord;
}

interface StoredLinkedInSessionMetadataRecord {
  capturedAt: string;
  cookieCount: number;
  hasLinkedInAuthCookie: boolean;
  liAtCookieExpiresAt: string | null;
  originCount: number;
  sessionName: string;
  sessionCookieFingerprint?: string;
  sessionCookies?: LinkedInSessionCookieMetadata[];
}

/**
 * Metadata returned when a stored LinkedIn session snapshot is saved or loaded.
 */
export interface StoredLinkedInSessionMetadata {
  capturedAt: string;
  cookieCount: number;
  filePath: string;
  hasLinkedInAuthCookie: boolean;
  liAtCookieExpiresAt: string | null;
  originCount: number;
  sessionName: string;
  sessionCookieFingerprint?: string;
  sessionCookies?: LinkedInSessionCookieMetadata[];
}

/**
 * Result returned by `LinkedInSessionStore.load()`.
 */
export interface LoadStoredLinkedInSessionResult {
  metadata: StoredLinkedInSessionMetadata;
  storageState: LinkedInBrowserStorageState;
}

/**
 * Options for snapshot rotation when saving a LinkedIn session.
 */
export interface SaveStoredLinkedInSessionOptions {
  maxBackups?: number;
}

/**
 * Options controlling restore fallback behavior.
 */
export interface RestoreStoredLinkedInSessionOptions {
  allowExpired?: boolean;
  maxBackups?: number;
}

/**
 * Result returned when a stored LinkedIn session snapshot is restored.
 */
export interface RestoreStoredLinkedInSessionResult extends LoadStoredLinkedInSessionResult {
  restoredFromBackup: boolean;
  restoredSessionName: string;
}

/**
 * Options for the interactive manual-login capture helper.
 */
export interface CaptureLinkedInSessionOptions {
  baseDir?: string;
  /** When true, apply stealth/evasion hardening to the capture browser. */
  stealth?: boolean;
  /** Evasion level to use if stealth is enabled. Defaults to env/config. */
  evasionLevel?: string;
  pollIntervalMs?: number;
  sessionName?: string;
  timeoutMs?: number;
}

/**
 * Result returned by `captureLinkedInSession()` after a successful manual login
 * capture.
 */
export interface CaptureLinkedInSessionResult extends StoredLinkedInSessionMetadata {
  authenticated: true;
  checkedAt: string;
  currentUrl: string;
  /** Browser fingerprint captured during manual login, if available. */
  fingerprint?: BrowserFingerprint;
  /** On-disk path where the fingerprint was stored. */
  fingerprintPath?: string;
}

function withPlaywrightInstallHint(error: unknown): Error {
  if (
    error instanceof Error &&
    error.message.includes("Executable doesn't exist")
  ) {
    return new Error(
      'Playwright browser executable is missing. Install Chromium with "npx playwright install chromium" or set PLAYWRIGHT_EXECUTABLE_PATH.',
    );
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function normalizeSessionName(sessionName: string | undefined): string {
  const normalized = (sessionName ?? "default").trim();
  if (normalized.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "session name must not be empty.",
    );
  }

  if (normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "session name must not contain path separators or relative path segments.",
      {
        session_name: normalized,
      },
    );
  }

  return normalized;
}

function getBackupSessionName(sessionName: string, index: number): string {
  return `${normalizeSessionName(sessionName)}.backup-${index}`;
}

function getFallbackSessionNames(
  sessionName: string,
  maxBackups: number,
): string[] {
  const normalizedSessionName = normalizeSessionName(sessionName);
  return [
    normalizedSessionName,
    ...Array.from({ length: maxBackups }, (_, index) =>
      getBackupSessionName(normalizedSessionName, index + 1),
    ),
  ];
}

function getLinkedInAuthCookie(
  storageState: LinkedInBrowserStorageState,
): LinkedInBrowserStorageState["cookies"][number] | undefined {
  return storageState.cookies.find(
    (cookie) => cookie.name === "li_at" && cookie.value.trim().length > 0,
  );
}

function isStoredSessionExpired(
  storageState: LinkedInBrowserStorageState,
  referenceTimeMs: number = Date.now(),
): boolean {
  const authCookie = getLinkedInAuthCookie(storageState);
  if (!authCookie) {
    return true;
  }

  if (typeof authCookie.expires !== "number" || authCookie.expires <= 0) {
    return false;
  }

  return authCookie.expires * 1_000 <= referenceTimeMs;
}

function createStoredSessionValidationError(
  message: string,
  sessionName: string,
  filePath: string,
  cause?: Error,
): LinkedInBuddyError {
  return new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    message,
    {
      file_path: filePath,
      session_name: sessionName,
    },
    cause ? { cause } : undefined,
  );
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function deriveMachineBoundKey(rawKey: Buffer): Buffer {
  return createHash("sha256")
    .update(rawKey)
    .update("\0")
    .update(os.hostname())
    .update("\0")
    .update(os.userInfo().username)
    .digest();
}

function decodeBase64Url(value: string, label: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Stored LinkedIn session ${label} is malformed. Capture a fresh session and retry.`,
      {
        label,
      },
      {
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
}

function getLinkedInAuthCookieExpiry(
  storageState: LinkedInBrowserStorageState,
): string | null {
  const authCookie = storageState.cookies.find(
    (cookie) => cookie.name === "li_at",
  );
  if (
    !authCookie ||
    typeof authCookie.expires !== "number" ||
    authCookie.expires <= 0
  ) {
    return null;
  }

  return toCookieExpiresAt(authCookie.expires);
}

function createStoredSessionMetadata(
  sessionName: string,
  filePath: string,
  storageState: LinkedInBrowserStorageState,
  capturedAt: string = new Date().toISOString(),
): StoredLinkedInSessionMetadata {
  const hasLinkedInAuthCookie = storageState.cookies.some(
    (cookie) => cookie.name === "li_at" && cookie.value.trim().length > 0,
  );

  return {
    capturedAt,
    cookieCount: storageState.cookies.length,
    filePath,
    hasLinkedInAuthCookie,
    liAtCookieExpiresAt: getLinkedInAuthCookieExpiry(storageState),
    originCount: storageState.origins.length,
    sessionName,
    sessionCookieFingerprint: getLinkedInSessionFingerprint(storageState),
    sessionCookies: summarizeLinkedInSessionCookies(storageState.cookies, {
      nowMs: new Date(capturedAt).getTime(),
    }),
  };
}

function toStoredMetadataRecord(
  metadata: StoredLinkedInSessionMetadata,
): StoredLinkedInSessionMetadataRecord {
  return {
    capturedAt: metadata.capturedAt,
    cookieCount: metadata.cookieCount,
    hasLinkedInAuthCookie: metadata.hasLinkedInAuthCookie,
    liAtCookieExpiresAt: metadata.liAtCookieExpiresAt,
    originCount: metadata.originCount,
    sessionName: metadata.sessionName,
    ...(metadata.sessionCookieFingerprint
      ? { sessionCookieFingerprint: metadata.sessionCookieFingerprint }
      : {}),
    ...(metadata.sessionCookies
      ? { sessionCookies: metadata.sessionCookies }
      : {}),
  };
}

function toStoredMetadata(
  metadata: StoredLinkedInSessionMetadataRecord,
  filePath: string,
): StoredLinkedInSessionMetadata {
  return {
    capturedAt: metadata.capturedAt,
    cookieCount: metadata.cookieCount,
    filePath,
    hasLinkedInAuthCookie: metadata.hasLinkedInAuthCookie,
    liAtCookieExpiresAt: metadata.liAtCookieExpiresAt,
    originCount: metadata.originCount,
    sessionName: metadata.sessionName,
    ...(metadata.sessionCookieFingerprint
      ? { sessionCookieFingerprint: metadata.sessionCookieFingerprint }
      : {}),
    ...(metadata.sessionCookies
      ? { sessionCookies: metadata.sessionCookies }
      : {}),
  };
}

async function ensureOwnerOnlyPermissions(targetPath: string): Promise<void> {
  try {
    await chmod(targetPath, 0o600);
  } catch {
    // Best effort: chmod is not reliable across every platform/filesystem.
  }
}

async function readOrCreateMasterKey(storeDir: string): Promise<Buffer> {
  const keyPath = path.join(storeDir, SESSION_STORE_KEY_FILE_NAME);

  try {
    const existingKey = await readFile(keyPath);
    if (existingKey.length === 32) {
      return deriveMachineBoundKey(existingKey);
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const rawKey = randomBytes(32);
  await writeFile(keyPath, rawKey);
  await ensureOwnerOnlyPermissions(keyPath);
  return deriveMachineBoundKey(rawKey);
}

function validateEnvelope(
  envelope: unknown,
  sessionName: string,
  filePath: string,
): StoredLinkedInSessionEnvelope {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("version" in envelope) ||
    !("algorithm" in envelope) ||
    !("ciphertext" in envelope) ||
    !("iv" in envelope) ||
    !("tag" in envelope) ||
    !("metadata" in envelope)
  ) {
    throw createStoredSessionValidationError(
      `Stored LinkedIn session "${sessionName}" is malformed. Capture a fresh session and retry.`,
      sessionName,
      filePath,
    );
  }

  const normalizedEnvelope = envelope as Partial<StoredLinkedInSessionEnvelope>;
  if (
    normalizedEnvelope.version !== SESSION_STORE_SCHEMA_VERSION ||
    normalizedEnvelope.algorithm !== "aes-256-gcm" ||
    typeof normalizedEnvelope.ciphertext !== "string" ||
    typeof normalizedEnvelope.iv !== "string" ||
    typeof normalizedEnvelope.tag !== "string" ||
    typeof normalizedEnvelope.metadata !== "object" ||
    normalizedEnvelope.metadata === null
  ) {
    throw createStoredSessionValidationError(
      `Stored LinkedIn session "${sessionName}" is unreadable. Capture a fresh session and retry.`,
      sessionName,
      filePath,
    );
  }

  const metadata =
    normalizedEnvelope.metadata as Partial<StoredLinkedInSessionMetadataRecord>;
  if (
    typeof metadata.sessionName !== "string" ||
    typeof metadata.capturedAt !== "string" ||
    typeof metadata.cookieCount !== "number" ||
    typeof metadata.originCount !== "number" ||
    typeof metadata.hasLinkedInAuthCookie !== "boolean" ||
    !(
      metadata.sessionCookieFingerprint === undefined ||
      typeof metadata.sessionCookieFingerprint === "string"
    ) ||
    !(
      metadata.sessionCookies === undefined ||
      (Array.isArray(metadata.sessionCookies) &&
        metadata.sessionCookies.every(
          (cookie) =>
            typeof cookie === "object" &&
            cookie !== null &&
            typeof cookie.name === "string" &&
            typeof cookie.domain === "string" &&
            typeof cookie.path === "string" &&
            (cookie.expiresAt === null ||
              typeof cookie.expiresAt === "string") &&
            (cookie.expiresInMs === null ||
              typeof cookie.expiresInMs === "number") &&
            typeof cookie.httpOnly === "boolean" &&
            typeof cookie.secure === "boolean" &&
            isSupportedSameSite((cookie as { sameSite?: unknown }).sameSite),
        ))
    ) ||
    !(
      metadata.liAtCookieExpiresAt === null ||
      typeof metadata.liAtCookieExpiresAt === "string"
    )
  ) {
    throw createStoredSessionValidationError(
      `Stored LinkedIn session "${sessionName}" is unreadable. Capture a fresh session and retry.`,
      sessionName,
      filePath,
    );
  }

  return {
    version: normalizedEnvelope.version,
    algorithm: normalizedEnvelope.algorithm,
    ciphertext: normalizedEnvelope.ciphertext,
    iv: normalizedEnvelope.iv,
    tag: normalizedEnvelope.tag,
    metadata: {
      capturedAt: metadata.capturedAt,
      cookieCount: metadata.cookieCount,
      hasLinkedInAuthCookie: metadata.hasLinkedInAuthCookie,
      liAtCookieExpiresAt: metadata.liAtCookieExpiresAt ?? null,
      originCount: metadata.originCount,
      sessionName: metadata.sessionName,
      ...(metadata.sessionCookieFingerprint
        ? { sessionCookieFingerprint: metadata.sessionCookieFingerprint }
        : {}),
      ...(metadata.sessionCookies
        ? { sessionCookies: metadata.sessionCookies }
        : {}),
    },
  };
}

function validateStorageState(
  value: unknown,
  sessionName: string,
  filePath: string,
): LinkedInBrowserStorageState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("cookies" in value) ||
    !("origins" in value) ||
    !Array.isArray((value as { cookies: unknown }).cookies) ||
    !Array.isArray((value as { origins: unknown }).origins)
  ) {
    throw createStoredSessionValidationError(
      `Stored LinkedIn session "${sessionName}" could not be decoded. Capture a fresh session and retry.`,
      sessionName,
      filePath,
    );
  }

  return value as LinkedInBrowserStorageState;
}

/**
 * Resolves the directory that stores encrypted LinkedIn session snapshots.
 */
export function resolveLinkedInSessionStoreDir(baseDir?: string): string {
  return path.join(resolveConfigPaths(baseDir).profilesDir, "stored-sessions");
}

/**
 * Resolves the encrypted on-disk file path for a named stored LinkedIn session.
 */
export function resolveStoredLinkedInSessionPath(
  sessionName: string = "default",
  baseDir?: string,
): string {
  const normalizedSessionName = normalizeSessionName(sessionName);
  return path.join(
    resolveLinkedInSessionStoreDir(baseDir),
    `${normalizedSessionName}${SESSION_FILE_SUFFIX}`,
  );
}

/**
 * Encrypts, rotates, loads, and restores named LinkedIn session snapshots.
 */
export class LinkedInSessionStore {
  /**
   * Creates a session store rooted in the default tool home or a custom base
   * directory.
   */
  constructor(private readonly baseDir?: string) {}

  /**
   * Returns the encrypted session file path for the provided session name.
   */
  getSessionPath(sessionName: string = "default"): string {
    return resolveStoredLinkedInSessionPath(sessionName, this.baseDir);
  }

  /**
   * Saves the provided storage-state snapshot as the primary encrypted session
   * file for `sessionName`.
   */
  async save(
    sessionName: string,
    storageState: LinkedInBrowserStorageState,
  ): Promise<StoredLinkedInSessionMetadata> {
    const normalizedSessionName = normalizeSessionName(sessionName);
    ensureConfigPaths(resolveConfigPaths(this.baseDir));
    const storeDir = resolveLinkedInSessionStoreDir(this.baseDir);
    await mkdir(storeDir, { recursive: true });

    const filePath = this.getSessionPath(normalizedSessionName);
    const metadata = createStoredSessionMetadata(
      normalizedSessionName,
      filePath,
      storageState,
    );

    const encryptionKey = await readOrCreateMasterKey(storeDir);
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const plaintext = JSON.stringify(storageState);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const envelope: StoredLinkedInSessionEnvelope = {
      version: SESSION_STORE_SCHEMA_VERSION,
      algorithm: "aes-256-gcm",
      ciphertext: encodeBase64Url(ciphertext),
      iv: encodeBase64Url(iv),
      tag: encodeBase64Url(tag),
      metadata: toStoredMetadataRecord(metadata),
    };

    await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    await ensureOwnerOnlyPermissions(filePath);

    return metadata;
  }

  /**
   * Saves a session snapshot and rotates older copies into numbered backup
   * slots.
   */
  async saveWithBackups(
    sessionName: string,
    storageState: LinkedInBrowserStorageState,
    options: SaveStoredLinkedInSessionOptions = {},
  ): Promise<StoredLinkedInSessionMetadata> {
    const normalizedSessionName = normalizeSessionName(sessionName);
    const maxBackups = Math.max(0, options.maxBackups ?? 2);

    if (maxBackups > 0) {
      for (let backupIndex = maxBackups; backupIndex >= 2; backupIndex -= 1) {
        const sourceBackupName = getBackupSessionName(
          normalizedSessionName,
          backupIndex - 1,
        );

        if (!(await this.exists(sourceBackupName))) {
          continue;
        }

        const sourceBackup = await this.load(sourceBackupName);
        await this.save(
          getBackupSessionName(normalizedSessionName, backupIndex),
          sourceBackup.storageState,
        );
      }

      if (await this.exists(normalizedSessionName)) {
        const previousPrimary = await this.load(normalizedSessionName);
        await this.save(
          getBackupSessionName(normalizedSessionName, 1),
          previousPrimary.storageState,
        );
      }
    }

    return this.save(normalizedSessionName, storageState);
  }

  /**
   * Returns whether an encrypted session snapshot exists for `sessionName`.
   */
  async exists(sessionName: string = "default"): Promise<boolean> {
    try {
      await readFile(this.getSessionPath(sessionName), "utf8");
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Loads and decrypts a named stored LinkedIn session snapshot.
   */
  async load(
    sessionName: string = "default",
  ): Promise<LoadStoredLinkedInSessionResult> {
    const normalizedSessionName = normalizeSessionName(sessionName);
    const filePath = this.getSessionPath(normalizedSessionName);

    let rawEnvelope: string;
    try {
      rawEnvelope = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new LinkedInBuddyError(
          "AUTH_REQUIRED",
          `No stored LinkedIn session named "${normalizedSessionName}" was found. Run "linkedin-buddy auth session --session ${normalizedSessionName}" first.`,
          {
            file_path: filePath,
            session_name: normalizedSessionName,
          },
        );
      }
      throw error;
    }

    const parsedEnvelope = validateEnvelope(
      JSON.parse(rawEnvelope) as unknown,
      normalizedSessionName,
      filePath,
    );
    const storeDir = resolveLinkedInSessionStoreDir(this.baseDir);
    const encryptionKey = await readOrCreateMasterKey(storeDir);

    let storageState: LinkedInBrowserStorageState;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey,
        decodeBase64Url(parsedEnvelope.iv, "iv"),
      );
      decipher.setAuthTag(decodeBase64Url(parsedEnvelope.tag, "tag"));
      const decryptedPayload = Buffer.concat([
        decipher.update(
          decodeBase64Url(parsedEnvelope.ciphertext, "ciphertext"),
        ),
        decipher.final(),
      ]).toString("utf8");
      storageState = validateStorageState(
        JSON.parse(decryptedPayload) as unknown,
        normalizedSessionName,
        filePath,
      );
    } catch (error) {
      throw createStoredSessionValidationError(
        `Stored LinkedIn session "${normalizedSessionName}" could not be decrypted. Capture a fresh session and retry.`,
        normalizedSessionName,
        filePath,
        error instanceof Error ? error : undefined,
      );
    }

    return {
      metadata: toStoredMetadata(parsedEnvelope.metadata, filePath),
      storageState,
    };
  }

  /**
   * Loads the newest usable stored session, falling back through backups when
   * needed.
   */
  async loadLatestAvailable(
    sessionName: string = "default",
    options: RestoreStoredLinkedInSessionOptions = {},
  ): Promise<RestoreStoredLinkedInSessionResult> {
    const normalizedSessionName = normalizeSessionName(sessionName);
    const maxBackups = Math.max(0, options.maxBackups ?? 2);
    let lastValidationError: Error | undefined;

    for (const candidateSessionName of getFallbackSessionNames(
      normalizedSessionName,
      maxBackups,
    )) {
      try {
        const loadedSession = await this.load(candidateSessionName);
        if (
          !options.allowExpired &&
          isStoredSessionExpired(loadedSession.storageState)
        ) {
          continue;
        }

        return {
          ...loadedSession,
          restoredFromBackup: candidateSessionName !== normalizedSessionName,
          restoredSessionName: candidateSessionName,
        };
      } catch (error) {
        if (
          error instanceof LinkedInBuddyError &&
          ["AUTH_REQUIRED", "ACTION_PRECONDITION_FAILED"].includes(error.code)
        ) {
          lastValidationError = error;
          continue;
        }

        throw error;
      }
    }

    throw new LinkedInBuddyError(
      "AUTH_REQUIRED",
      `No non-expired stored LinkedIn session named "${normalizedSessionName}" was found. Capture a fresh session and retry.`,
      {
        session_name: normalizedSessionName,
        ...(lastValidationError instanceof Error
          ? { cause: lastValidationError.message }
          : {}),
      },
      lastValidationError instanceof Error
        ? { cause: lastValidationError }
        : undefined,
    );
  }

  /**
   * Restores the latest usable stored session snapshot into an existing
   * Playwright browser context.
   */
  async restoreToContext(
    context: BrowserContext,
    sessionName: string = "default",
    options: RestoreStoredLinkedInSessionOptions = {},
  ): Promise<RestoreStoredLinkedInSessionResult> {
    const restoredSession = await this.loadLatestAvailable(
      sessionName,
      options,
    );

    await context.addCookies(restoredSession.storageState.cookies);
    await restoreOriginStorageToContext(context, restoredSession.storageState);

    return restoredSession;
  }
}

async function getOrCreatePage(context: BrowserContext) {
  const existingPage = context.pages()[0];

  return existingPage ?? context.newPage();
}

async function restoreOriginStorageToContext(
  context: BrowserContext,
  storageState: LinkedInBrowserStorageState,
): Promise<void> {
  if (storageState.origins.length === 0) {
    return;
  }

  const page = await getOrCreatePage(context);

  for (const originState of storageState.origins) {
    try {
      await page.goto(originState.origin, {
        waitUntil: "domcontentloaded",
      });
      await page.evaluate((localStorageEntries) => {
        globalThis.localStorage.clear();
        for (const entry of localStorageEntries) {
          globalThis.localStorage.setItem(entry.name, entry.value);
        }
      }, originState.localStorage);
    } catch {
      // Restoring origin-scoped storage is best-effort; cookies are the critical part.
    }
  }
}

async function waitForManualLogin(
  context: BrowserContext,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<LinkedInSessionInspection> {
  const page = await getOrCreatePage(context);
  await page.goto("https://www.linkedin.com/login", {
    waitUntil: "domcontentloaded",
  });

  const deadline = Date.now() + timeoutMs;
  let lastStatus = await inspectLinkedInSession(page);

  while (!lastStatus.authenticated && Date.now() < deadline) {
    await page.waitForTimeout(pollIntervalMs);
    lastStatus = await inspectLinkedInSession(page);
  }

  if (!lastStatus.authenticated) {
    throw new LinkedInBuddyError(
      "AUTH_REQUIRED",
      "Timed out waiting for a manual LinkedIn login. Finish the login in the opened browser and rerun the session capture command.",
      {
        current_url: lastStatus.currentUrl,
        reason: lastStatus.reason,
        timeout_ms: timeoutMs,
      },
    );
  }

  return lastStatus;
}

/**
 * Opens a visible Chromium browser, waits for a manual LinkedIn login, and
 * persists the resulting authenticated session snapshot.
 */
export async function captureLinkedInSession(
  options: CaptureLinkedInSessionOptions = {},
): Promise<CaptureLinkedInSessionResult> {
  const sessionName = normalizeSessionName(options.sessionName);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_CAPTURE_POLL_INTERVAL_MS;

  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "timeoutMs must be a positive number.",
    );
  }
  if (pollIntervalMs <= 0 || !Number.isFinite(pollIntervalMs)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "pollIntervalMs must be a positive number.",
    );
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    const useStealth = options.stealth ?? true;
    const evasion = resolveEvasionConfig(
      options.evasionLevel ? { level: options.evasionLevel } : {},
    );
    const stealthConfig = resolveStealthConfig(evasion.level);
    const effectiveStealthConfig = useStealth
      ? stealthConfig
      : { ...stealthConfig, enabled: false };

    const launcher = await createStealthChromium(effectiveStealthConfig);
    const launchOptions = applyStealthLaunchOptions(
      {
        headless: false,
        ...(executablePath ? { executablePath } : {}),
      },
      effectiveStealthConfig,
    );
    browser = await launcher.launch(launchOptions);
    context = await browser.newContext();
    await hardenBrowserContext(context, effectiveStealthConfig);
    const status = await waitForManualLogin(
      wrapLinkedInBrowserContext(context),
      timeoutMs,
      pollIntervalMs,
    );
    const storageState = await context.storageState();
    // Capture browser fingerprint from the authenticated page
    const page = context.pages()[0];
    let fingerprint: BrowserFingerprint | undefined;
    let fingerprintPath: string | undefined;
    if (page) {
      try {
        fingerprint = await captureBrowserFingerprint(page);
        fingerprintPath = await saveBrowserFingerprint(
          fingerprint,
          sessionName,
          options.baseDir,
        );
      } catch {
        // Fingerprint capture is best-effort; session capture is the priority.
      }
    }
    const store = new LinkedInSessionStore(options.baseDir);
    const metadata = await store.save(sessionName, storageState);

    if (!metadata.hasLinkedInAuthCookie) {
      throw new LinkedInBuddyError(
        "AUTH_REQUIRED",
        "LinkedIn login appeared successful, but no authenticated session cookie was captured. Capture the session again after the home feed loads fully.",
        {
          current_url: status.currentUrl,
          session_name: sessionName,
        },
      );
    }

    return {
      ...metadata,
      ...(fingerprint ? { fingerprint } : {}),
      ...(fingerprintPath ? { fingerprintPath } : {}),
      authenticated: true,
      checkedAt: status.checkedAt,
      currentUrl: status.currentUrl,
    };
  } catch (error) {
    throw asLinkedInBuddyError(
      withPlaywrightInstallHint(error),
      error instanceof LinkedInBuddyError ? error.code : "UNKNOWN",
      "Failed to capture the LinkedIn browser session.",
    );
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
