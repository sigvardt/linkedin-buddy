import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext
} from "playwright-core";
import { ensureConfigPaths, resolveConfigPaths } from "../config.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "../errors.js";
import {
  inspectLinkedInSession,
  type LinkedInSessionInspection
} from "./sessionInspection.js";

export type LinkedInBrowserStorageState = Awaited<
  ReturnType<BrowserContext["storageState"]>
>;

const DEFAULT_CAPTURE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CAPTURE_POLL_INTERVAL_MS = 2_000;
const SESSION_STORE_KEY_FILE_NAME = ".session-store.key";
const SESSION_FILE_SUFFIX = ".session.enc.json";
const SESSION_STORE_SCHEMA_VERSION = 1;
const AES_GCM_IV_BYTES = 12;

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
}

export interface StoredLinkedInSessionMetadata {
  capturedAt: string;
  cookieCount: number;
  filePath: string;
  hasLinkedInAuthCookie: boolean;
  liAtCookieExpiresAt: string | null;
  originCount: number;
  sessionName: string;
}

export interface LoadStoredLinkedInSessionResult {
  metadata: StoredLinkedInSessionMetadata;
  storageState: LinkedInBrowserStorageState;
}

export interface CaptureLinkedInSessionOptions {
  baseDir?: string;
  pollIntervalMs?: number;
  sessionName?: string;
  timeoutMs?: number;
}

export interface CaptureLinkedInSessionResult
  extends StoredLinkedInSessionMetadata {
  authenticated: true;
  checkedAt: string;
  currentUrl: string;
}

function withPlaywrightInstallHint(error: unknown): Error {
  if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
    return new Error(
      'Playwright browser executable is missing. Install Chromium with "npx playwright install chromium" or set PLAYWRIGHT_EXECUTABLE_PATH.'
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
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "session name must not be empty."
    );
  }

  if (normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "session name must not contain path separators or relative path segments.",
      {
        session_name: normalized
      }
    );
  }

  return normalized;
}

