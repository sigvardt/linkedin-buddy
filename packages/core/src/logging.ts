import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ConfigPaths } from "./config.js";
import type { AssistantDatabase } from "./db/database.js";
import {
  redactStructuredValue,
  resolvePrivacyConfig,
  type PrivacyConfig
} from "./privacy.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface JsonLogEntry {
  ts: string;
  run_id: string;
  level: LogLevel;
  event: string;
  payload: Record<string, unknown>;
}

export class JsonEventLogger {
  private readonly eventsPath: string;

  constructor(
    private readonly paths: ConfigPaths,
    private readonly runId: string,
    private readonly db?: AssistantDatabase,
    private readonly privacy: PrivacyConfig = resolvePrivacyConfig()
  ) {
    const runDir = path.join(this.paths.artifactsDir, this.runId);
    mkdirSync(runDir, { recursive: true });
    this.eventsPath = path.join(runDir, "events.jsonl");
  }

  getEventsPath(): string {
    return this.eventsPath;
  }

  log(
    level: LogLevel,
    event: string,
    payload: Record<string, unknown> = {}
  ): JsonLogEntry {
    const sanitizedPayload = redactStructuredValue(payload, this.privacy, "log");
    const entry: JsonLogEntry = {
      ts: new Date().toISOString(),
      run_id: this.runId,
      level,
      event,
      payload: sanitizedPayload
    };

    appendFileSync(this.eventsPath, `${JSON.stringify(entry)}\n`, "utf8");

    if (this.db) {
      this.db.insertRunLog({
        runId: this.runId,
        level,
        eventName: event,
        payloadJson: JSON.stringify(sanitizedPayload),
        createdAtMs: Date.now()
      });
    }

    return entry;
  }
}
