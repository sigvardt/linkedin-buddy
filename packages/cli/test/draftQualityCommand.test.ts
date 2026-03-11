import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@linkedin-buddy/core", async () => await import("../../core/src/index.js"));

import { runCli } from "../src/bin/linkedin.js";

function setInteractiveMode(inputIsTty: boolean, outputIsTty: boolean): void {
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: inputIsTty
  });
  Object.defineProperty(stdout, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
}

async function writeJsonFixture(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createPassingDataset(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    cases: [
      {
        id: "pass_case_001",
        thread: {
          participants: [
            {
              id: "assistant",
              name: "You",
              role: "assistant"
            },
            {
              id: "contact",
              name: "Morgan",
              role: "contact"
            }
          ],
          messages: [
            {
              id: "m1",
              author: "Morgan",
              direction: "inbound",
              text: "Could you reconnect next week?"
            }
          ]
        },
        expectations: {
          tone: {
            required: ["warm"],
            forbidden: ["pushy"]
          },
          length: {
            minWords: 4,
            maxWords: 20
          },
          requiredPoints: [
            {
              id: "next_week",
              aliases: ["next week"]
            }
          ]
        },
        candidateDrafts: [
          {
            id: "manual_ok",
            source: "manual",
            text: "Thanks — happy to reconnect next week."
          }
        ]
      }
    ]
  };
}

function createFailingDataset(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    cases: [
      {
        id: "fail_case_001",
        scenario: "Pushy follow-up",
        thread: {
          participants: [
            {
              id: "assistant",
              name: "You",
              role: "assistant"
            },
            {
              id: "contact",
              name: "Morgan",
              role: "contact"
            }
          ],
          messages: [
            {
              id: "m1",
              author: "Morgan",
              direction: "inbound",
              text: "Can you send a quick update next week?"
            }
          ]
        },
        expectations: {
          tone: {
            required: ["warm"],
            forbidden: ["pushy"]
          },
          length: {
            minWords: 1,
            maxWords: 20
          },
          requiredPoints: [
            {
              id: "next_week",
              aliases: ["next week"]
            }
          ],
          forbiddenPhrases: ["just circling back"]
        },
        candidateDrafts: [
          {
            id: "too_pushy",
            source: "model",
            text: "Just circling back ASAP!!!"
          }
        ]
      }
    ]
  };
}

