import { readIdentityCache } from "./identityCache.js";
import { checkStoredSessionHealth } from "./sessionHealthCheck.js";
import { LinkedInSessionStore } from "./sessionStore.js";

/** Result from a fast sub-second authentication status check. */
export interface AuthWhoamiResult {
  authenticated: boolean;
  profileName: string;
  fullName: string | null;
  vanityName: string | null;
  sessionAge: string | null;
  sessionValid: boolean;
  sessionExpiresAt: string | null;
  sessionExpiresInMs: number | null;
  identityCachedAt: string | null;
  guidance: string;
}

function formatSessionAge(capturedAt: string): string | null {
  const capturedAtMs = new Date(capturedAt).getTime();
  if (!Number.isFinite(capturedAtMs)) {
    return null;
  }

  const elapsedMs = Math.max(0, Date.now() - capturedAtMs);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);

  if (elapsedMs < 60_000) {
    return "<1m";
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  const remainingMinutes = elapsedMinutes % 60;
  if (elapsedHours < 24) {
    return `${elapsedHours}h ${remainingMinutes}m`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  const remainingHours = elapsedHours % 24;
  return `${elapsedDays}d ${remainingHours}h`;
}

export async function getAuthWhoami(
  profileName?: string,
  baseDir?: string,
): Promise<AuthWhoamiResult> {
  const health = await checkStoredSessionHealth(profileName, baseDir);
  const resolvedProfileName = health.sessionName;

  let capturedAt: string | null;
  try {
    const session = await new LinkedInSessionStore(baseDir).load(resolvedProfileName);
    capturedAt = session.metadata.capturedAt;
  } catch {
    capturedAt = null;
  }

  const cachedIdentity = await readIdentityCache(resolvedProfileName, baseDir);
  const hasIdentity = cachedIdentity !== null;
  const guidance = hasIdentity
    ? health.guidance
    : `${health.guidance} Run "linkedin status --profile ${resolvedProfileName}" to refresh cached identity.`;

  return {
    authenticated: health.healthy,
    profileName: resolvedProfileName,
    fullName: cachedIdentity?.fullName ?? null,
    vanityName: cachedIdentity?.vanityName ?? null,
    sessionAge: capturedAt ? formatSessionAge(capturedAt) : null,
    sessionValid: health.sessionExists && health.hasAuthCookie,
    sessionExpiresAt: health.authCookieExpiresAt,
    sessionExpiresInMs: health.authCookieExpiresInMs,
    identityCachedAt: cachedIdentity?.cachedAt ?? null,
    guidance,
  };
}
