import { describe, expect, it, vi } from "vitest";
import type { EvasionLevel } from "../evasion.js";
import { EvasionSession } from "../evasion.js";
import { createPageMock } from "./evasionTestUtils.js";

describe("evasion diagnostics", () => {
  it("throws a clear error when JS callers pass an unsupported evasion level", () => {
    const { page } = createPageMock();

    expect(
      () =>
        new EvasionSession(
          page,
          "aggressive" as unknown as EvasionLevel
        )
    ).toThrowError("EvasionSession level must be one of minimal, moderate, paranoid.");
  });

  it("logs fail-open recovery paths when diagnostics are enabled", async () => {
    const { page } = createPageMock({
      mouseMoveError: new Error("move blocked"),
      waitForTimeoutError: new Error("timer blocked")
    });
    const logger = {
      log: vi.fn()
    };

    const session = new EvasionSession(page, "minimal", {
      diagnosticsEnabled: true,
      diagnosticsLabel: "fallback",
      logger
    });

    await session.moveMouse({ x: 0, y: 0 }, { x: 50, y: 20 });
    await session.idle(120);

    expect(logger.log).toHaveBeenCalledWith(
      "debug",
      "evasion.session.mouse_move.failed",
      expect.objectContaining({
        diagnostics_label: "fallback",
        error_message: "move blocked",
        evasion_level: "minimal"
      })
    );
    expect(logger.log).toHaveBeenCalledWith(
      "debug",
      "evasion.session.wait_for_timeout.failed",
      expect.objectContaining({
        diagnostics_label: "fallback",
        delay_ms: 120,
        error_message: "timer blocked",
        evasion_level: "minimal"
      })
    );
  });

  it("emits opt-in debug diagnostics for important session operations", async () => {
    const { page, locatorCounts } = createPageMock({
      includeAddInitScript: true,
      viewportSize: { width: 1280, height: 720 }
    });
    const logger = {
      log: vi.fn()
    };

    locatorCounts.set("[class*='captcha' i]", 1);
    locatorCounts.set("input[tabindex='-1']", 1);

    const session = new EvasionSession(page, "paranoid", {
      diagnosticsEnabled: true,
      diagnosticsLabel: "smoke",
      logger
    });

    await session.hardenFingerprint();
    await session.readingPause(400);
    await session.simulateTabSwitch(200);
    await session.simulateViewportJitter();
    session.sampleInterval(500, { rateLimited: true, responseStatus: 429 });
    expect(await session.detectCaptcha()).toBe(true);
    expect(await session.findHoneypotFields()).toContain("input[tabindex='-1']");

    const events = logger.log.mock.calls.map((call) => call[1]);

    expect(events).toEqual(
      expect.arrayContaining([
        "evasion.session.created",
        "evasion.session.fingerprint_hardening.applied",
        "evasion.session.reading_pause.applied",
        "evasion.session.tab_switch.simulated",
        "evasion.session.viewport_jitter.simulated",
        "evasion.session.interval.sampled",
        "evasion.session.captcha.detected",
        "evasion.session.honeypots.detected"
      ])
    );
    expect(logger.log).toHaveBeenCalledWith(
      "debug",
      "evasion.session.captcha.detected",
      expect.objectContaining({
        diagnostics_label: "smoke",
        evasion_level: "paranoid"
      })
    );
  });
});
