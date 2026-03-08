import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupRuntime,
  getE2EBaseDir,
  withAssistantHome,
  withE2EEnvironment
} from "./e2e/setup.js";

const originalAssistantHome = process.env.LINKEDIN_ASSISTANT_HOME;

afterEach(() => {
  cleanupRuntime();

  if (originalAssistantHome === undefined) {
    delete process.env.LINKEDIN_ASSISTANT_HOME;
    return;
  }

  process.env.LINKEDIN_ASSISTANT_HOME = originalAssistantHome;
});

describe("E2E setup helpers", () => {
  it("uses a stable assistant home inside E2E environment callbacks", async () => {
    process.env.LINKEDIN_ASSISTANT_HOME = "/tmp/original-linkedin-home";

    const baseDir = getE2EBaseDir();
    expect(existsSync(baseDir)).toBe(true);

    await withE2EEnvironment(async () => {
      expect(process.env.LINKEDIN_ASSISTANT_HOME).toBe(baseDir);
      expect(getE2EBaseDir()).toBe(baseDir);
    });

    expect(process.env.LINKEDIN_ASSISTANT_HOME).toBe("/tmp/original-linkedin-home");
  });

  it("restores the previous assistant home after explicit overrides", async () => {
    process.env.LINKEDIN_ASSISTANT_HOME = "/tmp/original-linkedin-home";

    await withAssistantHome("/tmp/isolated-linkedin-home", async () => {
      expect(process.env.LINKEDIN_ASSISTANT_HOME).toBe("/tmp/isolated-linkedin-home");
    });

    expect(process.env.LINKEDIN_ASSISTANT_HOME).toBe("/tmp/original-linkedin-home");
  });

  it("cleans up the shared E2E assistant home between runs", () => {
    const firstDir = getE2EBaseDir();
    expect(existsSync(firstDir)).toBe(true);

    cleanupRuntime();
    expect(existsSync(firstDir)).toBe(false);

    const secondDir = getE2EBaseDir();
    expect(secondDir).not.toBe(firstDir);
    expect(existsSync(secondDir)).toBe(true);
    cleanupRuntime();

    expect(existsSync(secondDir)).toBe(false);
  });
});
