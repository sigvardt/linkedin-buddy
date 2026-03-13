import { beforeEach, describe, expect, it, vi } from "vitest";

const whoamiMocks = vi.hoisted(() => ({
  checkStoredSessionHealth: vi.fn(),
  readIdentityCache: vi.fn(),
  sessionStoreLoad: vi.fn(),
}));

vi.mock("../auth/sessionHealthCheck.js", () => ({
  checkStoredSessionHealth: whoamiMocks.checkStoredSessionHealth,
}));

vi.mock("../auth/identityCache.js", () => ({
  readIdentityCache: whoamiMocks.readIdentityCache,
}));

vi.mock("../auth/sessionStore.js", () => ({
  LinkedInSessionStore: class {
    async load(sessionName: string) {
      return whoamiMocks.sessionStoreLoad(sessionName);
    }
  },
}));

import { getAuthWhoami } from "../auth/whoami.js";

describe("getAuthWhoami", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T12:00:00.000Z"));

    whoamiMocks.checkStoredSessionHealth.mockResolvedValue({
      healthy: true,
      sessionName: "default",
      checkedAt: "2026-03-13T12:00:00.000Z",
      reason: "ok",
      sessionExists: true,
      hasAuthCookie: true,
      authCookieExpiresAt: "2026-03-14T12:00:00.000Z",
      authCookieExpiresInMs: 86_400_000,
      hasBrowserFingerprint: true,
      cookieCount: 3,
      guidance: "LinkedIn session is valid and ready to use.",
    });
    whoamiMocks.sessionStoreLoad.mockResolvedValue({
      metadata: {
        capturedAt: "2026-03-13T11:00:00.000Z",
      },
    });
    whoamiMocks.readIdentityCache.mockResolvedValue({
      fullName: "Test Operator",
      vanityName: "test-operator",
      profileUrl: "https://www.linkedin.com/in/test-operator/",
      cachedAt: "2026-03-13T11:59:00.000Z",
    });
  });

  it("returns full result for healthy session with cached identity", async () => {
    const result = await getAuthWhoami("default");

    expect(result).toEqual({
      authenticated: true,
      profileName: "default",
      fullName: "Test Operator",
      vanityName: "test-operator",
      sessionAge: "1h 0m",
      sessionValid: true,
      sessionExpiresAt: "2026-03-14T12:00:00.000Z",
      sessionExpiresInMs: 86_400_000,
      identityCachedAt: "2026-03-13T11:59:00.000Z",
      guidance: "LinkedIn session is valid and ready to use.",
    });
  });

  it("returns null identity fields and guidance when cached identity is missing", async () => {
    whoamiMocks.readIdentityCache.mockResolvedValue(null);

    const result = await getAuthWhoami("default");

    expect(result.fullName).toBeNull();
    expect(result.vanityName).toBeNull();
    expect(result.identityCachedAt).toBeNull();
    expect(result.guidance).toContain("linkedin status --profile default");
  });

  it("returns unauthenticated and invalid session when no session file exists", async () => {
    whoamiMocks.checkStoredSessionHealth.mockResolvedValue({
      healthy: false,
      sessionName: "default",
      checkedAt: "2026-03-13T12:00:00.000Z",
      reason: "missing",
      sessionExists: false,
      hasAuthCookie: false,
      authCookieExpiresAt: null,
      authCookieExpiresInMs: null,
      hasBrowserFingerprint: false,
      cookieCount: 0,
      guidance: "No stored session found.",
    });
    whoamiMocks.sessionStoreLoad.mockRejectedValue(new Error("missing"));
    whoamiMocks.readIdentityCache.mockResolvedValue(null);

    const result = await getAuthWhoami("default");

    expect(result.authenticated).toBe(false);
    expect(result.sessionValid).toBe(false);
    expect(result.sessionAge).toBeNull();
  });

  it("returns sessionValid true when session exists and has auth cookie but is expired", async () => {
    whoamiMocks.checkStoredSessionHealth.mockResolvedValue({
      healthy: false,
      sessionName: "default",
      checkedAt: "2026-03-13T12:00:00.000Z",
      reason: "expired",
      sessionExists: true,
      hasAuthCookie: true,
      authCookieExpiresAt: "2026-03-13T11:00:00.000Z",
      authCookieExpiresInMs: -3_600_000,
      hasBrowserFingerprint: true,
      cookieCount: 3,
      guidance: "LinkedIn session has expired.",
    });

    const result = await getAuthWhoami("default");

    expect(result.authenticated).toBe(false);
    expect(result.sessionValid).toBe(true);
    expect(result.sessionExpiresInMs).toBe(-3_600_000);
  });

  it("formats session age across second, minute, hour, and day ranges", async () => {
    whoamiMocks.readIdentityCache.mockResolvedValue(null);

    whoamiMocks.sessionStoreLoad.mockResolvedValueOnce({
      metadata: { capturedAt: "2026-03-13T11:59:40.000Z" },
    });
    await expect(getAuthWhoami("default")).resolves.toMatchObject({
      sessionAge: "<1m",
    });

    whoamiMocks.sessionStoreLoad.mockResolvedValueOnce({
      metadata: { capturedAt: "2026-03-13T11:55:00.000Z" },
    });
    await expect(getAuthWhoami("default")).resolves.toMatchObject({
      sessionAge: "5m",
    });

    whoamiMocks.sessionStoreLoad.mockResolvedValueOnce({
      metadata: { capturedAt: "2026-03-13T09:45:00.000Z" },
    });
    await expect(getAuthWhoami("default")).resolves.toMatchObject({
      sessionAge: "2h 15m",
    });

    whoamiMocks.sessionStoreLoad.mockResolvedValueOnce({
      metadata: { capturedAt: "2026-03-10T08:00:00.000Z" },
    });
    await expect(getAuthWhoami("default")).resolves.toMatchObject({
      sessionAge: "3d 4h",
    });
  });

  it("uses default profile name when none is provided", async () => {
    const result = await getAuthWhoami();

    expect(result.profileName).toBe("default");
    expect(whoamiMocks.checkStoredSessionHealth).toHaveBeenCalledWith(
      undefined,
      undefined,
    );
    expect(whoamiMocks.sessionStoreLoad).toHaveBeenCalledWith("default");
    expect(whoamiMocks.readIdentityCache).toHaveBeenCalledWith(
      "default",
      undefined,
    );
  });
});
