import { readFile } from "node:fs/promises";
import { LinkedInBuddyError } from "../errors.js";
import { resolveLinkedInFingerprintPath } from "./fingerprint.js";
import { LinkedInSessionStore } from "./sessionStore.js";

type LoadedSession = Awaited<ReturnType<LinkedInSessionStore["load"]>>;
type StoredCookie = LoadedSession["storageState"]["cookies"][number];

const NO_SESSION_GUIDANCE =
  'No stored session found. Run "linkedin login --manual" to authenticate.';
const NO_AUTH_COOKIE_GUIDANCE =
  'Stored session is missing the LinkedIn authentication cookie. Run "linkedin login --manual" to re-authenticate.';
const EXPIRED_SESSION_GUIDANCE =
  'LinkedIn session has expired. Run "linkedin login --manual" to re-authenticate.';
const HEALTHY_SESSION_GUIDANCE = "LinkedIn session is valid and ready to use.";
const NO_FINGERPRINT_NOTE =
  " No browser fingerprint stored — headless sessions may lack fingerprint consistency.";

/** Result from a lightweight session health check. */
export interface SessionHealthCheckResult {
  healthy: boolean;
  sessionName: string;
  checkedAt: string;
  /** Reason for the health status. */
  reason: string;
  /** Whether the encrypted session file exists on disk. */
  sessionExists: boolean;
  /** Whether the li_at auth cookie is present. */
  hasAuthCookie: boolean;
  /** ISO timestamp when the li_at cookie expires, or null. */
  authCookieExpiresAt: string | null;
  /** Milliseconds until expiry (negative = already expired). */
  authCookieExpiresInMs: number | null;
  /** Whether a stored browser fingerprint exists for this session. */
  hasBrowserFingerprint: boolean;
  /** Cookie count in the stored session. */
  cookieCount: number;
  /** Actionable guidance for the operator. */
  guidance: string;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function resolveSessionName(sessionName?: string): string {
  const normalized = (sessionName ?? "default").trim();
  return normalized.length > 0 ? normalized : "default";
}

function getLiAtCookie(
  cookies: readonly StoredCookie[],
): StoredCookie | undefined {
  return cookies.find(
    (cookie) => cookie.name === "li_at" && cookie.value.trim().length > 0,
  );
}

function getCookieExpiry(
  cookie: StoredCookie | undefined,
  checkedAtMs: number,
): {
  authCookieExpiresAt: string | null;
  authCookieExpiresInMs: number | null;
} {
  if (!cookie || typeof cookie.expires !== "number" || cookie.expires <= 0) {
    return {
      authCookieExpiresAt: null,
      authCookieExpiresInMs: null,
    };
  }

  const expiresAtMs = cookie.expires * 1_000;
  return {
    authCookieExpiresAt: new Date(expiresAtMs).toISOString(),
    authCookieExpiresInMs: expiresAtMs - checkedAtMs,
  };
}

function isDecryptionFailure(error: unknown): boolean {
  return (
    error instanceof LinkedInBuddyError &&
    error.code === "ACTION_PRECONDITION_FAILED" &&
    error.message.toLowerCase().includes("could not be decrypted")
  );
}

async function checkFingerprintExists(
  sessionName: string,
  baseDir?: string,
): Promise<boolean> {
  try {
    await readFile(
      resolveLinkedInFingerprintPath(sessionName, baseDir),
      "utf8",
    );
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    return false;
  }
}

/**
 * Validates stored LinkedIn session health without launching a browser.
 */
export async function checkStoredSessionHealth(
  sessionName?: string,
  baseDir?: string,
): Promise<SessionHealthCheckResult> {
  const checkedAtMs = Date.now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  const requestedSessionName = resolveSessionName(sessionName);
  const store = new LinkedInSessionStore(baseDir);

  let sessionExists = false;
  try {
    sessionExists = await store.exists(requestedSessionName);
  } catch (error) {
    if (error instanceof LinkedInBuddyError) {
      return {
        healthy: false,
        sessionName: requestedSessionName,
        checkedAt,
        reason: "Session name is invalid.",
        sessionExists: false,
        hasAuthCookie: false,
        authCookieExpiresAt: null,
        authCookieExpiresInMs: null,
        hasBrowserFingerprint: false,
        cookieCount: 0,
        guidance: NO_SESSION_GUIDANCE,
      };
    }

    return {
      healthy: false,
      sessionName: requestedSessionName,
      checkedAt,
      reason: "Could not verify whether the stored session exists.",
      sessionExists: false,
      hasAuthCookie: false,
      authCookieExpiresAt: null,
      authCookieExpiresInMs: null,
      hasBrowserFingerprint: false,
      cookieCount: 0,
      guidance: NO_SESSION_GUIDANCE,
    };
  }

  const hasBrowserFingerprint = await checkFingerprintExists(
    requestedSessionName,
    baseDir,
  );

  if (!sessionExists) {
    return {
      healthy: false,
      sessionName: requestedSessionName,
      checkedAt,
      reason: "No stored session file exists.",
      sessionExists: false,
      hasAuthCookie: false,
      authCookieExpiresAt: null,
      authCookieExpiresInMs: null,
      hasBrowserFingerprint,
      cookieCount: 0,
      guidance: NO_SESSION_GUIDANCE,
    };
  }

  let loadedSession: LoadedSession;
  try {
    loadedSession = await store.load(requestedSessionName);
  } catch (error) {
    if (error instanceof LinkedInBuddyError && error.code === "AUTH_REQUIRED") {
      return {
        healthy: false,
        sessionName: requestedSessionName,
        checkedAt,
        reason: "No stored session file exists.",
        sessionExists: false,
        hasAuthCookie: false,
        authCookieExpiresAt: null,
        authCookieExpiresInMs: null,
        hasBrowserFingerprint,
        cookieCount: 0,
        guidance: NO_SESSION_GUIDANCE,
      };
    }

    if (isDecryptionFailure(error)) {
      return {
        healthy: false,
        sessionName: requestedSessionName,
        checkedAt,
        reason:
          "Could not decrypt stored session. Capture a fresh session and retry.",
        sessionExists: true,
        hasAuthCookie: false,
        authCookieExpiresAt: null,
        authCookieExpiresInMs: null,
        hasBrowserFingerprint,
        cookieCount: 0,
        guidance:
          'Stored session could not be read. Run "linkedin login --manual" to re-authenticate.',
      };
    }

    return {
      healthy: false,
      sessionName: requestedSessionName,
      checkedAt,
      reason: "Stored session metadata is invalid.",
      sessionExists: true,
      hasAuthCookie: false,
      authCookieExpiresAt: null,
      authCookieExpiresInMs: null,
      hasBrowserFingerprint,
      cookieCount: 0,
      guidance:
        'Stored session data is invalid. Run "linkedin login --manual" to re-authenticate.',
    };
  }

  const authCookie = getLiAtCookie(loadedSession.storageState.cookies);
  const hasAuthCookie = Boolean(authCookie);
  const { authCookieExpiresAt, authCookieExpiresInMs } = getCookieExpiry(
    authCookie,
    checkedAtMs,
  );
  const isExpired =
    authCookieExpiresInMs !== null && authCookieExpiresInMs <= 0;

  if (!hasAuthCookie) {
    return {
      healthy: false,
      sessionName: loadedSession.metadata.sessionName,
      checkedAt,
      reason: "Stored session does not contain a usable li_at cookie.",
      sessionExists: true,
      hasAuthCookie: false,
      authCookieExpiresAt,
      authCookieExpiresInMs,
      hasBrowserFingerprint,
      cookieCount: loadedSession.metadata.cookieCount,
      guidance: NO_AUTH_COOKIE_GUIDANCE,
    };
  }

  if (isExpired) {
    return {
      healthy: false,
      sessionName: loadedSession.metadata.sessionName,
      checkedAt,
      reason: "Stored li_at cookie is expired.",
      sessionExists: true,
      hasAuthCookie: true,
      authCookieExpiresAt,
      authCookieExpiresInMs,
      hasBrowserFingerprint,
      cookieCount: loadedSession.metadata.cookieCount,
      guidance: EXPIRED_SESSION_GUIDANCE,
    };
  }

  return {
    healthy: true,
    sessionName: loadedSession.metadata.sessionName,
    checkedAt,
    reason: "Stored li_at cookie is present and not expired.",
    sessionExists: true,
    hasAuthCookie: true,
    authCookieExpiresAt,
    authCookieExpiresInMs,
    hasBrowserFingerprint,
    cookieCount: loadedSession.metadata.cookieCount,
    guidance: hasBrowserFingerprint
      ? HEALTHY_SESSION_GUIDANCE
      : `${HEALTHY_SESSION_GUIDANCE}${NO_FINGERPRINT_NOTE}`,
  };
}