function createStoredSessionValidationError(
  message: string,
  sessionName: string,
  filePath: string,
  cause?: Error
): LinkedInAssistantError {
  return new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    message,
    {
      file_path: filePath,
      session_name: sessionName
    },
    cause ? { cause } : undefined
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
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Stored LinkedIn session ${label} is malformed. Capture a fresh session and retry.`,
      {
        label
      },
      {
        cause: error instanceof Error ? error : undefined
      }
    );
  }
}

function getLinkedInAuthCookieExpiry(
  storageState: LinkedInBrowserStorageState
): string | null {
  const authCookie = storageState.cookies.find((cookie) => cookie.name === "li_at");
  if (!authCookie || typeof authCookie.expires !== "number" || authCookie.expires <= 0) {
    return null;
  }

  return new Date(authCookie.expires * 1_000).toISOString();
}

function createStoredSessionMetadata(
  sessionName: string,
  filePath: string,
  storageState: LinkedInBrowserStorageState,
  capturedAt: string = new Date().toISOString()
): StoredLinkedInSessionMetadata {
  const hasLinkedInAuthCookie = storageState.cookies.some(
    (cookie) => cookie.name === "li_at" && cookie.value.trim().length > 0
  );

  return {
    capturedAt,
    cookieCount: storageState.cookies.length,
    filePath,
    hasLinkedInAuthCookie,
    liAtCookieExpiresAt: getLinkedInAuthCookieExpiry(storageState),
    originCount: storageState.origins.length,
    sessionName
  };
}

function toStoredMetadataRecord(
  metadata: StoredLinkedInSessionMetadata
): StoredLinkedInSessionMetadataRecord {
  return {
    capturedAt: metadata.capturedAt,
    cookieCount: metadata.cookieCount,
    hasLinkedInAuthCookie: metadata.hasLinkedInAuthCookie,
    liAtCookieExpiresAt: metadata.liAtCookieExpiresAt,
    originCount: metadata.originCount,
    sessionName: metadata.sessionName
  };
}

function toStoredMetadata(
  metadata: StoredLinkedInSessionMetadataRecord,
  filePath: string
): StoredLinkedInSessionMetadata {
  return {
    capturedAt: metadata.capturedAt,
    cookieCount: metadata.cookieCount,
    filePath,
    hasLinkedInAuthCookie: metadata.hasLinkedInAuthCookie,
    liAtCookieExpiresAt: metadata.liAtCookieExpiresAt,
    originCount: metadata.originCount,
    sessionName: metadata.sessionName
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
  filePath: string
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
      filePath
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
      filePath
    );
  }

  const metadata = normalizedEnvelope.metadata as Partial<StoredLinkedInSessionMetadataRecord>;
  if (
    typeof metadata.sessionName !== "string" ||
    typeof metadata.capturedAt !== "string" ||
    typeof metadata.cookieCount !== "number" ||
    typeof metadata.originCount !== "number" ||
    typeof metadata.hasLinkedInAuthCookie !== "boolean" ||
    !(
      metadata.liAtCookieExpiresAt === null ||
      typeof metadata.liAtCookieExpiresAt === "string"
    )
  ) {
    throw createStoredSessionValidationError(
      `Stored LinkedIn session "${sessionName}" is unreadable. Capture a fresh session and retry.`,
      sessionName,
      filePath
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
      sessionName: metadata.sessionName
    }
  };
}

function validateStorageState(
  value: unknown,
  sessionName: string,
  filePath: string
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
      filePath
    );
  }

  return value as LinkedInBrowserStorageState;
}

export function resolveLinkedInSessionStoreDir(baseDir?: string): string {
  return path.join(resolveConfigPaths(baseDir).profilesDir, "stored-sessions");
}

export function resolveStoredLinkedInSessionPath(
  sessionName: string = "default",
  baseDir?: string
): string {
  const normalizedSessionName = normalizeSessionName(sessionName);
  return path.join(
    resolveLinkedInSessionStoreDir(baseDir),
    `${normalizedSessionName}${SESSION_FILE_SUFFIX}`
  );
}

export class LinkedInSessionStore {
  constructor(private readonly baseDir?: string) {}

  getSessionPath(sessionName: string = "default"): string {
    return resolveStoredLinkedInSessionPath(sessionName, this.baseDir);
  }

  async save(
    sessionName: string,
    storageState: LinkedInBrowserStorageState
  ): Promise<StoredLinkedInSessionMetadata> {
    const normalizedSessionName = normalizeSessionName(sessionName);
    ensureConfigPaths(resolveConfigPaths(this.baseDir));
    const storeDir = resolveLinkedInSessionStoreDir(this.baseDir);
    await mkdir(storeDir, { recursive: true });

    const filePath = this.getSessionPath(normalizedSessionName);
    const metadata = createStoredSessionMetadata(
      normalizedSessionName,
      filePath,
      storageState
    );

    const encryptionKey = await readOrCreateMasterKey(storeDir);
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const plaintext = JSON.stringify(storageState);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    const envelope: StoredLinkedInSessionEnvelope = {
      version: SESSION_STORE_SCHEMA_VERSION,
      algorithm: "aes-256-gcm",
      ciphertext: encodeBase64Url(ciphertext),
      iv: encodeBase64Url(iv),
      tag: encodeBase64Url(tag),
      metadata: toStoredMetadataRecord(metadata)
    };

    await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    await ensureOwnerOnlyPermissions(filePath);

    return metadata;
  }

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

  async load(sessionName: string = "default"): Promise<LoadStoredLinkedInSessionResult> {
    const normalizedSessionName = normalizeSessionName(sessionName);
    const filePath = this.getSessionPath(normalizedSessionName);

    let rawEnvelope: string;
    try {
      rawEnvelope = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new LinkedInAssistantError(
          "AUTH_REQUIRED",
          `No stored LinkedIn session named "${normalizedSessionName}" was found. Run "owa auth:session --session ${normalizedSessionName}" first.`,
          {
            file_path: filePath,
            session_name: normalizedSessionName
          }
        );
      }
      throw error;
    }

    const parsedEnvelope = validateEnvelope(
      JSON.parse(rawEnvelope) as unknown,
      normalizedSessionName,
      filePath
    );
    const storeDir = resolveLinkedInSessionStoreDir(this.baseDir);
    const encryptionKey = await readOrCreateMasterKey(storeDir);

    let storageState: LinkedInBrowserStorageState;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey,
        decodeBase64Url(parsedEnvelope.iv, "iv")
      );
      decipher.setAuthTag(decodeBase64Url(parsedEnvelope.tag, "tag"));
      const decryptedPayload = Buffer.concat([
        decipher.update(decodeBase64Url(parsedEnvelope.ciphertext, "ciphertext")),
        decipher.final()
      ]).toString("utf8");
      storageState = validateStorageState(
        JSON.parse(decryptedPayload) as unknown,
        normalizedSessionName,
        filePath
      );
    } catch (error) {
      throw createStoredSessionValidationError(
        `Stored LinkedIn session "${normalizedSessionName}" could not be decrypted. Capture a fresh session and retry.`,
        normalizedSessionName,
        filePath,
        error instanceof Error ? error : undefined
      );
    }

    return {
      metadata: toStoredMetadata(parsedEnvelope.metadata, filePath),
      storageState
    };
  }
}

async function getOrCreatePage(context: BrowserContext) {
  const existingPage = context.pages()[0];

  return existingPage ?? context.newPage();
}

async function waitForManualLogin(
  context: BrowserContext,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<LinkedInSessionInspection> {
  const page = await getOrCreatePage(context);
  await page.goto("https://www.linkedin.com/login", {
    waitUntil: "domcontentloaded"
  });

  const deadline = Date.now() + timeoutMs;
  let lastStatus = await inspectLinkedInSession(page);

  while (!lastStatus.authenticated && Date.now() < deadline) {
    await page.waitForTimeout(pollIntervalMs);
    lastStatus = await inspectLinkedInSession(page);
  }

  if (!lastStatus.authenticated) {
    throw new LinkedInAssistantError(
      "AUTH_REQUIRED",
      "Timed out waiting for a manual LinkedIn login. Finish the login in the opened browser and rerun the session capture command.",
      {
        current_url: lastStatus.currentUrl,
        reason: lastStatus.reason,
        timeout_ms: timeoutMs
      }
    );
  }

  return lastStatus;
}

export async function captureLinkedInSession(
  options: CaptureLinkedInSessionOptions = {}
): Promise<CaptureLinkedInSessionResult> {
  const sessionName = normalizeSessionName(options.sessionName);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_CAPTURE_POLL_INTERVAL_MS;

  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "timeoutMs must be a positive number."
    );
  }
  if (pollIntervalMs <= 0 || !Number.isFinite(pollIntervalMs)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "pollIntervalMs must be a positive number."
    );
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    browser = await chromium.launch({
      headless: false,
      ...(executablePath ? { executablePath } : {})
    });
    context = await browser.newContext();
    const status = await waitForManualLogin(context, timeoutMs, pollIntervalMs);
    const storageState = await context.storageState();
    const store = new LinkedInSessionStore(options.baseDir);
    const metadata = await store.save(sessionName, storageState);

    if (!metadata.hasLinkedInAuthCookie) {
      throw new LinkedInAssistantError(
        "AUTH_REQUIRED",
        "LinkedIn login appeared successful, but no authenticated session cookie was captured. Capture the session again after the home feed loads fully.",
        {
          current_url: status.currentUrl,
          session_name: sessionName
        }
      );
    }

    return {
      ...metadata,
      authenticated: true,
      checkedAt: status.checkedAt,
      currentUrl: status.currentUrl
    };
  } catch (error) {
    throw asLinkedInAssistantError(
      withPlaywrightInstallHint(error),
      error instanceof LinkedInAssistantError ? error.code : "UNKNOWN",
      "Failed to capture the LinkedIn browser session."
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
