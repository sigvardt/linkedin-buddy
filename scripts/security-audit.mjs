#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = listTrackedFiles();
const findings = [];

const blockedTrackedFiles = [
  /^\.env(?:\..+)?$/,
  /^agent-orchestrator\.ya?ml$/
];

const suspiciousValueChecks = [
  {
    label: "OpenAI-style secret",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g
  },
  {
    label: "Slack bot token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
  },
  {
    label: "GitHub token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g
  },
  {
    label: "Bearer token",
    regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g
  },
  {
    label: "AWS access key",
    regex: /\bAKIA[0-9A-Z]{16}\b/g
  },
  {
    label: "Private IPv4 address",
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g
  },
  {
    label: "Absolute home-directory path",
    regex: /(?:\/Users\/[^/\s]+\/|C:\\Users\\[^\\\s]+\\)/g
  },
  {
    label: "Internal hostname or URL",
    regex: /\bhttps?:\/\/[A-Za-z0-9.-]+\.(?:corp|internal|lan|local)(?:[:/][^\s'"]*)?/gi
  }
];

const emailRegex = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const fixtureHeaderRegex = /(?:^|["'])\s*(?:authorization|cookie|set-cookie)\s*(?:["']\s*)?:/gim;
const exemptEmailFiles = new Set(["package-lock.json"]);

for (const filePath of trackedFiles) {
  if (blockedTrackedFiles.some((pattern) => pattern.test(filePath))) {
    findings.push(`${filePath}: tracked local-only file should not be committed`);
  }
}

for (const filePath of trackedFiles) {
  const contents = readUtf8(filePath);
  if (contents === null) {
    continue;
  }

  for (const check of suspiciousValueChecks) {
    for (const match of contents.matchAll(check.regex)) {
      findings.push(
        formatFinding(filePath, contents, match.index ?? 0, `${check.label}: ${match[0]}`)
      );
    }
  }

  if (!exemptEmailFiles.has(filePath)) {
    for (const match of contents.matchAll(emailRegex)) {
      const email = match[0];
      const domain = match[2]?.toLowerCase() ?? "";
      if (
        domain === "example.com" ||
        domain === "example.org" ||
        domain === "example.net" ||
        domain === "example.test" ||
        domain === "users.noreply.github.com"
      ) {
        continue;
      }

      findings.push(
        formatFinding(filePath, contents, match.index ?? 0, `email address: ${email}`)
      );
    }
  }

  if (isFixtureFile(filePath)) {
    for (const match of contents.matchAll(fixtureHeaderRegex)) {
      findings.push(
        formatFinding(filePath, contents, match.index ?? 0, `fixture auth header: ${match[0].trim()}`)
      );
    }
  }
}

const historyEnvFiles = execFileSync(
  "git",
  [
    "log",
    "--all",
    "--diff-filter=A",
    "--pretty=format:",
    "--name-only",
    "--",
    "*.env",
    "*.env.*"
  ],
  { encoding: "utf8" }
)
  .split("\n")
  .map((value) => value.trim())
  .filter(Boolean);

for (const filePath of historyEnvFiles) {
  findings.push(`git history: tracked env file ${filePath}`);
}

if (findings.length > 0) {
  console.error("Security audit failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log(
  `Security audit passed: scanned ${trackedFiles.length} tracked files and found no blocked secrets, private emails, or repo-tracked env files.`
);

function listTrackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .sort();
}

function readUtf8(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isFixtureFile(filePath) {
  return (
    filePath.startsWith("test/fixtures/") ||
    filePath.includes("/test/fixtures/") ||
    filePath.includes("/fixtures/")
  );
}

function formatFinding(filePath, contents, index, label) {
  const prefix = contents.slice(0, index);
  const line = prefix.length === 0 ? 1 : prefix.split("\n").length;
  return `${filePath}:${line}: ${label}`;
}
