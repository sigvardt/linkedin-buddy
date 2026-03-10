import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  LinkedInSessionStore,
  resolveStoredLinkedInSessionPath,
  type LinkedInBrowserStorageState
} from "../auth/sessionStore.js";

function createStorageState(): LinkedInBrowserStorageState {
  return {
    cookies: [
      {
        name: "li_at",
        value: "super-secret-cookie",
        domain: ".linkedin.com",
        path: "/",
        expires: 1_900_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax"
      }
    ],
    origins: [
      {
        origin: "https://www.linkedin.com",
        localStorage: [
          {
            name: "li_theme",
            value: "dark"
          }
        ]
      }
    ]
  };
}

function createRestoreContext(): {
  addCookies: ReturnType<typeof vi.fn>;
  context: BrowserContext;
  evaluate: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
} {
  const goto = vi.fn(async () => undefined);
  const evaluate = vi.fn(async () => undefined);
  const page = {
    evaluate,
    goto
  } as unknown as Page;
  const addCookies = vi.fn(async () => undefined);
  const context = {
    addCookies,
    newPage: vi.fn(async () => page),
    pages: vi.fn(() => [])
  } as unknown as BrowserContext;

  return {
    addCookies,
    context,
    evaluate,
    goto
  };
}

describe("LinkedInSessionStore", () => {
  it("encrypts stored session state and round-trips it correctly", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-session-store-"));

    try {
      const store = new LinkedInSessionStore(tempDir);
      const storageState = createStorageState();

      const metadata = await store.save("smoke", storageState);
      const storedFile = resolveStoredLinkedInSessionPath("smoke", tempDir);
      const rawEnvelope = await readFile(storedFile, "utf8");
      const loaded = await store.load("smoke");

      expect(metadata.filePath).toBe(storedFile);
      expect(metadata.hasLinkedInAuthCookie).toBe(true);
      expect(metadata.sessionCookieFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(metadata.sessionCookies).toHaveLength(1);
      expect(rawEnvelope).not.toContain("super-secret-cookie");
      expect(rawEnvelope).not.toContain('"origins"');
      expect(loaded.metadata.sessionName).toBe("smoke");
      expect(loaded.metadata.sessionCookieFingerprint).toBe(
        metadata.sessionCookieFingerprint
      );
      expect(loaded.storageState).toEqual(storageState);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws AUTH_REQUIRED for a missing stored session", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-session-store-"));

    try {
      const store = new LinkedInSessionStore(tempDir);

      await expect(store.load("missing")).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        message: expect.stringContaining("buddy auth:session")
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rotates stored backups and restores the freshest non-expired fallback", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-session-store-"));

    try {
      const store = new LinkedInSessionStore(tempDir);
      const firstStorageState = createStorageState();
      const expiredStorageState: LinkedInBrowserStorageState = {
        ...createStorageState(),
        cookies: [
          {
            ...createStorageState().cookies[0]!,
            expires: 1_600_000_000,
            value: "expired-cookie"
          }
        ]
      };

      await store.saveWithBackups("smoke", firstStorageState, { maxBackups: 2 });
      await store.saveWithBackups("smoke", expiredStorageState, { maxBackups: 2 });

      const restored = createRestoreContext();
      const restoreResult = await store.restoreToContext(restored.context, "smoke", {
        maxBackups: 2
      });

      expect(restoreResult.restoredFromBackup).toBe(true);
      expect(restoreResult.restoredSessionName).toBe("smoke.backup-1");
      expect(restored.addCookies).toHaveBeenCalledWith(firstStorageState.cookies);
      expect(restored.goto).toHaveBeenCalledWith("https://www.linkedin.com", {
        waitUntil: "domcontentloaded"
      });
      expect(restored.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
