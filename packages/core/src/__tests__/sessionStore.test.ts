import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
      expect(rawEnvelope).not.toContain("super-secret-cookie");
      expect(rawEnvelope).not.toContain('"origins"');
      expect(loaded.metadata.sessionName).toBe("smoke");
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
        message: expect.stringContaining("owa auth:session")
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
