import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { isDirectExecution } from "../src/bin/linkedin.js";

describe("CLI entrypoint detection", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("treats symlinked lbud alias as direct execution", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-entrypoint-"));

    const targetPath = path.join(tempDir, "linkedin.js");
    const aliasPath = path.join(tempDir, "lbud");

    await writeFile(targetPath, "#!/usr/bin/env node\n", "utf8");
    await symlink(targetPath, aliasPath);

    expect(isDirectExecution(pathToFileURL(targetPath).href, aliasPath)).toBe(
      true,
    );
  });

  it("treats symlinked linkedin-buddy alias as direct execution", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-entrypoint-"));

    const targetPath = path.join(tempDir, "linkedin.js");
    const aliasPath = path.join(tempDir, "linkedin-buddy");

    await writeFile(targetPath, "#!/usr/bin/env node\n", "utf8");
    await symlink(targetPath, aliasPath);

    expect(isDirectExecution(pathToFileURL(targetPath).href, aliasPath)).toBe(
      true,
    );
  });

  it("rejects unrelated entrypoints", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-entrypoint-"));

    const targetPath = path.join(tempDir, "linkedin.js");
    const otherPath = path.join(tempDir, "linkedin-buddy.js");

    await writeFile(targetPath, "#!/usr/bin/env node\n", "utf8");
    await writeFile(otherPath, "#!/usr/bin/env node\n", "utf8");

    expect(isDirectExecution(pathToFileURL(targetPath).href, otherPath)).toBe(
      false,
    );
  });
});
