import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { resolveConfigPaths } from "../config.js";
import { LinkedInBuddyError } from "../errors.js";
import { resolveLinkedInSessionStoreDir } from "./sessionStore.js";

const SESSION_STORE_KEY_FILE_NAME = ".session-store.key";
const FINGERPRINT_FILE_SUFFIX = ".fingerprint.enc.json";
const FINGERPRINT_SCHEMA_VERSION = 1;
const AES_GCM_IV_BYTES = 12;

type BrowserType = typeof chromium;
type PersistentLaunchOptions = NonNullable<
  Parameters<BrowserType["launchPersistentContext"]>[1]
>;

type FingerprintLaunchOptions = Pick<
  PersistentLaunchOptions,
  | "viewport"
  | "locale"
  | "timezoneId"
  | "userAgent"
  | "colorScheme"
  | "deviceScaleFactor"
>;
type FingerprintColorScheme = BrowserFingerprint["colorScheme"];

interface StoredBrowserFingerprintEnvelope {
  version: number;
  algorithm: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Browser-level fingerprint values captured from a live Playwright page.
 */
export interface BrowserFingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
  timezone: string;
  locale: string;
  platform: string;
  webglRenderer: string | null;
  deviceScaleFactor: number;
  colorScheme: "light" | "dark" | "no-preference";
  capturedAt: string;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeSessionName(sessionName: string): string {
  const normalized = sessionName.trim();
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
      `Stored browser fingerprint ${label} is malformed. Capture a fresh fingerprint and retry.`,
      {
        label,
      },
      {
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
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

function validateStoredBrowserFingerprint(
  value: unknown,
  sessionName: string,
  filePath: string,
): BrowserFingerprint {
  if (
    typeof value !== "object" ||
    value === null ||
    !("userAgent" in value) ||
    !("viewport" in value) ||
    !("timezone" in value) ||
    !("locale" in value) ||
    !("platform" in value) ||
    !("deviceScaleFactor" in value) ||
    !("colorScheme" in value) ||
    !("capturedAt" in value)
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Stored browser fingerprint "${sessionName}" is unreadable. Capture a fresh fingerprint and retry.`,
      {
        file_path: filePath,
        session_name: sessionName,
      },
    );
  }

  const candidate = value as Partial<BrowserFingerprint>;
  if (
    typeof candidate.userAgent !== "string" ||
    typeof candidate.timezone !== "string" ||
    typeof candidate.locale !== "string" ||
    typeof candidate.platform !== "string" ||
    typeof candidate.deviceScaleFactor !== "number" ||
    (candidate.colorScheme !== "light" &&
      candidate.colorScheme !== "dark" &&
      candidate.colorScheme !== "no-preference") ||
    typeof candidate.capturedAt !== "string" ||
    typeof candidate.viewport !== "object" ||
    candidate.viewport === null ||
    typeof candidate.viewport.width !== "number" ||
    typeof candidate.viewport.height !== "number" ||
    !(
      candidate.webglRenderer === null ||
      typeof candidate.webglRenderer === "string"
    )
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Stored browser fingerprint "${sessionName}" is malformed. Capture a fresh fingerprint and retry.`,
      {
        file_path: filePath,
        session_name: sessionName,
      },
    );
  }

  return {
    userAgent: candidate.userAgent,
    viewport: {
      width: candidate.viewport.width,
      height: candidate.viewport.height,
    },
    timezone: candidate.timezone,
    locale: candidate.locale,
    platform: candidate.platform,
    webglRenderer: candidate.webglRenderer,
    deviceScaleFactor: candidate.deviceScaleFactor,
    colorScheme: candidate.colorScheme,
    capturedAt: candidate.capturedAt,
  };
}

function validateEnvelope(
  envelope: unknown,
  sessionName: string,
  filePath: string,
): StoredBrowserFingerprintEnvelope {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("version" in envelope) ||
    !("algorithm" in envelope) ||
    !("ciphertext" in envelope) ||
    !("iv" in envelope) ||
    !("tag" in envelope)
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Stored browser fingerprint "${sessionName}" is malformed. Capture a fresh fingerprint and retry.`,
      {
        file_path: filePath,
        session_name: sessionName,
      },
    );
  }

  const normalizedEnvelope =
    envelope as Partial<StoredBrowserFingerprintEnvelope>;
  if (
    normalizedEnvelope.version !== FINGERPRINT_SCHEMA_VERSION ||
    normalizedEnvelope.algorithm !== "aes-256-gcm" ||
    typeof normalizedEnvelope.ciphertext !== "string" ||
    typeof normalizedEnvelope.iv !== "string" ||
    typeof normalizedEnvelope.tag !== "string"
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Stored browser fingerprint "${sessionName}" is unreadable. Capture a fresh fingerprint and retry.`,
      {
        file_path: filePath,
        session_name: sessionName,
      },
    );
  }

  return {
    version: normalizedEnvelope.version,
    algorithm: normalizedEnvelope.algorithm,
    ciphertext: normalizedEnvelope.ciphertext,
    iv: normalizedEnvelope.iv,
    tag: normalizedEnvelope.tag,
  };
}

/**
 * Resolves the encrypted on-disk file path for a named stored browser
 * fingerprint.
 */
