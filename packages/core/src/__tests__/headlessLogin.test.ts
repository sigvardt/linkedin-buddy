import { describe, expect, it } from "vitest";
import type {
  HeadlessLoginOptions,
  HeadlessLoginResult
} from "../auth/session.js";

describe("HeadlessLoginOptions interface", () => {
  it("requires email and password", () => {
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret123"
    };
    expect(options.email).toBe("test@example.com");
    expect(options.password).toBe("secret123");
  });

  it("accepts optional mfaCode", () => {
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret",
      mfaCode: "123456"
    };
    expect(options.mfaCode).toBe("123456");
  });

  it("has mfaCode undefined by default", () => {
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret"
    };
    expect(options.mfaCode).toBeUndefined();
  });

  it("accepts optional timeoutMs and pollIntervalMs", () => {
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret",
      timeoutMs: 30_000,
      pollIntervalMs: 1_000
    };
    expect(options.timeoutMs).toBe(30_000);
    expect(options.pollIntervalMs).toBe(1_000);
  });

  it("extends SessionOptions with profileName and cdpUrl", () => {
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret",
      profileName: "work",
      cdpUrl: "http://localhost:9222"
    };
    expect(options.profileName).toBe("work");
    expect(options.cdpUrl).toBe("http://localhost:9222");
  });

  it("has defaults for optional fields", () => {
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret"
    };
    expect(options.profileName).toBeUndefined();
    expect(options.cdpUrl).toBeUndefined();
    expect(options.timeoutMs).toBeUndefined();
    expect(options.pollIntervalMs).toBeUndefined();
  });
});

describe("HeadlessLoginResult interface", () => {
  it("includes timedOut and checkpoint fields", () => {
    const result: HeadlessLoginResult = {
      authenticated: true,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/feed/",
      reason: "Authenticated",
      timedOut: false,
      checkpoint: false
    };
    expect(result.timedOut).toBe(false);
    expect(result.checkpoint).toBe(false);
    expect(result.authenticated).toBe(true);
  });

  it("can represent a checkpoint result", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/checkpoint/challenge/",
      reason: "LinkedIn checkpoint detected. Manual verification is required.",
      timedOut: false,
      checkpoint: true
    };
    expect(result.checkpoint).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("checkpoint");
  });

  it("can represent a verification_code checkpoint requiring MFA", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/checkpoint/challenge/",
      reason: "LinkedIn checkpoint detected. Manual verification is required.",
      timedOut: false,
      checkpoint: true,
      checkpointType: "verification_code",
      mfaRequired: true
    };
    expect(result.checkpoint).toBe(true);
    expect(result.checkpointType).toBe("verification_code");
    expect(result.mfaRequired).toBe(true);
    expect(result.authenticated).toBe(false);
  });

  it("can represent an app_approval checkpoint", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/checkpoint/challenge/",
      reason: "LinkedIn checkpoint detected. Manual verification is required.",
      timedOut: false,
      checkpoint: true,
      checkpointType: "app_approval"
    };
    expect(result.checkpointType).toBe("app_approval");
    expect(result.mfaRequired).toBeUndefined();
  });

  it("can represent a captcha checkpoint", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/checkpoint/challenge/",
      reason: "LinkedIn checkpoint detected. Manual verification is required.",
      timedOut: false,
      checkpoint: true,
      checkpointType: "captcha"
    };
    expect(result.checkpointType).toBe("captcha");
  });

  it("can represent an unknown checkpoint type", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/checkpoint/challenge/",
      reason: "LinkedIn checkpoint detected. Manual verification is required.",
      timedOut: false,
      checkpoint: true,
      checkpointType: "unknown"
    };
    expect(result.checkpointType).toBe("unknown");
  });

  it("has checkpointType and mfaRequired undefined when not a checkpoint", () => {
    const result: HeadlessLoginResult = {
      authenticated: true,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/feed/",
      reason: "Authenticated",
      timedOut: false,
      checkpoint: false
    };
    expect(result.checkpointType).toBeUndefined();
    expect(result.mfaRequired).toBeUndefined();
  });

  it("can represent a successful login after MFA code submission", () => {
    const result: HeadlessLoginResult = {
      authenticated: true,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/feed/",
      reason: "LinkedIn session appears authenticated.",
      timedOut: false,
      checkpoint: false
    };
    expect(result.authenticated).toBe(true);
    expect(result.checkpoint).toBe(false);
    expect(result.checkpointType).toBeUndefined();
    expect(result.mfaRequired).toBeUndefined();
  });

  it("can represent a timed-out result", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/login",
      reason: "Login form is visible.",
      timedOut: true,
      checkpoint: false
    };
    expect(result.timedOut).toBe(true);
    expect(result.authenticated).toBe(false);
  });

  it("can represent invalid credentials", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/login",
      reason: "Invalid credentials",
      timedOut: false,
      checkpoint: false
    };
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("Invalid credentials");
    expect(result.timedOut).toBe(false);
    expect(result.checkpoint).toBe(false);
  });

  it("extends SessionStatus with all required fields", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: "2026-02-22T18:00:00.000Z",
      currentUrl: "https://www.linkedin.com/login",
      reason: "Login form is visible.",
      timedOut: true,
      checkpoint: false
    };
    expect(result).toHaveProperty("authenticated");
    expect(result).toHaveProperty("checkedAt");
    expect(result).toHaveProperty("currentUrl");
    expect(result).toHaveProperty("reason");
    expect(result).toHaveProperty("timedOut");
    expect(result).toHaveProperty("checkpoint");
  });
});

