import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWriteValidationAccounts,
  resolveWriteValidationAccount,
  upsertWriteValidationAccount
} from "../writeValidationAccounts.js";

const tempDirs: string[] = [];

function createTempBaseDir(): string {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "linkedin-write-validation-accounts-"));
  tempDirs.push(baseDir);
  return baseDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("write-validation account registry", () => {
  it("normalizes and persists approved targets", async () => {
    const baseDir = createTempBaseDir();

    await upsertWriteValidationAccount({
      accountId: "secondary",
      baseDir,
      designation: "secondary",
      label: " Secondary Account ",
      profileName: " secondary-profile ",
      sessionName: " secondary-session ",
      targets: {
        send_message: {
          thread: "/messaging/thread/abc123/",
          participantPattern: "  Simon Miller  "
        },
        "connections.send_invitation": {
          note: "  hello there  ",
          targetProfile: "realsimonmiller"
        },
        "network.followup_after_accept": {
          profileUrlKey: "realsimonmiller"
        },
        "feed.like_post": {
          postUrl: "/feed/update/urn:li:activity:123/",
          reaction: "like"
        },
        "post.create": {
          visibility: "connections"
        }
      }
    });

    expect(resolveWriteValidationAccount("secondary", baseDir)).toEqual({
      id: "secondary",
      designation: "secondary",
      label: "Secondary Account",
      profileName: "secondary-profile",
      sessionName: "secondary-session",
      targets: {
        send_message: {
          thread: "https://www.linkedin.com/messaging/thread/abc123/",
          participantPattern: "Simon Miller"
        },
        "connections.send_invitation": {
          note: "hello there",
          targetProfile: "https://www.linkedin.com/in/realsimonmiller/"
        },
        "network.followup_after_accept": {
          profileUrlKey: "https://www.linkedin.com/in/realsimonmiller/"
        },
        "feed.like_post": {
          postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
          reaction: "like"
        },
        "post.create": {
          visibility: "connections"
        }
      }
    });
  });

  it("rejects non-object account registries with a clear config error", () => {
    const baseDir = createTempBaseDir();
    const configPath = path.join(baseDir, "config.json");

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          writeValidation: {
            accounts: []
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(() => loadWriteValidationAccounts(baseDir)).toThrow(
      `writeValidation.accounts in ${configPath} must be a JSON object.`
    );
  });

  it("rejects malformed config files with the config path in the error", () => {
    const baseDir = createTempBaseDir();
    const configPath = path.join(baseDir, "config.json");

    writeFileSync(configPath, "{ not-valid-json\n", "utf8");

    expect(() => loadWriteValidationAccounts(baseDir)).toThrow(
      `Failed to parse LinkedIn Buddy config file at ${configPath}.`
    );
  });

  it("lists updated accounts after overwrite and blocks accidental replacement", async () => {
    const baseDir = createTempBaseDir();

    await upsertWriteValidationAccount({
      accountId: "secondary",
      baseDir,
      designation: "secondary",
      label: "Secondary One"
    });

    await expect(
      upsertWriteValidationAccount({
        accountId: "secondary",
        baseDir,
        designation: "secondary",
        label: "Secondary Two"
      })
    ).rejects.toThrow(
      'Write-validation account "secondary" already exists. Rerun with overwrite enabled to replace it.'
    );

    const registry = await upsertWriteValidationAccount({
      accountId: "secondary",
      baseDir,
      designation: "secondary",
      label: "Secondary Two",
      overwrite: true,
      profileName: "secondary-two",
      sessionName: "secondary-two"
    });

    expect(Object.keys(registry.accounts)).toEqual(["secondary"]);
    expect(registry.accounts.secondary).toMatchObject({
      label: "Secondary Two",
      profileName: "secondary-two",
      sessionName: "secondary-two"
    });
  });

  it("rejects invalid saved account targets when loading the registry", () => {
    const baseDir = createTempBaseDir();
    const configPath = path.join(baseDir, "config.json");

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          writeValidation: {
            accounts: {
              secondary: {
                designation: "secondary",
                targets: {
                  send_message: {
                    thread: ""
                  }
                }
              }
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(() => loadWriteValidationAccounts(baseDir)).toThrow(
      "writeValidation.accounts.secondary.targets.send_message.thread must not be empty."
    );
  });
});