export function resolveLinkedInFingerprintPath(
  sessionName: string,
  baseDir?: string,
): string {
  const normalizedSessionName = normalizeSessionName(sessionName);
  return path.join(
    resolveLinkedInSessionStoreDir(baseDir),
    `${normalizedSessionName}${FINGERPRINT_FILE_SUFFIX}`,
  );
}

/**
 * Captures browser fingerprint signals from a live Playwright page.
 */
export async function captureBrowserFingerprint(
  page: Page,
): Promise<BrowserFingerprint> {
  const viewportSize = page.viewportSize();
  const browserSignals = await page.evaluate(() => {
    const colorScheme: FingerprintColorScheme = globalThis.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches
      ? "dark"
      : globalThis.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "no-preference";

    const canvas = globalThis.document.createElement("canvas");
    const context =
      canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl");
    let webglRenderer: string | null = null;

    if (context && "getExtension" in context && "getParameter" in context) {
      const debugInfo = context.getExtension("WEBGL_debug_renderer_info") as {
        UNMASKED_RENDERER_WEBGL: number;
      } | null;

      if (debugInfo) {
        const renderer = context.getParameter(
          debugInfo.UNMASKED_RENDERER_WEBGL,
        );
        webglRenderer = typeof renderer === "string" ? renderer : null;
      }
    }

    return {
      userAgent: globalThis.navigator.userAgent,
      platform: globalThis.navigator.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: globalThis.navigator.language,
      webglRenderer,
      deviceScaleFactor: globalThis.devicePixelRatio,
      colorScheme,
      fallbackViewport: {
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
      },
    };
  });

  return {
    userAgent: browserSignals.userAgent,
    viewport: viewportSize ?? browserSignals.fallbackViewport,
    timezone: browserSignals.timezone,
    locale: browserSignals.locale,
    platform: browserSignals.platform,
    webglRenderer: browserSignals.webglRenderer,
    deviceScaleFactor: browserSignals.deviceScaleFactor,
    colorScheme: browserSignals.colorScheme,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Encrypts and saves a named browser fingerprint in the session store.
 */
export async function saveBrowserFingerprint(
  fingerprint: BrowserFingerprint,
  sessionName: string,
  baseDir?: string,
): Promise<string> {
  const normalizedSessionName = normalizeSessionName(sessionName);
  const { profilesDir } = resolveConfigPaths(baseDir);
  await mkdir(profilesDir, { recursive: true });

  const storeDir = resolveLinkedInSessionStoreDir(baseDir);
  await mkdir(storeDir, { recursive: true });

  const filePath = resolveLinkedInFingerprintPath(
    normalizedSessionName,
    baseDir,
  );
  const encryptionKey = await readOrCreateMasterKey(storeDir);
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(fingerprint), "utf8"),
    cipher.final(),
  ]);

  const envelope: StoredBrowserFingerprintEnvelope = {
    version: FINGERPRINT_SCHEMA_VERSION,
    algorithm: "aes-256-gcm",
    ciphertext: encodeBase64Url(ciphertext),
    iv: encodeBase64Url(iv),
    tag: encodeBase64Url(cipher.getAuthTag()),
  };

  await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await ensureOwnerOnlyPermissions(filePath);

  return filePath;
}

/**
 * Loads and decrypts a named browser fingerprint from the session store.
 */
export async function loadBrowserFingerprint(
  sessionName: string,
  baseDir?: string,
): Promise<BrowserFingerprint> {
  const normalizedSessionName = normalizeSessionName(sessionName);
  const filePath = resolveLinkedInFingerprintPath(
    normalizedSessionName,
    baseDir,
  );

  let rawEnvelope: string;
  try {
    rawEnvelope = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new LinkedInBuddyError(
        "AUTH_REQUIRED",
        `No stored browser fingerprint named "${normalizedSessionName}" was found. Capture a fresh session and retry.`,
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
  const storeDir = resolveLinkedInSessionStoreDir(baseDir);
  const encryptionKey = await readOrCreateMasterKey(storeDir);

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      decodeBase64Url(parsedEnvelope.iv, "iv"),
    );
    decipher.setAuthTag(decodeBase64Url(parsedEnvelope.tag, "tag"));
    const decryptedPayload = Buffer.concat([
      decipher.update(decodeBase64Url(parsedEnvelope.ciphertext, "ciphertext")),
      decipher.final(),
    ]).toString("utf8");

    return validateStoredBrowserFingerprint(
      JSON.parse(decryptedPayload) as unknown,
      normalizedSessionName,
      filePath,
    );
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Stored browser fingerprint "${normalizedSessionName}" could not be decrypted. Capture a fresh fingerprint and retry.`,
      {
        file_path: filePath,
        session_name: normalizedSessionName,
      },
      {
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
}

/**
 * Maps a captured browser fingerprint into Playwright persistent launch options.
 */
export function applyBrowserFingerprint(
  fingerprint: BrowserFingerprint,
): FingerprintLaunchOptions {
  return {
    viewport: fingerprint.viewport,
    locale: fingerprint.locale,
    timezoneId: fingerprint.timezone,
    userAgent: fingerprint.userAgent,
    colorScheme: fingerprint.colorScheme,
    deviceScaleFactor: fingerprint.deviceScaleFactor,
  };
}
