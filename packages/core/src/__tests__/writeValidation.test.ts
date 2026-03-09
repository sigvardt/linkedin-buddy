import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runLinkedInWriteValidation,
  validateWriteValidationOptions
} from "../writeValidation.js";
import { upsertWriteValidationAccount } from "../writeValidationAccounts.js";

const tempDirs: string[] = [];

function createTempBaseDir(): string {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "linkedin-write-validation-"));
  tempDirs.push(baseDir);
  return baseDir;
}

afterEach(() => {
  delete process.env.CI;
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("write validation helpers", () => {
  it("rejects invalid timeout and cooldown values", () => {
    expect(() =>
      validateWriteValidationOptions({
        accountId: "secondary",
        cooldownMs: -1
      })
    ).toThrow("cooldownMs must be a non-negative integer.");

    expect(() =>
      validateWriteValidationOptions({
        accountId: "secondary",
        timeoutMs: 0
      })
    ).toThrow("timeoutMs must be a positive integer.");
  });

  it("blocks CI before performing write validation", async () => {
    process.env.CI = "1";

    await expect(
      runLinkedInWriteValidation({
        accountId: "secondary",
        interactive: true
      })
    ).rejects.toThrow("Write validation cannot run in CI.");
  });

  it("blocks primary accounts before loading any stored session", async () => {
    const baseDir = createTempBaseDir();
    await upsertWriteValidationAccount({
      accountId: "primary-account",
      baseDir,
      designation: "primary"
    });

    await expect(
      runLinkedInWriteValidation({
        accountId: "primary-account",
        baseDir,
        interactive: true
      })
    ).rejects.toThrow(
      'Write validation can run only against a registered secondary account.'
    );
  });
});
