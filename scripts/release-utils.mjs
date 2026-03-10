/**
 * @typedef {{
 *   sha: string;
 *   subject: string;
 * }} ReleaseCommit
 */

/**
 * @typedef {"scheduled" | "manual"} ReleaseMode
 */

const CONVENTIONAL_FEATURE_TYPES = new Set(["feat"]);
const CONVENTIONAL_FIX_TYPES = new Set(["fix"]);

/**
 * Formats a UTC calendar version using the repository's `YYYY.M.D` scheme.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatCalver(date) {
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
}

/**
 * Returns the release version for the given mode and existing release history.
 *
 * Scheduled releases always use the bare date. Manual releases append `-N`
 * only when the same-day base version already exists.
 *
 * @param {{
 *   date: Date;
 *   existingVersions: Iterable<string>;
 *   mode: ReleaseMode;
 * }} input
 * @returns {string}
 */
export function selectReleaseVersion({ date, existingVersions, mode }) {
  const baseVersion = formatCalver(date);

  if (mode === "scheduled") {
    return baseVersion;
  }

  let highestPatch = -1;
  const patchPattern = new RegExp(`^${escapeRegExp(baseVersion)}-(\\d+)$`);

  for (const version of existingVersions) {
    if (version === baseVersion) {
      highestPatch = Math.max(highestPatch, 0);
      continue;
    }

    const match = patchPattern.exec(version);
    if (!match) {
      continue;
    }

    const patchNumber = Number.parseInt(match[1], 10);
    if (Number.isNaN(patchNumber)) {
      continue;
    }

    highestPatch = Math.max(highestPatch, patchNumber);
  }

  if (highestPatch < 0) {
    return baseVersion;
  }

  return `${baseVersion}-${highestPatch + 1}`;
}

/**
 * Groups commits into conventional-commit-inspired release sections.
 *
 * @param {ReleaseCommit[]} commits
 * @returns {{
 *   features: ReleaseCommit[];
 *   fixes: ReleaseCommit[];
 *   other: ReleaseCommit[];
 * }}
 */
export function groupCommitsBySection(commits) {
  return commits.reduce(
    (sections, commit) => {
      const type = readConventionalCommitType(commit.subject);

      if (type !== null && CONVENTIONAL_FEATURE_TYPES.has(type)) {
        sections.features.push(commit);
        return sections;
      }

      if (type !== null && CONVENTIONAL_FIX_TYPES.has(type)) {
        sections.fixes.push(commit);
        return sections;
      }

      sections.other.push(commit);
      return sections;
    },
    /** @type {{
     *   features: ReleaseCommit[];
     *   fixes: ReleaseCommit[];
     *   other: ReleaseCommit[];
     * }} */ ({
      features: [],
      fixes: [],
      other: []
    })
  );
}

/**
 * Builds the GitHub Release body for a release candidate.
 *
 * @param {{
 *   version: string;
 *   commits: ReleaseCommit[];
 *   repository?: string;
 *   previousTag?: string | null;
 *   compareUrl?: string | null;
 * }} input
 * @returns {string}
 */
export function buildReleaseNotes({
  version,
  commits,
  repository,
  previousTag = null,
  compareUrl = null
}) {
  const lines = [`# v${version}`, ""];
  const sections = groupCommitsBySection(commits);

  if (previousTag !== null) {
    lines.push(`Changes since \`${previousTag}\`.`, "");
  } else {
    lines.push("Initial automated release.", "");
  }

  appendReleaseSection(lines, "Features", sections.features, repository);
  appendReleaseSection(lines, "Fixes", sections.fixes, repository);
  appendReleaseSection(lines, "Other", sections.other, repository);

  if (commits.length === 0) {
    lines.push("## Other", "", "- Maintenance release with no grouped commits.");
  }

  if (compareUrl !== null) {
    lines.push("", `Compare: ${compareUrl}`);
  }

  return `${lines.join("\n").trim()}\n`;
}

/**
 * @param {string[]} lines
 * @param {string} heading
 * @param {ReleaseCommit[]} commits
 * @param {string | undefined} repository
 */
function appendReleaseSection(lines, heading, commits, repository) {
  if (commits.length === 0) {
    return;
  }

  lines.push(`## ${heading}`, "");
  for (const commit of commits) {
    lines.push(formatCommitLine(commit, repository));
  }
  lines.push("");
}

/**
 * @param {ReleaseCommit} commit
 * @param {string | undefined} repository
 * @returns {string}
 */
function formatCommitLine(commit, repository) {
  const shortSha = commit.sha.slice(0, 7);

  if (typeof repository === "string" && repository.length > 0) {
    return `- ${commit.subject} ([${shortSha}](https://github.com/${repository}/commit/${commit.sha}))`;
  }

  return `- ${commit.subject} (${shortSha})`;
}

/**
 * @param {string} subject
 * @returns {string | null}
 */
function readConventionalCommitType(subject) {
  const match = /^(?<type>[a-z]+)(?:\([^)]*\))?(?:!)?(?::|\s)/i.exec(subject.trim());
  return match?.groups?.type?.toLowerCase() ?? null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
