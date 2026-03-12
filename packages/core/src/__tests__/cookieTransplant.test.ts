import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { BrowserContext } from "playwright-core";
import {
  exportSessionState,
  importSessionState,
  hasLinkedInSessionToken,
  type ExportedSessionState,
  type ExportedCookie,
} from "../auth/cookieTransplant.js";
import { LinkedInBuddyError } from "../errors.js";

// Mock fs/promises at module level
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

describe("hasLinkedInSessionToken", () => {
  it("returns true when cookies contain li_at for linkedin.com with non-empty value", () => {
    const state: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [
        {
          name: "li_at",
          value: "valid_token_123",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [],
    };
    expect(hasLinkedInSessionToken(state)).toBe(true);
  });

  it("returns false when no li_at cookie exists", () => {
    const state: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [
        {
          name: "other_cookie",
          value: "some_value",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [],
    };
    expect(hasLinkedInSessionToken(state)).toBe(false);
  });

  it("returns false when li_at exists but value is empty", () => {
    const state: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [
        {
          name: "li_at",
          value: "",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [],
    };
    expect(hasLinkedInSessionToken(state)).toBe(false);
  });

  it("returns false when li_at exists but value is only whitespace", () => {
    const state: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [
        {
          name: "li_at",
          value: "   ",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [],
    };
    expect(hasLinkedInSessionToken(state)).toBe(false);
  });

  it("returns false when li_at exists but domain doesn't include linkedin.com", () => {
    const state: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [
        {
          name: "li_at",
          value: "valid_token_123",
          domain: ".example.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [],
    };
    expect(hasLinkedInSessionToken(state)).toBe(false);
  });

  it("returns false with empty cookies array", () => {
    const state: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [],
      origins: [],
    };
    expect(hasLinkedInSessionToken(state)).toBe(false);
  });

  it("returns true when multiple cookies exist and li_at is valid", () => {
    const state: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [
        {
          name: "other_cookie",
          value: "value1",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
        {
          name: "li_at",
          value: "valid_token_456",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
        {
          name: "another_cookie",
          value: "value2",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: false,
          secure: false,
          sameSite: "Strict",
        },
      ],
      origins: [],
    };
    expect(hasLinkedInSessionToken(state)).toBe(true);
  });
});

describe("exportSessionState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exports session state with correct shape", async () => {
    const mockStorageState = {
      cookies: [
        {
          name: "li_at",
          value: "token_123",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None" as const,
        },
      ],
      origins: [
        {
          origin: "https://www.linkedin.com",
          localStorage: [
            { name: "key1", value: "value1" },
            { name: "key2", value: "value2" },
          ],
        },
      ],
    };

    const mockContext = {
      storageState: vi.fn().mockResolvedValue(mockStorageState),
    } as unknown as BrowserContext;

    const result = await exportSessionState(
      mockContext,
      "/tmp/session.json",
      "work",
    );

    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.profileName).toBe("work");
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]).toEqual({
      name: "li_at",
      value: "token_123",
      domain: ".linkedin.com",
      path: "/",
      expires: 9999999999,
      httpOnly: true,
      secure: true,
      sameSite: "None",
    });
    expect(result.origins).toHaveLength(1);
    expect(result.origins[0].origin).toBe("https://www.linkedin.com");
    expect(result.origins[0].localStorage).toHaveLength(2);
  });

  it("calls context.storageState", async () => {
    const mockStorageState = {
      cookies: [],
      origins: [],
    };

    const mockContext = {
      storageState: vi.fn().mockResolvedValue(mockStorageState),
    } as unknown as BrowserContext;

    await exportSessionState(mockContext, "/tmp/session.json", "test");

    expect(mockContext.storageState).toHaveBeenCalledTimes(1);
  });

  it("calls mkdir with recursive option", async () => {
    const { mkdir } = await import("node:fs/promises");
    const mockStorageState = {
      cookies: [],
      origins: [],
    };

    const mockContext = {
      storageState: vi.fn().mockResolvedValue(mockStorageState),
    } as unknown as BrowserContext;

    await exportSessionState(mockContext, "/tmp/nested/session.json", "test");

    expect(mkdir).toHaveBeenCalledWith("/tmp/nested", { recursive: true });
  });

  it("calls writeFile with JSON stringified state", async () => {
    const { writeFile } = await import("node:fs/promises");
    const mockStorageState = {
      cookies: [
        {
          name: "test",
          value: "value",
          domain: ".example.com",
          path: "/",
          expires: 123456,
          httpOnly: false,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };

    const mockContext = {
      storageState: vi.fn().mockResolvedValue(mockStorageState),
    } as unknown as BrowserContext;

    await exportSessionState(mockContext, "/tmp/session.json", "profile");

    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/session.json",
      expect.stringContaining('"profileName": "profile"'),
      "utf-8",
    );
  });

  it("returns ExportedSessionState with all required fields", async () => {
    const mockStorageState = {
      cookies: [
        {
          name: "li_at",
          value: "token",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None" as const,
        },
      ],
      origins: [
        {
          origin: "https://www.linkedin.com",
          localStorage: [],
        },
      ],
    };

    const mockContext = {
      storageState: vi.fn().mockResolvedValue(mockStorageState),
    } as unknown as BrowserContext;

    const result = await exportSessionState(
      mockContext,
      "/tmp/session.json",
      "myprofile",
    );

    expect(result).toHaveProperty("exportedAt");
    expect(result).toHaveProperty("profileName");
    expect(result).toHaveProperty("cookies");
    expect(result).toHaveProperty("origins");
    expect(typeof result.exportedAt).toBe("string");
    expect(result.profileName).toBe("myprofile");
    expect(Array.isArray(result.cookies)).toBe(true);
    expect(Array.isArray(result.origins)).toBe(true);
  });
});

describe("importSessionState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("imports session state and calls context.addCookies", async () => {
    const { readFile } = await import("node:fs/promises");
    const mockState: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "work",
      cookies: [
        {
          name: "li_at",
          value: "token_123",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [],
    };

    vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockState));

    const mockContext = {
      addCookies: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;

    const result = await importSessionState(mockContext, "/tmp/session.json");

    expect(result).toEqual(mockState);
    expect(mockContext.addCookies).toHaveBeenCalledWith([
      {
        name: "li_at",
        value: "token_123",
        domain: ".linkedin.com",
        path: "/",
        expires: 9999999999,
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
    ]);
  });

  it("returns ExportedSessionState with correct shape", async () => {
    const { readFile } = await import("node:fs/promises");
    const mockState: ExportedSessionState = {
      exportedAt: "2026-03-12T10:00:00.000Z",
      profileName: "personal",
      cookies: [
        {
          name: "li_at",
          value: "token",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [
        {
          origin: "https://www.linkedin.com",
          localStorage: [{ name: "key", value: "val" }],
        },
      ],
    };

    vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockState));

    const mockContext = {
      addCookies: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;

    const result = await importSessionState(mockContext, "/tmp/session.json");

    expect(result.exportedAt).toBe("2026-03-12T10:00:00.000Z");
    expect(result.profileName).toBe("personal");
    expect(result.cookies).toHaveLength(1);
    expect(result.origins).toHaveLength(1);
  });

  it("throws LinkedInBuddyError with ACTION_PRECONDITION_FAILED when file not found", async () => {
    const { readFile } = await import("node:fs/promises");
    const readError = new Error("ENOENT: no such file or directory");

    vi.mocked(readFile).mockRejectedValue(readError);

    const mockContext = {
      addCookies: vi.fn(),
    } as unknown as BrowserContext;

    await expect(
      importSessionState(mockContext, "/tmp/missing.json"),
    ).rejects.toThrow(LinkedInBuddyError);

    try {
      await importSessionState(mockContext, "/tmp/missing.json");
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        expect(error.code).toBe("ACTION_PRECONDITION_FAILED");
        expect(error.message).toContain("Could not read session state file");
        expect(error.details.path).toBe("/tmp/missing.json");
      }
    }
  });

  it("throws LinkedInBuddyError with ACTION_PRECONDITION_FAILED on invalid JSON", async () => {
    const { readFile } = await import("node:fs/promises");

    vi.mocked(readFile).mockResolvedValue("{ invalid json }");

    const mockContext = {
      addCookies: vi.fn(),
    } as unknown as BrowserContext;

    await expect(
      importSessionState(mockContext, "/tmp/session.json"),
    ).rejects.toThrow(LinkedInBuddyError);

    try {
      await importSessionState(mockContext, "/tmp/session.json");
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        expect(error.code).toBe("ACTION_PRECONDITION_FAILED");
        expect(error.message).toContain("Invalid JSON in session state file");
        expect(error.details.path).toBe("/tmp/session.json");
      }
    }
  });

  it("throws LinkedInBuddyError with ACTION_PRECONDITION_FAILED when cookies array is empty", async () => {
    const { readFile } = await import("node:fs/promises");
    const mockState: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [],
      origins: [],
    };

    vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockState));

    const mockContext = {
      addCookies: vi.fn(),
    } as unknown as BrowserContext;

    await expect(
      importSessionState(mockContext, "/tmp/session.json"),
    ).rejects.toThrow(LinkedInBuddyError);

    try {
      await importSessionState(mockContext, "/tmp/session.json");
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        expect(error.code).toBe("ACTION_PRECONDITION_FAILED");
        expect(error.message).toContain(
          "Session state file contains no cookies",
        );
        expect(error.details.path).toBe("/tmp/session.json");
      }
    }
  });

  it("throws LinkedInBuddyError when cookies is not an array", async () => {
    const { readFile } = await import("node:fs/promises");
    const invalidState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: null,
      origins: [],
    };

    vi.mocked(readFile).mockResolvedValue(JSON.stringify(invalidState));

    const mockContext = {
      addCookies: vi.fn(),
    } as unknown as BrowserContext;

    await expect(
      importSessionState(mockContext, "/tmp/session.json"),
    ).rejects.toThrow(LinkedInBuddyError);

    try {
      await importSessionState(mockContext, "/tmp/session.json");
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        expect(error.code).toBe("ACTION_PRECONDITION_FAILED");
      }
    }
  });

  it("calls readFile with correct path and encoding", async () => {
    const { readFile } = await import("node:fs/promises");
    const mockState: ExportedSessionState = {
      exportedAt: new Date().toISOString(),
      profileName: "test",
      cookies: [
        {
          name: "li_at",
          value: "token",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [],
    };

    vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockState));

    const mockContext = {
      addCookies: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrowserContext;

    await importSessionState(mockContext, "/tmp/session.json");

    expect(readFile).toHaveBeenCalledWith("/tmp/session.json", "utf-8");
  });
});

