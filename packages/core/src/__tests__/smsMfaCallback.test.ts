import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractLinkedInCode, createSmsMfaCallback } from "../auth/smsMfaCallback.js";

// ---------------------------------------------------------------------------
// Mock child_process.execFile
// ---------------------------------------------------------------------------
const execFileMock = vi.hoisted(() =>
  vi.fn<(
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => void>()
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

// Helper: make the mock resolve with given stdout
function mockExecFileStdout(fn: (...args: unknown[]) => string): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      args: readonly string[],
      _options: Record<string, unknown>,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      try {
        const stdout = fn(_file, args);
        cb(null, { stdout, stderr: "" });
      } catch (err) {
        cb(err as Error, { stdout: "", stderr: "" });
      }
    },
  );
}

function mockExecFileError(): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: readonly string[],
      _options: Record<string, unknown>,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(new Error("imsg not found"), { stdout: "", stderr: "" });
    },
  );
}

// ---------------------------------------------------------------------------
// extractLinkedInCode
// ---------------------------------------------------------------------------
describe("extractLinkedInCode", () => {
  it('extracts code from "Your LinkedIn verification code is XXXXXX."', () => {
    expect(
      extractLinkedInCode("Your LinkedIn verification code is 643821."),
    ).toBe("643821");
  });

  it("extracts code without trailing period", () => {
    expect(
      extractLinkedInCode("Your LinkedIn verification code is 238787"),
    ).toBe("238787");
  });

  it('extracts code from "LinkedIn: XXXXXX is your verification code"', () => {
    expect(
      extractLinkedInCode("LinkedIn: 123456 is your verification code"),
    ).toBe("123456");
  });

  it("extracts code when extra text surrounds it", () => {
    expect(
      extractLinkedInCode(
        "LinkedIn security alert: Your LinkedIn verification code is 999888. Do not share this code.",
      ),
    ).toBe("999888");
  });

  it("returns undefined for non-matching text", () => {
    expect(extractLinkedInCode("Hello world")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractLinkedInCode("")).toBeUndefined();
  });

  it("returns undefined for text without linkedin mention", () => {
    expect(
      extractLinkedInCode("Your verification code is 123456"),
    ).toBeUndefined();
  });

  it("returns undefined for 5-digit numbers only", () => {
    expect(
      extractLinkedInCode("LinkedIn code is 12345"),
    ).toBeUndefined();
  });

  it("falls back to 6-digit extraction when linkedin + code present", () => {
    expect(
      extractLinkedInCode("LinkedIn sent you code 654321 for login"),
    ).toBe("654321");
  });

  it("returns undefined when linkedin present but no code/verification keyword", () => {
    expect(
      extractLinkedInCode("LinkedIn wants you to log in: 123456"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createSmsMfaCallback
// ---------------------------------------------------------------------------
describe("createSmsMfaCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds the LinkedIn chat and extracts a code from a recent message", async () => {
    const now = Date.now();
    const msgTime = new Date(now + 5_000).toISOString();

    mockExecFileStdout((_file, args) => {
      const joined = (args as string[]).join(" ");
      if (joined.includes("chats")) {
        return `{"identifier":"LinkedIn","service":"SMS","id":85,"name":""}\n`;
      }
      if (joined.includes("history")) {
        return `{"sender":"LinkedIn","created_at":"${msgTime}","text":"Your LinkedIn verification code is 112233.","id":1}\n`;
      }
      return "";
    });

    const callback = createSmsMfaCallback({
      timeoutMs: 10_000,
      pollIntervalMs: 500,
      imsgPath: "/usr/bin/imsg",
    });

    const code = await callback();
    expect(code).toBe("112233");
  });

  it("returns undefined on timeout when no matching message is found", async () => {
    mockExecFileStdout((_file, args) => {
      const joined = (args as string[]).join(" ");
      if (joined.includes("chats")) {
        return `{"identifier":"LinkedIn","service":"SMS","id":85,"name":""}\n`;
      }
      return `{"sender":"LinkedIn","created_at":"2020-01-01T00:00:00.000Z","text":"Old message","id":1}\n`;
    });

    const callback = createSmsMfaCallback({
      timeoutMs: 500,
      pollIntervalMs: 100,
      imsgPath: "/usr/bin/imsg",
    });

    const code = await callback();
    expect(code).toBeUndefined();
  });

  it("returns undefined when no LinkedIn chat exists", async () => {
    mockExecFileStdout((_file, args) => {
      const joined = (args as string[]).join(" ");
      if (joined.includes("chats")) {
        return `{"identifier":"Microsoft","service":"SMS","id":86,"name":""}\n`;
      }
      return "";
    });

    const callback = createSmsMfaCallback({
      timeoutMs: 500,
      pollIntervalMs: 100,
      imsgPath: "/usr/bin/imsg",
    });

    const code = await callback();
    expect(code).toBeUndefined();
  });

  it("handles imsg command failures gracefully", async () => {
    mockExecFileError();

    const callback = createSmsMfaCallback({
      timeoutMs: 500,
      pollIntervalMs: 100,
      imsgPath: "/usr/bin/imsg",
    });

    const code = await callback();
    expect(code).toBeUndefined();
  });

  it("only considers messages after startTime", async () => {
    const now = Date.now();
    const oldTime = new Date(now - 60_000).toISOString();

    mockExecFileStdout((_file, args) => {
      const joined = (args as string[]).join(" ");
      if (joined.includes("chats")) {
        return `{"identifier":"LinkedIn","service":"SMS","id":85,"name":""}\n`;
      }
      // Message is from before startTime
      return `{"sender":"LinkedIn","created_at":"${oldTime}","text":"Your LinkedIn verification code is 999999.","id":1}\n`;
    });

    const callback = createSmsMfaCallback({
      timeoutMs: 500,
      pollIntervalMs: 100,
      imsgPath: "/usr/bin/imsg",
    });

    const code = await callback();
    expect(code).toBeUndefined();
  });

  it("polls multiple times before finding a code", async () => {
    const now = Date.now();
    const futureTime = new Date(now + 5_000).toISOString();
    let callCount = 0;

    mockExecFileStdout((_file, args) => {
      const joined = (args as string[]).join(" ");
      if (joined.includes("chats")) {
        return `{"identifier":"LinkedIn","service":"SMS","id":85,"name":""}\n`;
      }
      if (joined.includes("history")) {
        callCount++;
        if (callCount < 3) {
          // No matching message yet
          return `{"sender":"LinkedIn","created_at":"2020-01-01T00:00:00.000Z","text":"Old message","id":1}\n`;
        }
        // Third poll returns the code
        return `{"sender":"LinkedIn","created_at":"${futureTime}","text":"Your LinkedIn verification code is 445566.","id":2}\n`;
      }
      return "";
    });

    const callback = createSmsMfaCallback({
      timeoutMs: 30_000,
      pollIntervalMs: 100,
      imsgPath: "/usr/bin/imsg",
    });

    const code = await callback();
    expect(code).toBe("445566");
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});
