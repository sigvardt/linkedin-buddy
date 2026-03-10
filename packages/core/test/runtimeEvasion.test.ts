import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreRuntime, resolveConfigPaths } from "../src/index.js";

interface LoggedEvent {
  level: string;
  event: string;
  payload: Record<string, unknown>;
}

async function readRunEvents(baseDir: string, runId: string): Promise<LoggedEvent[]> {
  const eventsPath = path.join(resolveConfigPaths(baseDir).artifactsDir, runId, "events.jsonl");
  const contents = await readFile(eventsPath, "utf8");

  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedEvent);
}

describe("runtime evasion diagnostics", () => {
  let baseDir = "";

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-runtime-evasion-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("exposes resolved evasion config and records a debug diagnostics snapshot", async () => {
    const runtime = createCoreRuntime({
      baseDir,
      dbPath: ":memory:",
      evasionDiagnostics: true,
      evasionLevel: "paranoid",
      runId: "run-evasion-config"
    });
    let closed = false;

    try {
      expect(runtime.evasion).toMatchObject({
        diagnosticsEnabled: true,
        level: "paranoid",
        source: "option"
      });

      runtime.close();
      closed = true;

      const events = await readRunEvents(baseDir, "run-evasion-config");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "debug",
            event: "runtime.evasion.configured",
            payload: expect.objectContaining({
              diagnostics_enabled: true,
              enabled_features: expect.arrayContaining([
                "tab_blur_simulation",
                "viewport_resize_simulation"
              ]),
              evasion_level: "paranoid",
              evasion_source: "option"
            })
          })
        ])
      );
    } finally {
      if (!closed) {
        runtime.close();
      }
    }
  });
});
