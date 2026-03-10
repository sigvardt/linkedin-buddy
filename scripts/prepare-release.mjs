#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReleaseNotes,
  formatCalver,
  selectReleaseVersion
} from "./release-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPackageName = "@linkedin-buddy/cli";
const releaseTagPrefix = "v";
const rootPackageJsonPath = path.join(repoRoot, "package.json");
const workspacePackageJsonPaths = [
  path.join(repoRoot, "packages/core/package.json"),
  path.join(repoRoot, "packages/cli/package.json"),
  path.join(repoRoot, "packages/mcp/package.json")
];

/**
 * @typedef {{
 *   checkOnly: boolean;
 *   mode: "scheduled" | "manual";
 *   notesFilePath: string;
 *   today: Date;
 * }} ParsedArgs
 */

/**
 * @typedef {{
 *   commitsSincePreviousRelease: number;
 *   latestPublishedVersion: string | null;
 *   previousReleaseTag: string | null;
 *   reason: string | null;
 *   releaseNotes: string | null;
 *   releaseNotesPath: string;
 *   skip: boolean;
 *   version: string | null;
 * }} ReleasePreparationResult
 */

const parsedArgs = parseArgs(process.argv.slice(2));
const result = prepareRelease(parsedArgs);

writeOutputs(result);

if (!result.skip && !parsedArgs.checkOnly && result.version !== null) {
  applyVersion(result.version);
}

if (!result.skip && result.releaseNotes !== null) {
  writeReleaseNotes(parsedArgs.notesFilePath, result.releaseNotes);
}

if (result.skip) {
  console.log(result.reason ?? "release skipped");
} else {
  console.log(`Prepared release ${String(result.version)}.`);
}

/**
 * @param {ParsedArgs} args
 * @returns {ReleasePreparationResult}
 */
function prepareRelease(args) {
  const latestPublishedVersion = getLatestPublishedVersion(canonicalPackageName);
  const sortedReleaseTags = getSortedReleaseTags();
  const publishedTag = latestPublishedVersion === null
    ? null
    : `${releaseTagPrefix}${latestPublishedVersion}`;
  const previousReleaseTag = resolvePreviousReleaseTag(sortedReleaseTags, publishedTag);
  const commitsSincePreviousRelease = countCommitsSince(previousReleaseTag);

  if (commitsSincePreviousRelease === 0) {
    return {
      commitsSincePreviousRelease,
      latestPublishedVersion,
      previousReleaseTag,
      reason: "No commits since the previous release.",
      releaseNotes: null,
      releaseNotesPath: args.notesFilePath,
      skip: true,
      version: null
    };
  }

  const existingVersions = new Set(
    sortedReleaseTags.map((tag) => stripReleaseTagPrefix(tag))
  );
  const baseVersion = formatCalver(args.today);

  if (args.mode === "scheduled" && existingVersions.has(baseVersion)) {
    return {
      commitsSincePreviousRelease,
      latestPublishedVersion,
      previousReleaseTag,
      reason: `Scheduled release ${baseVersion} already exists.`,
      releaseNotes: null,
      releaseNotesPath: args.notesFilePath,
      skip: true,
      version: null
    };
  }

  const version = selectReleaseVersion({
    date: args.today,
    existingVersions,
    mode: args.mode
  });
  const commits = readCommits(previousReleaseTag);
  const compareUrl = buildCompareUrl(previousReleaseTag);
  const releaseNotes = buildReleaseNotes({
    version,
    commits,
    repository: process.env.GITHUB_REPOSITORY,
    previousTag: previousReleaseTag,
    compareUrl
  });

  return {
    commitsSincePreviousRelease,
    latestPublishedVersion,
    previousReleaseTag,
    reason: null,
    releaseNotes,
    releaseNotesPath: args.notesFilePath,
    skip: false,
    version
  };
}

/**
 * @param {string} version
 */
function applyVersion(version) {
  const rootPackageJson = readJson(rootPackageJsonPath);
  rootPackageJson.version = version;
  writeJson(rootPackageJsonPath, rootPackageJson);

  for (const workspacePath of workspacePackageJsonPaths) {
    const packageJson = readJson(workspacePath);
    packageJson.version = version;

    if (workspacePath.endsWith("/packages/cli/package.json")) {
      packageJson.dependencies["@linkedin-buddy/core"] = version;
    }

    if (workspacePath.endsWith("/packages/mcp/package.json")) {
      packageJson.dependencies["@linkedin-buddy/core"] = version;
    }

    writeJson(workspacePath, packageJson);
  }

  execFileSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts"],
    {
      cwd: repoRoot,
      stdio: "inherit"
    }
  );
}

/**
 * @param {string} notesFilePath
 * @param {string} releaseNotes
 */
function writeReleaseNotes(notesFilePath, releaseNotes) {
  mkdirSync(path.dirname(notesFilePath), { recursive: true });
  writeFileSync(notesFilePath, releaseNotes, "utf8");
}

/**
 * @param {ReleasePreparationResult} result
 */
