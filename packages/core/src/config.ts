import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LINKEDIN_ASSISTANT_HOME = path.join(
  os.homedir(),
  ".linkedin-assistant",
  "linkedin-owa-agentools"
);

export interface ConfigPaths {
  baseDir: string;
  artifactsDir: string;
  profilesDir: string;
  dbPath: string;
}

export function resolveConfigPaths(baseDir?: string): ConfigPaths {
  const resolvedBaseDir =
    baseDir ??
    process.env.LINKEDIN_ASSISTANT_HOME ??
    DEFAULT_LINKEDIN_ASSISTANT_HOME;

  return {
    baseDir: resolvedBaseDir,
    artifactsDir: path.join(resolvedBaseDir, "artifacts"),
    profilesDir: path.join(resolvedBaseDir, "profiles"),
    dbPath: path.join(resolvedBaseDir, "state.sqlite")
  };
}

export function ensureConfigPaths(paths: ConfigPaths): void {
  mkdirSync(paths.baseDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  mkdirSync(paths.profilesDir, { recursive: true });
}
