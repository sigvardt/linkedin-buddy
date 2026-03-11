import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evasionCliMocks = vi.hoisted(() => ({
  authStatus: vi.fn(async () => ({
    authenticated: true,
    checkedAt: "2026-03-10T09:00:00.000Z",
    currentUrl: "https://www.linkedin.com/feed/",
    evasion: {
      diagnosticsEnabled: true,
      disabledFeatures: ["tab_blur_simulation", "viewport_resize_simulation"],
      enabledFeatures: [
        "bezier_mouse_movement",
        "momentum_scroll",
        "idle_drift",
        "reading_pauses",
        "poisson_timing",
        "fingerprint_hardening"
      ],
      level: "moderate",
      profile: {
        bezierMouseMovement: true,
        fingerprintHardening: true,
        idleDriftEnabled: true,
        momentumScroll: true,
        mouseJitterRadius: 3,
        mouseOvershootFactor: 0.15,
        poissonIntervals: true,
        readingPauseWpm: 230,
        simulateTabBlur: false,
        simulateViewportResize: false
      },
      source: "env",
      summary:
        "Moderate evasion enables Bezier mouse movement, momentum scroll, idle drift, reading pauses, Poisson timing, and fingerprint hardening."
    },
    reason: "LinkedIn session appears authenticated.",
    sessionCookiePresent: true
  })),
  close: vi.fn(),
  createCoreRuntime: vi.fn(() => ({
    auth: { status: evasionCliMocks.authStatus },
    close: evasionCliMocks.close,
    healthCheck: evasionCliMocks.healthCheck,
    logger: { log: evasionCliMocks.loggerLog },
    runId: "run-evasion-cli"
  })),
  healthCheck: vi.fn(async () => ({
    browser: {
      browserConnected: true,
      checkedAt: "2026-03-10T09:00:00.000Z",
      healthy: true,
      pageResponsive: true
    },
    session: {
      authenticated: true,
      checkedAt: "2026-03-10T09:00:00.000Z",
      checkpointDetected: false,
      cookieExpiringSoon: false,
      currentUrl: "https://www.linkedin.com/feed/",
      evasion: {
        diagnosticsEnabled: false,
        disabledFeatures: ["tab_blur_simulation", "viewport_resize_simulation"],
        enabledFeatures: [
          "bezier_mouse_movement",
          "momentum_scroll",
          "idle_drift",
          "reading_pauses",
          "poisson_timing",
          "fingerprint_hardening"
        ],
        level: "moderate",
        profile: {
          bezierMouseMovement: true,
          fingerprintHardening: true,
          idleDriftEnabled: true,
          momentumScroll: true,
          mouseJitterRadius: 3,
          mouseOvershootFactor: 0.15,
          poissonIntervals: true,
          readingPauseWpm: 230,
          simulateTabBlur: false,
          simulateViewportResize: false
        },
        source: "default",
        summary:
          "Moderate evasion enables Bezier mouse movement, momentum scroll, idle drift, reading pauses, Poisson timing, and fingerprint hardening."
      },
      loginWallDetected: false,
      nextCookieExpiryAt: null,
      rateLimited: false,
      reason: "LinkedIn session appears authenticated.",
      sessionCookieFingerprint: "health-evasion-fingerprint",
      sessionCookiePresent: true,
      sessionCookies: []
    }
  })),
  loggerLog: vi.fn()
}));

vi.mock("@linkedin-buddy/core", async () => {
  const actual = await import("../../core/src/index.js");
  return {
    ...actual,
    createCoreRuntime: evasionCliMocks.createCoreRuntime
  };
});

import { runCli } from "../src/bin/linkedin.js";

describe("CLI evasion diagnostics output", () => {
  let tempDir = "";
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-evasion-"));
    process.env.LINKEDIN_BUDDY_HOME = path.join(tempDir, "buddy-home");
    process.exitCode = undefined;
    stdoutChunks = [];
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      stdoutChunks.push(String(value ?? ""));
    });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    process.exitCode = undefined;
    delete process.env.LINKEDIN_BUDDY_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("includes evasion details in status output", async () => {
    await runCli(["node", "linkedin", "status", "--profile", "smoke"]);

    const output = JSON.parse(stdoutChunks.join("\n")) as {
      evasion: {
        diagnosticsEnabled: boolean;
        level: string;
        source: string;
      };
      profile_name: string;
      run_id: string;
    };

    expect(output.profile_name).toBe("smoke");
    expect(output.run_id).toBe("run-evasion-cli");
    expect(output.evasion).toMatchObject({
      diagnosticsEnabled: true,
      level: "moderate",
      source: "env"
    });
  });

  it("includes session evasion details in health output", async () => {
    await runCli(["node", "linkedin", "health", "--profile", "smoke"]);

    const output = JSON.parse(stdoutChunks.join("\n")) as {
      profile_name: string;
      run_id: string;
      session: {
        evasion: {
          diagnosticsEnabled: boolean;
          level: string;
          source: string;
        };
      };
    };

    expect(output.profile_name).toBe("smoke");
    expect(output.run_id).toBe("run-evasion-cli");
    expect(output.session.evasion).toMatchObject({
      diagnosticsEnabled: false,
      level: "moderate",
      source: "default"
    });
  });

  it("passes minimal evasion to the runtime when --no-evasion is used", async () => {
    await runCli(["node", "linkedin", "status", "--no-evasion"]);

    expect(evasionCliMocks.createCoreRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        evasionLevel: "minimal"
      })
    );
  });

  it("passes the requested evasion override to the runtime", async () => {
    await runCli(["node", "linkedin", "status", "--evasion-level", "paranoid"]);

    expect(evasionCliMocks.createCoreRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        evasionLevel: "paranoid"
      })
    );
  });
});
