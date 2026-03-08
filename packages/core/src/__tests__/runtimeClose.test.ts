import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreRuntime } from "../runtime.js";

const tempDirs: string[] = [];

function createTempBaseDir(): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-runtime-close-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) {
      continue;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("core runtime close", () => {
  it("allows close to be called repeatedly", () => {
    const runtime = createCoreRuntime({
      baseDir: createTempBaseDir()
    });

    expect(() => {
      runtime.close();
      runtime.close();
    }).not.toThrow();
  });
});
