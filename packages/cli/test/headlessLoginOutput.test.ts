import { describe, expect, it } from "vitest";
import { HeadlessLoginProgressReporter } from "../src/headlessLoginOutput.js";

function createReporter() {
  const lines: string[] = [];
  return {
    lines,
    reporter: new HeadlessLoginProgressReporter({
      writeLine(line) {
        lines.push(line);
      }
    })
  };
}

describe("HeadlessLoginProgressReporter", () => {
  it("renders typing progress, fallbacks, and MFA checkpoints", () => {
    const { lines, reporter } = createReporter();

    reporter.handleLog({
      event: "cli.login.headless.start",
      payload: { profileName: "default" }
    });
    reporter.handleLog({
      event: "humanize.typing.start",
      payload: { field_label: "email" }
    });
    reporter.handleLog({
      event: "humanize.typing.done",
      payload: { field_label: "email", mode: "simulated" }
    });
    reporter.handleLog({
      event: "humanize.typing.degraded",
      payload: { field_label: "password", method: "fill", reason: "timeout" }
    });
    reporter.handleLog({
      event: "cli.login.headless.done",
      payload: {
        authenticated: false,
        checkpoint: true,
        checkpointType: "verification_code",
        mfaRequired: true,
        timedOut: false
      }
    });

    expect(lines).toEqual([
      "Starting headless login for profile default.",
      "Typing email with human-like cadence...",
      "Typed email with simulated keystrokes.",
      "Typing password fell back to direct input via fill() because typing exceeded the safety budget.",
      "Headless login requires a LinkedIn verification code."
    ]);
  });

  it("renders a concise success message", () => {
    const { lines, reporter } = createReporter();

    reporter.handleLog({
      event: "cli.login.headless.done",
      payload: {
        authenticated: true,
        checkpoint: false,
        timedOut: false
      }
    });

    expect(lines).toEqual(["Headless login authenticated successfully."]);
  });

  it("stays quiet when disabled", () => {
    const lines: string[] = [];
    const reporter = new HeadlessLoginProgressReporter({
      enabled: false,
      writeLine(line) {
        lines.push(line);
      }
    });

    reporter.handleLog({
      event: "cli.login.headless.start",
      payload: { profileName: "default" }
    });

    expect(lines).toEqual([]);
  });
});
