import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWriteValidationAccounts,
  resolveWriteValidationAccount,
  upsertWriteValidationAccount
} from "../src/writeValidationAccounts.js";

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

describe("writeValidationAccounts", () => {
  it("upserts and reloads a secondary account with normalized targets", async () => {
    const baseDir = createTempBaseDir();

    const registry = await upsertWriteValidationAccount({
      accountId: "secondary",
      baseDir,
      designation: "secondary",
      label: "Secondary validation account",
      profileName: "secondary-profile",
      sessionName: "secondary-session",
      targets: {
        send_message: {
          participantPattern: "^Test User$",
          thread: "/messaging/thread/abc123/"
        },
        "connections.send_invitation": {
          targetProfile: "test-user"
        },
        "network.followup_after_accept": {
          profileUrlKey: "test-user"
        },
        "feed.like_post": {
          postUrl: "/feed/update/urn:li:activity:123/",
          reaction: "celebrate"
        },
        "post.create": {
          visibility: "connections only"
        }
      }
    });

    expect(registry.accounts.secondary).toMatchObject({
      designation: "secondary",
      label: "Secondary validation account",
      profileName: "secondary-profile",
      sessionName: "secondary-session",
      targets: {
        send_message: {
          participantPattern: "^Test User$",
          thread: "https://www.linkedin.com/messaging/thread/abc123/"
        },
        "connections.send_invitation": {
          targetProfile: "https://www.linkedin.com/in/test-user/"
        },
        "network.followup_after_accept": {
          profileUrlKey: "https://www.linkedin.com/in/test-user/"
        },
        "feed.like_post": {
          postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
          reaction: "celebrate"
        },
        "post.create": {
          visibility: "connections"
        }
      }
    });

    expect(resolveWriteValidationAccount("secondary", baseDir)).toMatchObject({
      designation: "secondary",
      sessionName: "secondary-session"
    });
  });

  it("preserves unrelated config keys when saving accounts", async () => {
    const baseDir = createTempBaseDir();
    const configPath = path.join(baseDir, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({ postSafetyLint: { maxLength: 2800 } }, null, 2)}\n`
    );

    await upsertWriteValidationAccount({
      accountId: "secondary",
      baseDir,
      designation: "secondary"
    });

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      postSafetyLint?: { maxLength?: number };
      writeValidation?: { accounts?: Record<string, unknown> };
    };

    expect(config.postSafetyLint?.maxLength).toBe(2800);
    expect(config.writeValidation?.accounts?.secondary).toBeTruthy();
  });

  it("rejects invalid designation values", async () => {
    const baseDir = createTempBaseDir();

    await expect(
      upsertWriteValidationAccount({
        accountId: "secondary",
        baseDir,
        designation: "tertiary" as "secondary"
      })
    ).rejects.toThrow("designation must be one of: primary, secondary.");
  });

  it("throws when an account is missing", () => {
    const baseDir = createTempBaseDir();

    expect(() => resolveWriteValidationAccount("missing", baseDir)).toThrow(
      'No write-validation account named "missing" was found.'
    );
    expect(loadWriteValidationAccounts(baseDir).accounts).toEqual({});
  });
});