function writeOutputs(result) {
  const githubOutputPath = process.env.GITHUB_OUTPUT;
  if (typeof githubOutputPath === "string" && githubOutputPath.length > 0) {
    appendGitHubOutput(githubOutputPath, "skip", result.skip ? "true" : "false");
    appendGitHubOutput(
      githubOutputPath,
      "commits_since_previous_release",
      String(result.commitsSincePreviousRelease)
    );
    appendGitHubOutput(
      githubOutputPath,
      "latest_published_version",
      result.latestPublishedVersion ?? ""
    );
    appendGitHubOutput(
      githubOutputPath,
      "previous_release_tag",
      result.previousReleaseTag ?? ""
    );
    appendGitHubOutput(githubOutputPath, "reason", result.reason ?? "");
    appendGitHubOutput(
      githubOutputPath,
      "release_notes_path",
      result.releaseNotesPath
    );
    appendGitHubOutput(githubOutputPath, "version", result.version ?? "");
    appendGitHubOutput(
      githubOutputPath,
      "tag",
      result.version === null ? "" : `${releaseTagPrefix}${result.version}`
    );
  }
}

/**
 * @param {string[]} sortedReleaseTags
 * @param {string | null} publishedTag
 * @returns {string | null}
 */
function resolvePreviousReleaseTag(sortedReleaseTags, publishedTag) {
  if (publishedTag !== null && !sortedReleaseTags.includes(publishedTag)) {
    throw new Error(
      `Latest published version tag ${publishedTag} is missing from the repository.`
    );
  }

  if (sortedReleaseTags.length > 0) {
    return sortedReleaseTags[0];
  }

  return publishedTag;
}

/**
 * @returns {string[]}
 */
function getSortedReleaseTags() {
  const rawOutput = runGit(["tag", "--sort=-v:refname", "--list", `${releaseTagPrefix}*`]);
  if (rawOutput.length === 0) {
    return [];
  }

  return rawOutput
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * @param {string | null} previousReleaseTag
 * @returns {number}
 */
function countCommitsSince(previousReleaseTag) {
  if (previousReleaseTag === null) {
    return Number.parseInt(runGit(["rev-list", "--count", "HEAD"]), 10);
  }

  return Number.parseInt(
    runGit(["rev-list", "--count", `${previousReleaseTag}..HEAD`]),
    10
  );
}

/**
 * @param {string | null} previousReleaseTag
 * @returns {{ sha: string; subject: string }[]}
 */
function readCommits(previousReleaseTag) {
  const range = previousReleaseTag === null ? "HEAD" : `${previousReleaseTag}..HEAD`;
  const rawOutput = runGit([
    "log",
    "--reverse",
    "--format=%H%x09%s",
    range
  ]);

  if (rawOutput.length === 0) {
    return [];
  }

  return rawOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, ...subjectParts] = line.split("\t");
      return {
        sha,
        subject: subjectParts.join("\t")
      };
    });
}

/**
 * @param {string | null} previousReleaseTag
 * @returns {string | null}
 */
function buildCompareUrl(previousReleaseTag) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || repository.length === 0) {
    return null;
  }

  if (previousReleaseTag === null) {
    return null;
  }

  const headSha = runGit(["rev-parse", "HEAD"]);
  return `https://github.com/${repository}/compare/${previousReleaseTag}...${headSha}`;
}

/**
 * @param {string} packageName
 * @returns {string | null}
 */
function getLatestPublishedVersion(packageName) {
  try {
    const rawOutput = runCommand("npm", ["view", packageName, "version", "--json"]);
    if (rawOutput.length === 0) {
      return null;
    }

    const parsedOutput = JSON.parse(rawOutput);
    return typeof parsedOutput === "string" ? parsedOutput : null;
  } catch (error) {
    if (
      error instanceof Error &&
      typeof error.message === "string" &&
      error.message.includes("E404")
    ) {
      return null;
    }

    throw error;
  }
}

/**
 * @param {string[]} args
 * @returns {ParsedArgs}
 */
function parseArgs(args) {
  /** @type {ParsedArgs} */
  const parsedArgs = {
    checkOnly: false,
    mode: "scheduled",
    notesFilePath: path.join(repoRoot, ".release-notes.md"),
    today: new Date()
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--check-only") {
      parsedArgs.checkOnly = true;
      continue;
    }

    if (argument === "--mode") {
      const mode = args[index + 1];
      if (mode !== "manual" && mode !== "scheduled") {
        throw new Error(`Unsupported release mode: ${String(mode)}`);
      }

      parsedArgs.mode = mode;
      index += 1;
      continue;
    }

    if (argument === "--notes-file") {
      const notesFilePath = args[index + 1];
      if (typeof notesFilePath !== "string" || notesFilePath.length === 0) {
        throw new Error("Expected a path after --notes-file.");
      }

      parsedArgs.notesFilePath = path.resolve(repoRoot, notesFilePath);
      index += 1;
      continue;
    }

    if (argument === "--today") {
      const todayValue = args[index + 1];
      if (typeof todayValue !== "string" || todayValue.length === 0) {
        throw new Error("Expected an ISO date after --today.");
      }

      const parsedDate = new Date(todayValue);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new Error(`Invalid date passed to --today: ${todayValue}`);
      }

      parsedArgs.today = parsedDate;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return parsedArgs;
}

/**
 * @param {string} outputPath
 * @param {string} key
 * @param {string} value
 */
function appendGitHubOutput(outputPath, key, value) {
  const multilineMarker = "EOF_RELEASE_OUTPUT";
  appendFileSync(
    outputPath,
    `${key}<<${multilineMarker}\n${value}\n${multilineMarker}\n`,
    "utf8"
  );
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function runGit(args) {
  return runCommand("git", args);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function runCommand(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

/**
 * @param {string} tag
 * @returns {string}
 */
function stripReleaseTagPrefix(tag) {
  return tag.startsWith(releaseTagPrefix) ? tag.slice(releaseTagPrefix.length) : tag;
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * @param {string} filePath
 * @param {Record<string, unknown>} value
 */
function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