describe("HeadlessLoginOptions mfaCallback", () => {
  it("accepts optional mfaCallback", () => {
    const callback = async () => "123456";
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret",
      mfaCallback: callback
    };
    expect(options.mfaCallback).toBe(callback);
  });

  it("has mfaCallback undefined by default", () => {
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret"
    };
    expect(options.mfaCallback).toBeUndefined();
  });

  it("can have both mfaCode and mfaCallback", () => {
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret",
      mfaCode: "123456",
      mfaCallback: async () => "654321"
    };
    expect(options.mfaCode).toBe("123456");
    expect(typeof options.mfaCallback).toBe("function");
  });

  it("mfaCallback can return undefined to skip", async () => {
    const callback = async () => undefined;
    const options: HeadlessLoginOptions = {
      email: "test@example.com",
      password: "secret",
      mfaCallback: callback
    };
    const result = await options.mfaCallback!();
    expect(result).toBeUndefined();
  });
});

describe("HeadlessLoginResult page-closed scenarios", () => {
  it("can represent a page-closed-after-MFA result", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "unknown (page closed)",
      reason: "Page closed after MFA code submission — code may be invalid or expired",
      timedOut: false,
      checkpoint: true,
      checkpointType: "verification_code",
      mfaRequired: true
    };
    expect(result.authenticated).toBe(false);
    expect(result.currentUrl).toBe("unknown (page closed)");
    expect(result.checkpoint).toBe(true);
    expect(result.checkpointType).toBe("verification_code");
    expect(result.mfaRequired).toBe(true);
  });

  it("can represent page-closed during polling", () => {
    const result: HeadlessLoginResult = {
      authenticated: false,
      checkedAt: new Date().toISOString(),
      currentUrl: "unknown (page closed)",
      reason: "Page closed unexpectedly during login polling",
      timedOut: false,
      checkpoint: false
    };
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("Page closed unexpectedly");
    expect(result.checkpoint).toBe(false);
  });
});

describe("HeadlessLoginResult early-return scenarios", () => {
  it("can represent already-authenticated early return", () => {
    const result: HeadlessLoginResult = {
      authenticated: true,
      checkedAt: new Date().toISOString(),
      currentUrl: "https://www.linkedin.com/feed/",
      reason: "LinkedIn session appears authenticated.",
      timedOut: false,
      checkpoint: false
    };
    expect(result.authenticated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.checkpoint).toBe(false);
    expect(result.currentUrl).toContain("/feed/");
  });
});
