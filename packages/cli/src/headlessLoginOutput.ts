import type { JsonLogEntry } from "@linkedin-assistant/core";

type HeadlessLoginProgressLogEntry = Pick<JsonLogEntry, "event" | "payload">;

/** Configuration for {@link HeadlessLoginProgressReporter}. */
export interface HeadlessLoginProgressReporterOptions {
  enabled?: boolean;
  writeLine?: (line: string) => void;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatFieldLabel(fieldLabel: string | null): string {
  return fieldLabel ?? "field";
}

function formatFallbackMethod(method: string | null): string {
  switch (method) {
    case "fill":
      return "fill()";
    case "insertText":
      return "keyboard.insertText()";
    case "type":
      return "keyboard.type()";
    default:
      return "a direct-input fallback";
  }
}

function formatFallbackReason(reason: string | null): string {
  switch (reason) {
    case "text_too_long":
      return "the text exceeded the simulated typing limit";
    case "timeout":
      return "typing exceeded the safety budget";
    case "simulation_failed":
      return "the browser interrupted simulated typing";
    default:
      return "simulated typing could not continue";
  }
}

/** Turns headless-login lifecycle logs into concise stderr progress lines. */
export class HeadlessLoginProgressReporter {
  private readonly enabled: boolean;
  private readonly writeLine: (line: string) => void;

  constructor(options: HeadlessLoginProgressReporterOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.writeLine = options.writeLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  handleLog(entry: HeadlessLoginProgressLogEntry): void {
    if (!this.enabled) {
      return;
    }

    if (entry.event === "cli.login.headless.start") {
      const profileName = readString(entry.payload, "profileName");
      this.writeLine(
        `Starting headless login${profileName ? ` for profile ${profileName}` : ""}.`
      );
      return;
    }

    if (entry.event === "humanize.typing.start") {
      const fieldLabel = readString(entry.payload, "field_label");
      if (!fieldLabel) {
        return;
      }

      this.writeLine(`Typing ${formatFieldLabel(fieldLabel)} with human-like cadence...`);
      return;
    }

    if (entry.event === "humanize.typing.done") {
      const fieldLabel = readString(entry.payload, "field_label");
      const mode = readString(entry.payload, "mode");
      if (!fieldLabel || mode !== "simulated") {
        return;
      }

      this.writeLine(`Typed ${formatFieldLabel(fieldLabel)} with simulated keystrokes.`);
      return;
    }

    if (entry.event === "humanize.typing.degraded") {
      const fieldLabel = readString(entry.payload, "field_label");
      const reason = readString(entry.payload, "reason");
      const method = readString(entry.payload, "method");
      this.writeLine(
        `Typing ${formatFieldLabel(fieldLabel)} fell back to direct input via ${formatFallbackMethod(method)} because ${formatFallbackReason(reason)}.`
      );
      return;
    }

    if (entry.event === "humanize.typing.fallback_failed") {
      const fieldLabel = readString(entry.payload, "field_label");
      this.writeLine(
        `Typing ${formatFieldLabel(fieldLabel)} could not fall back to direct input.`
      );
      return;
    }

    if (entry.event !== "cli.login.headless.done") {
      return;
    }

    const authenticated = readBoolean(entry.payload, "authenticated") ?? false;
    if (authenticated) {
      this.writeLine("Headless login authenticated successfully.");
      return;
    }

    if (readBoolean(entry.payload, "timedOut")) {
      this.writeLine("Headless login timed out before LinkedIn confirmed the session.");
      return;
    }

    const checkpointType = readString(entry.payload, "checkpointType");
    switch (checkpointType) {
      case "verification_code":
        this.writeLine(
          readBoolean(entry.payload, "mfaRequired")
            ? "Headless login requires a LinkedIn verification code."
            : "Headless login stopped at a LinkedIn verification-code checkpoint."
        );
        return;
      case "app_approval":
        this.writeLine("Headless login is waiting for LinkedIn app approval.");
        return;
      case "captcha":
        this.writeLine("Headless login stopped at a LinkedIn CAPTCHA checkpoint.");
        return;
      case "rate_limited":
        this.writeLine("Headless login hit LinkedIn's rate-limit checkpoint.");
        return;
      case "unknown":
        this.writeLine("Headless login stopped at an unknown LinkedIn checkpoint.");
        return;
      default:
        this.writeLine("Headless login finished without an authenticated session.");
    }
  }
}