describe("ExportedCookie interface", () => {
  it("accepts valid cookie shape", () => {
    const cookie: ExportedCookie = {
      name: "test",
      value: "value",
      domain: ".example.com",
      path: "/",
      expires: 9999999999,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    };
    expect(cookie.name).toBe("test");
    expect(cookie.value).toBe("value");
    expect(cookie.domain).toBe(".example.com");
    expect(cookie.path).toBe("/");
    expect(cookie.expires).toBe(9999999999);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
  });

  it("accepts sameSite as Lax", () => {
    const cookie: ExportedCookie = {
      name: "test",
      value: "value",
      domain: ".example.com",
      path: "/",
      expires: 9999999999,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    };
    expect(cookie.sameSite).toBe("Lax");
  });

  it("accepts sameSite as None", () => {
    const cookie: ExportedCookie = {
      name: "test",
      value: "value",
      domain: ".example.com",
      path: "/",
      expires: 9999999999,
      httpOnly: false,
      secure: false,
      sameSite: "None",
    };
    expect(cookie.sameSite).toBe("None");
  });
});

describe("ExportedSessionState interface", () => {
  it("accepts valid session state shape", () => {
    const state: ExportedSessionState = {
      exportedAt: "2026-03-12T10:00:00.000Z",
      profileName: "work",
      cookies: [
        {
          name: "li_at",
          value: "token",
          domain: ".linkedin.com",
          path: "/",
          expires: 9999999999,
          httpOnly: true,
          secure: true,
          sameSite: "None",
        },
      ],
      origins: [
        {
          origin: "https://www.linkedin.com",
          localStorage: [
            { name: "key1", value: "val1" },
            { name: "key2", value: "val2" },
          ],
        },
      ],
    };
    expect(state.exportedAt).toBe("2026-03-12T10:00:00.000Z");
    expect(state.profileName).toBe("work");
    expect(state.cookies).toHaveLength(1);
    expect(state.origins).toHaveLength(1);
  });

  it("accepts empty cookies and origins arrays", () => {
    const state: ExportedSessionState = {
      exportedAt: "2026-03-12T10:00:00.000Z",
      profileName: "empty",
      cookies: [],
      origins: [],
    };
    expect(state.cookies).toHaveLength(0);
    expect(state.origins).toHaveLength(0);
  });

  it("accepts multiple origins with multiple localStorage items", () => {
    const state: ExportedSessionState = {
      exportedAt: "2026-03-12T10:00:00.000Z",
      profileName: "multi",
      cookies: [],
      origins: [
        {
          origin: "https://www.linkedin.com",
          localStorage: [{ name: "key", value: "val" }],
        },
        {
          origin: "https://www.example.com",
          localStorage: [
            { name: "key1", value: "val1" },
            { name: "key2", value: "val2" },
          ],
        },
      ],
    };
    expect(state.origins).toHaveLength(2);
    expect(state.origins[0].localStorage).toHaveLength(1);
    expect(state.origins[1].localStorage).toHaveLength(2);
  });
});
