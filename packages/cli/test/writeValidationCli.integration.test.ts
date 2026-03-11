import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@linkedin-buddy/core", async () => {
  return await import("../../core/src/index.js");
});

import { loadWriteValidationAccounts } from "@linkedin-buddy/core";
import { runCli } from "../src/bin/linkedin.js";

function createAccountsAddArgv(
  accountId: string,
  extraArgs: string[] = []
): string[] {
  return [
    "node",
    "linkedin",
    "accounts",
    "add",
    accountId,
    "--designation",
    "secondary",
    "--label",
    " Secondary Account ",
    "--profile",
    "secondary-profile",
    "--session",
    "secondary-session",
    "--message-thread",
    "/messaging/thread/abc123/",
    "--message-participant-pattern",
    " Simon Miller ",
    "--invite-profile",
    "realsimonmiller",
    "--invite-note",
    " Hello there ",
    "--followup-profile",
    "realsimonmiller",
    "--reaction-post",
    "/feed/update/urn:li:activity:123/",
    "--reaction",
    "like",
    "--post-visibility",
    "connections",
    ...extraArgs
  ];
}

describe("write validation CLI integration", () => {
  let assistantHome = "";
  let stderrChunks: string[] = [];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-write-validation-"));
    assistantHome = path.join(tempDir, "buddy-home");
    process.env.LINKEDIN_BUDDY_HOME = assistantHome;
    process.exitCode = undefined;
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
    delete process.env.LINKEDIN_BUDDY_HOME;
    await rm(tempDir, { force: true, recursive: true });
  });

  it("writes normalized account config that can be listed from disk", async () => {
    await runCli(createAccountsAddArgv("secondary"));

    const registry = loadWriteValidationAccounts(assistantHome);

    expect(registry.accounts.secondary).toEqual({
      designation: "secondary",
      id: "secondary",
      label: "Secondary Account",
      profileName: "secondary-profile",
      sessionName: "secondary-session",
      targets: {
        "connections.send_invitation": {
          note: "Hello there",
          targetProfile: "https://www.linkedin.com/in/realsimonmiller/"
        },
        "feed.like_post": {
          postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
          reaction: "like"
        },
        "network.followup_after_accept": {
          profileUrlKey: "https://www.linkedin.com/in/realsimonmiller/"
        },
        "post.create": {
          visibility: "connections"
        },
        send_message: {
          participantPattern: "Simon Miller",
          thread: "https://www.linkedin.com/messaging/thread/abc123/"
        }
      }
    });

    expect(JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? ""))).toMatchObject({
      saved: true
    });
  });

  it("blocks accidental overwrite and updates the saved account when --force is provided", async () => {
    await runCli(createAccountsAddArgv("secondary"));

    await expect(runCli(createAccountsAddArgv("secondary"))).rejects.toThrow(
      'Write-validation account "secondary" already exists. Rerun with overwrite enabled to replace it.'
    );

    await runCli(
      createAccountsAddArgv("secondary", ["--label", "Replacement Account", "--force"])
    );

    expect(loadWriteValidationAccounts(assistantHome).accounts.secondary).toMatchObject({
      label: "Replacement Account"
    });
  });

  it("surfaces malformed config errors before mutating account data", async () => {
    const configPath = path.join(assistantHome, "config.json");

    await mkdir(assistantHome, { recursive: true });
    await writeFile(configPath, "{ invalid-json\n", "utf8");

    await expect(runCli(createAccountsAddArgv("secondary"))).rejects.toThrow(
      `Failed to parse LinkedIn Buddy config file at ${configPath}.`
    );

    expect(
      stderrChunks.filter(
        (chunk) => !chunk.includes("linkedin-buddy feedback")
      )
    ).toEqual([]);
    await expect(readFile(configPath, "utf8")).resolves.toBe("{ invalid-json\n");
  });
});