describe("linkedin audit draft-quality", () => {
  let tempDir = "";
  let stderrChunks: string[] = [];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-draft-quality-"));
    process.exitCode = undefined;
    setInteractiveMode(true, true);
    vi.clearAllMocks();
    stderrChunks = [];
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        const [chunk] = args;
        stderrChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs the draft-quality audit command in json mode and writes the report file", async () => {
    setInteractiveMode(false, false);
    const datasetPath = path.join(tempDir, "dataset.json");
    const outputPath = path.join(tempDir, "reports", "draft-quality.json");

    await writeJsonFixture(datasetPath, createPassingDataset());

    await runCli([
      "node",
      "linkedin",
      "audit",
      "draft-quality",
      "--dataset",
      datasetPath,
      "--json",
      "--output",
      outputPath
    ]);

    const consoleOutput = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");
    const report = JSON.parse(consoleOutput) as Record<string, unknown>;
    const writtenReport = JSON.parse(
      await readFile(outputPath, "utf8")
    ) as Record<string, unknown>;

    expect(process.exitCode ?? 0).toBe(0);
    expect(report).toMatchObject({
      outcome: "pass",
      summary: {
        total_drafts: 1,
        failed_drafts: 0
      }
    });
    expect(writtenReport).toMatchObject({
      outcome: "pass",
      dataset_path: path.resolve(datasetPath),
      summary: {
        total_drafts: 1,
        passed_drafts: 1
      }
    });
  });

  it("sets exit code 1 and prints a readable summary for failing audits", async () => {
    const datasetPath = path.join(tempDir, "failing-dataset.json");

    await writeJsonFixture(datasetPath, createFailingDataset());

    await runCli([
      "node",
      "linkedin",
      "audit",
      "draft-quality",
      "--dataset",
      datasetPath
    ]);

    const output = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");

    expect(process.exitCode).toBe(1);
    expect(output).toContain("Draft Quality Evaluation: FAIL");
    expect(output).toContain("Summary: 0 of 1 drafts passed (0.0%) across 1/1 cases.");
    expect(output).toContain(
      "Hard checks: Draft used forbidden phrases: just circling back"
    );
    expect(stderrChunks.join("")).toContain(
      "Starting draft quality evaluation (1 case, 1 draft)."
    );
  });

  it("can hide per-case progress lines in human mode", async () => {
    const datasetPath = path.join(tempDir, "passing-dataset.json");

    await writeJsonFixture(datasetPath, createPassingDataset());

    await runCli([
      "node",
      "linkedin",
      "audit",
      "draft-quality",
      "--dataset",
      datasetPath,
      "--no-progress"
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stderrChunks).toEqual([]);
  });

  it("prints friendly validation errors in human mode", async () => {
    const datasetPath = path.join(tempDir, "invalid-dataset.json");

    await writeJsonFixture(datasetPath, {
      schemaVersion: 1,
      cases: []
    });

    await runCli([
      "node",
      "linkedin",
      "audit",
      "draft-quality",
      "--dataset",
      datasetPath
    ]);

    const stderrOutput = stderrChunks.join("");

    expect(process.exitCode).toBe(1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(stderrOutput).toContain("Draft quality evaluation failed [ACTION_PRECONDITION_FAILED]");
    expect(stderrOutput).toContain("Draft-quality dataset must contain at least one case.");
    expect(stderrOutput).toContain("Location: dataset.cases");
    expect(stderrOutput).toContain("Tip: run linkedin audit draft-quality --help");
  });

  it("rejects non-file dataset paths before reading", async () => {
    const datasetDir = path.join(tempDir, "dataset-dir");
    await mkdir(datasetDir, { recursive: true });

    await runCli([
      "node",
      "linkedin",
      "audit",
      "draft-quality",
      "--dataset",
      datasetDir
    ]);

    const stderrOutput = stderrChunks.join("");

    expect(process.exitCode).toBe(1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(stderrOutput).toContain("Draft quality evaluation failed [ACTION_PRECONDITION_FAILED]");
    expect(stderrOutput).toContain(
      "Expected draft-quality dataset path to point to a file."
    );
    expect(stderrOutput).toContain(`Path: ${path.resolve(datasetDir)}`);
  });

  it("shows complete help output for the draft-quality command", async () => {
    const stdoutChunks: string[] = [];
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((...args: Parameters<typeof process.stdout.write>) => {
        const [chunk] = args;
        stdoutChunks.push(String(chunk));
        return true;
      });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((((code?: Parameters<typeof process.exit>[0]) => {
        throw new Error(`process.exit:${String(code ?? 0)}`);
      }) as typeof process.exit));

    try {
      await expect(
        runCli(["node", "linkedin", "audit", "draft-quality", "--help"])
      ).rejects.toThrow("process.exit:0");
    } finally {
      stdoutWriteSpy.mockRestore();
      exitSpy.mockRestore();
    }

    const helpOutput = stdoutChunks.join("");

    expect(helpOutput).toContain(
      "Evaluate draft replies against case-specific quality expectations"
    );
    expect(helpOutput).toContain("--dataset <path>");
    expect(helpOutput).toContain("--candidates <path>");
    expect(helpOutput).toContain("--json");
    expect(helpOutput).toContain("--verbose");
    expect(helpOutput).toContain("--no-progress");
    expect(helpOutput).toContain("--output <path>");
    expect(helpOutput).toContain("Examples:");
    expect(helpOutput).toContain(
      "linkedin audit draft-quality --dataset dataset.json --candidates candidates.json --verbose"
    );
  });
});
