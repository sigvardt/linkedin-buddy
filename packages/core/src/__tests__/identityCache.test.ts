import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearIdentityCache,
  readIdentityCache,
  resolveIdentityCachePath,
  writeIdentityCache,
} from "../auth/identityCache.js";

const tempDirs: string[] = [];

async function createTempBaseDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-identity-cache-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) =>
      rm(tempDir, { recursive: true, force: true }),
    ),
  );
});

describe("identity cache", () => {
  it("resolveIdentityCachePath returns expected default path structure", () => {
    expect(resolveIdentityCachePath("demo")).toBe(
      path.join(
        os.homedir(),
        ".linkedin-buddy",
        "linkedin-buddy",
        "profiles",
        "identity-cache",
        "demo.identity.json",
      ),
    );
  });

  it("resolveIdentityCachePath uses custom baseDir", async () => {
    const baseDir = await createTempBaseDir();
    expect(resolveIdentityCachePath("demo", baseDir)).toBe(
      path.join(baseDir, "profiles", "identity-cache", "demo.identity.json"),
    );
  });

  it("writeIdentityCache and readIdentityCache round-trip full identity", async () => {
    const baseDir = await createTempBaseDir();

    await writeIdentityCache(
      "default",
      {
        fullName: "Test Operator",
        vanityName: "test-operator",
        profileUrl: "https://www.linkedin.com/in/test-operator/",
      },
      baseDir,
    );

    const cached = await readIdentityCache("default", baseDir);
    expect(cached).not.toBeNull();
    expect(cached).toMatchObject({
      fullName: "Test Operator",
      vanityName: "test-operator",
      profileUrl: "https://www.linkedin.com/in/test-operator/",
    });
    expect(cached?.cachedAt).toEqual(expect.any(String));
  });

  it("writeIdentityCache and readIdentityCache round-trip null identity fields", async () => {
    const baseDir = await createTempBaseDir();

    await writeIdentityCache(
      "default",
      {
        fullName: null,
        vanityName: null,
        profileUrl: null,
      },
      baseDir,
    );

    const cached = await readIdentityCache("default", baseDir);
    expect(cached).toMatchObject({
      fullName: null,
      vanityName: null,
      profileUrl: null,
    });
    expect(cached?.cachedAt).toEqual(expect.any(String));
  });

  it("readIdentityCache returns null for missing file", async () => {
    const baseDir = await createTempBaseDir();
    await expect(readIdentityCache("missing", baseDir)).resolves.toBeNull();
  });

  it("readIdentityCache returns null for corrupt JSON", async () => {
    const baseDir = await createTempBaseDir();
    const filePath = resolveIdentityCachePath("default", baseDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "not-json", "utf8");

    await expect(readIdentityCache("default", baseDir)).resolves.toBeNull();
  });

  it("readIdentityCache returns null for invalid shape", async () => {
    const baseDir = await createTempBaseDir();
    const filePath = resolveIdentityCachePath("default", baseDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ fullName: "Only Name" }, null, 2),
      "utf8",
    );

    await expect(readIdentityCache("default", baseDir)).resolves.toBeNull();
  });

  it("clearIdentityCache returns true when file exists", async () => {
    const baseDir = await createTempBaseDir();
    await writeIdentityCache(
      "default",
      {
        fullName: "Test Operator",
        vanityName: "test-operator",
        profileUrl: "https://www.linkedin.com/in/test-operator/",
      },
      baseDir,
    );

    await expect(clearIdentityCache("default", baseDir)).resolves.toBe(true);
  });

  it("clearIdentityCache returns false when file does not exist", async () => {
    const baseDir = await createTempBaseDir();
    await expect(clearIdentityCache("default", baseDir)).resolves.toBe(false);
  });

  it("session name normalization defaults undefined to default", async () => {
    const baseDir = await createTempBaseDir();

    await writeIdentityCache(
      "default",
      {
        fullName: "Default User",
        vanityName: "default-user",
        profileUrl: "https://www.linkedin.com/in/default-user/",
      },
      baseDir,
    );

    const byUndefined = await readIdentityCache(undefined, baseDir);
    const byExplicit = await readIdentityCache("default", baseDir);
    expect(byUndefined).toEqual(byExplicit);
  });

  it("session name validation rejects path traversal", () => {
    expect(() => resolveIdentityCachePath("../evil")).toThrowError(
      /path separators or relative path segments/u,
    );
  });
});
