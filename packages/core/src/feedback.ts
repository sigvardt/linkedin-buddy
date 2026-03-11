import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";

export const FEEDBACK_TYPES = ["bug", "feature", "improvement"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV =
  "LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N";
export const LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS_ENV =
  "LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS";
export const LINKEDIN_ASSISTANT_FEEDBACK_HINT_EVERY_N_ENV =
  LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV;
export const LINKEDIN_ASSISTANT_FEEDBACK_SESSION_IDLE_MS_ENV =
  LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS_ENV;

export const DEFAULT_FEEDBACK_HINT_EVERY_N = 20;
export const DEFAULT_FEEDBACK_SESSION_IDLE_MS = 30 * 60 * 1000;
export const FEEDBACK_GITHUB_REPOSITORY = "sigvardt/linkedin-buddy";

const FEEDBACK_ROOT_DIRNAME = ".linkedin-buddy";
const FEEDBACK_PENDING_DIRNAME = "pending-feedback";
const FEEDBACK_STATE_FILENAME = "feedback-state.json";
const REDACTED_TOKEN = "[REDACTED]";
const FEEDBACK_PENDING_FILE_EXTENSION = ".md";
const FEEDBACK_METADATA_HEADER = "<!-- linkedin-buddy-feedback-metadata";
const FEEDBACK_METADATA_FOOTER = "-->";
const MAX_STORED_ERROR_STACK_CHARS = 12_000;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const LINKEDIN_URL_PATTERN =
  /\b(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/[^\s<>"')]+/giu;
const LINKEDIN_URN_PATTERN = /\burn:li:[A-Za-z0-9_:-]+\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/giu;
const COOKIE_HEADER_PATTERN = /\b(?:Cookie|Set-Cookie):[^\n\r]*/giu;
const AUTH_HEADER_PATTERN = /\bAuthorization:[^\n\r]*/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session(?:[_-]?(?:id|token|key))?|password|passwd|pwd|secret|cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const COMMON_COOKIE_PATTERN =
  /\b(?:li_at|JSESSIONID|sessionid|session_id|sid)=([^\s;]+)/giu;
const LINKEDIN_MEMBER_ID_PATTERN =
  /\b(?:member[_-]?id|memberId|fs_miniProfile|miniProfileUrn)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const UNIX_USER_PATH_PATTERN = /\/(?:Users|home)\/[^/\s]+(?:\/[^\s]*)?/gu;
const WINDOWS_USER_PATH_PATTERN =
  /[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)?/gu;
const LONG_SECRET_BLOB_PATTERN = /\b[A-Za-z0-9+/_=-]{50,}\b/gu;
const REPEATED_REDACTION_PATTERN =
  /\[REDACTED\](?:[\s,;:|/\\-]*\[REDACTED\])+/gu;

const FEEDBACK_LABELS: Record<FeedbackType, string[]> = {
  bug: ["bug", "agent-feedback"],
  feature: ["enhancement", "agent-feedback"],
  improvement: ["improvement", "agent-feedback"]
};

export interface FeedbackPaths {
  feedbackRootDir: string;
  pendingDir: string;
  statePath: string;
}

export interface FeedbackTechnicalContext {
  activeProfileName?: string | null;
  cliVersion: string;
  errorStack?: string | null;
  lastInvocationName?: string | null;
  mcpToolName?: string | null;
  nodeVersion: string;
  os: string;
  architecture: string;
  sessionDurationMs: number;
  source: "cli" | "mcp";
}

export interface FeedbackSubmissionInput {
  description: string;
  technicalContext: FeedbackTechnicalContext;
  title: string;
  type: FeedbackType;
}

export interface PendingFeedbackMetadata {
  createdAt: string;
  labels: string[];
  redactionApplied: boolean;
  title: string;
  type: FeedbackType;
}

export interface PendingFeedbackFile {
  body: string;
  filePath: string;
  metadata: PendingFeedbackMetadata;
}

export interface FeedbackSubmissionResult {
  body: string;
  labels: string[];
  pendingFilePath?: string;
  redactionApplied: boolean;
  repository: string;
  status: "saved_pending" | "submitted";
  title: string;
  type: FeedbackType;
  url?: string;
}

export interface PendingFeedbackSubmissionItem {
  filePath: string;
  title: string;
  type: FeedbackType;
  url: string;
}

export interface PendingFeedbackFailureItem {
  error: string;
  filePath: string;
}

export interface SubmitPendingFeedbackResult {
  failureCount: number;
  failures: PendingFeedbackFailureItem[];
  repository: string;
  submittedCount: number;
  submitted: PendingFeedbackSubmissionItem[];
}

export interface FeedbackHintDecision {
  reason?: "error" | "nth_invocation" | "session_first";
  showHint: boolean;
  snapshot: FeedbackStateSnapshot;
}

export interface FeedbackStateSnapshot {
  activeProfileName?: string | null;
  invocationCount: number;
  lastErrorStack?: string | null;
  lastInvocationName?: string | null;
  lastMcpToolName?: string | null;
  sessionDurationMs: number;
  sessionId: string;
  sessionStartedAt: string;
}

export interface RecordFeedbackInvocationInput {
  activeProfileName?: string;
  baseDir?: string;
  error?: unknown;
  invocationName: string;
  mcpToolName?: string;
  now?: Date;
  source: "cli" | "mcp";
}

export interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

export type CommandRunner = (
  command: string,
  args: string[]
) => Promise<CommandResult>;

interface FeedbackStateFile {
  activeProfileName: string | null;
  invocationCount: number;
  lastErrorStack: string | null;
  lastInvocationName: string | null;
  lastMcpToolName: string | null;
  lastSeenAt: string;
  sessionHintShownAt: string | null;
  sessionId: string;
  sessionStartedAt: string;
}

interface NormalizedFeedbackDraft {
  body: string;
  labels: string[];
  redactionApplied: boolean;
  title: string;
  type: FeedbackType;
}

function isFeedbackType(value: string): value is FeedbackType {
  return (FEEDBACK_TYPES as readonly string[]).includes(value);
}

function normalizeFeedbackType(value: string): FeedbackType {
  const normalized = value.trim().toLowerCase();
  if (isFeedbackType(normalized)) {
    return normalized;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `feedback type must be one of: ${FEEDBACK_TYPES.join(", ")}.`
  );
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function resolveFeedbackHintEveryN(): number {
  return parsePositiveInteger(
    process.env[LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV],
    DEFAULT_FEEDBACK_HINT_EVERY_N
  );
}

function resolveFeedbackSessionIdleMs(): number {
  return parseNonNegativeInteger(
    process.env[LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS_ENV],
    DEFAULT_FEEDBACK_SESSION_IDLE_MS
  );
}

export function resolveFeedbackPaths(baseDir?: string): FeedbackPaths {
  const feedbackRootDir =
    typeof baseDir === "string" && baseDir.trim().length > 0
      ? path.join(path.resolve(baseDir), FEEDBACK_ROOT_DIRNAME)
      : path.join(os.homedir(), FEEDBACK_ROOT_DIRNAME);

  return {
    feedbackRootDir,
    pendingDir: path.join(feedbackRootDir, FEEDBACK_PENDING_DIRNAME),
    statePath: path.join(feedbackRootDir, FEEDBACK_STATE_FILENAME)
  };
}

async function ensureFeedbackDirs(baseDir?: string): Promise<FeedbackPaths> {
  const paths = resolveFeedbackPaths(baseDir);
  await mkdir(paths.pendingDir, { recursive: true });
  return paths;
}

function buildTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/gu, "-");
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function redactPattern(value: string, pattern: RegExp): [string, boolean] {
  const redacted = value.replace(pattern, REDACTED_TOKEN);
  return [redacted, redacted !== value];
}

function redactKeyValuePattern(value: string, pattern: RegExp): [string, boolean] {
  const redacted = value.replace(pattern, (match, ...rest: unknown[]) => {
    const offset = rest.at(-2);
    void offset;
    const separatorMatch = match.match(/[:=]/u);
    if (!separatorMatch || separatorMatch.index === undefined) {
      return REDACTED_TOKEN;
    }

    const separatorIndex = separatorMatch.index;
    return `${match.slice(0, separatorIndex + 1)} ${REDACTED_TOKEN}`;
  });
  return [redacted, redacted !== value];
}

export function scrubFeedbackText(value: string): {
  redacted: boolean;
  value: string;
} {
  let current = value;
  let redacted = false;

  const patternReplacements: RegExp[] = [
    AUTH_HEADER_PATTERN,
    COOKIE_HEADER_PATTERN,
    BEARER_TOKEN_PATTERN,
    JWT_PATTERN,
    EMAIL_PATTERN,
    LINKEDIN_URL_PATTERN,
    LINKEDIN_URN_PATTERN,
    COMMON_COOKIE_PATTERN,
    LINKEDIN_MEMBER_ID_PATTERN,
    IPV4_PATTERN,
    UNIX_USER_PATH_PATTERN,
    WINDOWS_USER_PATH_PATTERN,
    LONG_SECRET_BLOB_PATTERN
  ];

  for (const pattern of patternReplacements) {
    const [nextValue, changed] = redactPattern(current, pattern);
    current = nextValue;
    redacted = redacted || changed;
  }

  const [secretRedacted, secretChanged] = redactKeyValuePattern(
    current,
    SECRET_ASSIGNMENT_PATTERN
  );
  current = secretRedacted;
  redacted = redacted || secretChanged;

  current = current.replace(REPEATED_REDACTION_PATTERN, REDACTED_TOKEN);
  current = current.replace(/[ \t]+\n/gu, "\n");
  current = current.replace(/\n{3,}/gu, "\n\n");

  return {
    redacted,
    value: current
  };
}

function scrubOptionalText(
  value: string | null | undefined
): { redacted: boolean; value?: string } {
  const normalized = trimOrUndefined(value);
  if (!normalized) {
    return { redacted: false };
  }

  const scrubbed = scrubFeedbackText(normalized);
  return {
    redacted: scrubbed.redacted,
    value: scrubbed.value
  };
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 17)}\n[TRUNCATED]`;
}

function formatDuration(durationMs: number): string {
  const clampedDurationMs = Math.max(0, Math.floor(durationMs));
  const totalSeconds = Math.floor(clampedDurationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/gu, "\n").trim();
}

function buildTechnicalContextLines(
  context: FeedbackTechnicalContext
): string[] {
  const lines = [
    `- Source: ${context.source}`,
    `- CLI version: ${context.cliVersion}`,
    `- Node.js version: ${context.nodeVersion}`,
    `- OS / architecture: ${context.os} / ${context.architecture}`,
    `- Session duration: ${formatDuration(context.sessionDurationMs)}`
  ];

  const lastInvocationName = trimOrUndefined(context.lastInvocationName ?? undefined);
  if (lastInvocationName) {
    lines.push(`- Last command/tool: ${lastInvocationName}`);
  }

  const mcpToolName = trimOrUndefined(context.mcpToolName ?? undefined);
  if (mcpToolName) {
    lines.push(`- MCP tool name: ${mcpToolName}`);
  }

  const activeProfileName = trimOrUndefined(
    context.activeProfileName ?? undefined
  );
  if (activeProfileName) {
    lines.push(`- Active profile name: ${activeProfileName}`);
  }

  const errorStack = trimOrUndefined(context.errorStack ?? undefined);
  if (errorStack) {
    lines.push("- Error stack trace:");
    lines.push("```text");
    lines.push(errorStack);
    lines.push("```");
  }

  return lines;
}

function buildFeedbackIssueBody(
  description: string,
  context: FeedbackTechnicalContext,
  type: FeedbackType
): string {
  return [
    "## Feedback Type",
    type,
    "",
    "## Description",
    description,
    "",
    "> Some content was automatically redacted for privacy. The reporter can add sanitized context in comments.",
    "",
    "<details>",
    "<summary>Technical context</summary>",
    "",
    ...buildTechnicalContextLines(context),
    "",
    "</details>"
  ].join("\n");
}

function buildFeedbackTitle(title: string): string {
  const normalizedTitle = title.trim();
  const fallbackTitle = normalizedTitle.length > 0
    ? normalizedTitle
    : "Untitled feedback";
  return `[Agent Feedback] ${fallbackTitle}`;
}

function normalizeFeedbackDraft(
  input: FeedbackSubmissionInput
): NormalizedFeedbackDraft {
  const scrubbedTitle = scrubFeedbackText(normalizeWhitespace(input.title));
  const scrubbedDescription = scrubFeedbackText(
    normalizeWhitespace(input.description)
  );
  const scrubbedLastInvocation = scrubOptionalText(
    input.technicalContext.lastInvocationName
  );
  const scrubbedErrorStack = scrubOptionalText(input.technicalContext.errorStack);
  const scrubbedProfileName = scrubOptionalText(
    input.technicalContext.activeProfileName
  );
  const scrubbedMcpToolName = scrubOptionalText(input.technicalContext.mcpToolName);
  const scrubbedCliVersion = scrubFeedbackText(
    normalizeWhitespace(input.technicalContext.cliVersion)
  );
  const scrubbedNodeVersion = scrubFeedbackText(
    normalizeWhitespace(input.technicalContext.nodeVersion)
  );
  const scrubbedOs = scrubFeedbackText(normalizeWhitespace(input.technicalContext.os));
  const scrubbedArchitecture = scrubFeedbackText(
    normalizeWhitespace(input.technicalContext.architecture)
  );

  const redactionApplied =
    scrubbedTitle.redacted ||
    scrubbedDescription.redacted ||
    scrubbedLastInvocation.redacted ||
    scrubbedErrorStack.redacted ||
    scrubbedProfileName.redacted ||
    scrubbedMcpToolName.redacted ||
    scrubbedCliVersion.redacted ||
    scrubbedNodeVersion.redacted ||
    scrubbedOs.redacted ||
    scrubbedArchitecture.redacted;

  const technicalContext: FeedbackTechnicalContext = {
    source: input.technicalContext.source,
    cliVersion: scrubbedCliVersion.value,
    nodeVersion: scrubbedNodeVersion.value,
    os: scrubbedOs.value,
    architecture: scrubbedArchitecture.value,
    sessionDurationMs: Math.max(0, Math.floor(input.technicalContext.sessionDurationMs)),
    ...(scrubbedLastInvocation.value
      ? { lastInvocationName: scrubbedLastInvocation.value }
      : {}),
    ...(scrubbedErrorStack.value
      ? { errorStack: clipText(scrubbedErrorStack.value, MAX_STORED_ERROR_STACK_CHARS) }
      : {}),
    ...(scrubbedProfileName.value
      ? { activeProfileName: scrubbedProfileName.value }
      : {}),
    ...(scrubbedMcpToolName.value
      ? { mcpToolName: scrubbedMcpToolName.value }
      : {})
  };

  return {
    type: input.type,
    title: buildFeedbackTitle(scrubbedTitle.value),
    labels: [...FEEDBACK_LABELS[input.type]],
    redactionApplied,
    body: buildFeedbackIssueBody(
      scrubbedDescription.value,
      technicalContext,
      input.type
    )
  };
}

function serializePendingFeedbackFile(
  metadata: PendingFeedbackMetadata,
  body: string
): string {
  return [
    FEEDBACK_METADATA_HEADER,
    JSON.stringify(metadata),
    FEEDBACK_METADATA_FOOTER,
    "",
    body.trim(),
    ""
  ].join("\n");
}

function parsePendingFeedbackContent(content: string): Omit<PendingFeedbackFile, "filePath"> {
  const trimmed = content.trimStart();
  if (
    !trimmed.startsWith(FEEDBACK_METADATA_HEADER) ||
    !trimmed.includes(FEEDBACK_METADATA_FOOTER)
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Pending feedback file is missing metadata."
    );
  }

  const metadataStart = FEEDBACK_METADATA_HEADER.length;
  const footerIndex = trimmed.indexOf(FEEDBACK_METADATA_FOOTER);
  if (footerIndex < 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Pending feedback file metadata is malformed."
    );
  }

  const metadataJson = trimmed.slice(metadataStart, footerIndex).trim();
  const parsedMetadata = JSON.parse(metadataJson) as Record<string, unknown>;
  const body = trimmed.slice(footerIndex + FEEDBACK_METADATA_FOOTER.length).trim();

  const title = trimOrUndefined(
    typeof parsedMetadata.title === "string" ? parsedMetadata.title : undefined
  );
  const createdAt = trimOrUndefined(
    typeof parsedMetadata.createdAt === "string"
      ? parsedMetadata.createdAt
      : undefined
  );
  const typeValue = typeof parsedMetadata.type === "string"
    ? parsedMetadata.type
    : "";
  const labelsValue = Array.isArray(parsedMetadata.labels)
    ? parsedMetadata.labels.filter((label): label is string => typeof label === "string")
    : [];
  const redactionApplied =
    typeof parsedMetadata.redactionApplied === "boolean"
      ? parsedMetadata.redactionApplied
      : false;

  if (!title || !createdAt || !isFeedbackType(typeValue) || labelsValue.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Pending feedback file metadata is incomplete."
    );
  }

  return {
    body,
    metadata: {
      createdAt,
      labels: labelsValue,
      redactionApplied,
      title,
      type: typeValue
    }
  };
}

async function defaultCommandRunner(
  command: string,
  args: string[]
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stderr,
        stdout
      });
    });
  });
}

async function isGhAuthenticated(
  runner: CommandRunner
): Promise<boolean> {
  try {
    const result = await runner("gh", ["auth", "status"]);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function createGitHubIssue(
  title: string,
  body: string,
  labels: string[],
  repository: string,
  runner: CommandRunner
): Promise<string> {
  const args = [
    "issue",
    "create",
    "--repo",
    repository,
    "--title",
    title,
    "--body",
    body
  ];

  for (const label of labels) {
    args.push("--label", label);
  }

  const result = await runner("gh", args);
  if (result.code !== 0) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "GitHub issue creation failed.",
      {
        stderr: result.stderr.trim(),
        stdout: result.stdout.trim()
      }
    );
  }

  const issueUrl = trimOrUndefined(result.stdout) ?? trimOrUndefined(result.stderr);
  if (!issueUrl) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "GitHub issue creation did not return an issue URL."
    );
  }

  return issueUrl;
}

function buildPendingFeedbackFilePath(
  pendingDir: string,
  type: FeedbackType,
  now: Date
): string {
  return path.join(
    pendingDir,
    `${buildTimestamp(now)}-${type}${FEEDBACK_PENDING_FILE_EXTENSION}`
  );
}

export function formatFeedbackDisplayPath(
  filePath: string,
  baseDir?: string
): string {
  const { feedbackRootDir } = resolveFeedbackPaths(baseDir);
  const relativePath = path.relative(feedbackRootDir, filePath);

  if (
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    return path.join(FEEDBACK_ROOT_DIRNAME, relativePath);
  }

  return filePath;
}

export async function savePendingFeedback(
  input: FeedbackSubmissionInput,
  options: { baseDir?: string; now?: Date; repository?: string } = {}
): Promise<FeedbackSubmissionResult> {
  const draft = normalizeFeedbackDraft(input);
  const now = options.now ?? new Date();
  const paths = await ensureFeedbackDirs(options.baseDir);
  const filePath = buildPendingFeedbackFilePath(paths.pendingDir, draft.type, now);

  const metadata: PendingFeedbackMetadata = {
    createdAt: now.toISOString(),
    labels: draft.labels,
    redactionApplied: draft.redactionApplied,
    title: draft.title,
    type: draft.type
  };

  await writeFile(
    filePath,
    serializePendingFeedbackFile(metadata, draft.body),
    "utf8"
  );

  return {
    body: draft.body,
    labels: draft.labels,
    pendingFilePath: filePath,
    redactionApplied: draft.redactionApplied,
    repository: options.repository ?? FEEDBACK_GITHUB_REPOSITORY,
    status: "saved_pending",
    title: draft.title,
    type: draft.type
  };
}

export async function submitFeedback(
  input: FeedbackSubmissionInput,
  options: {
    baseDir?: string;
    now?: Date;
    repository?: string;
    runner?: CommandRunner;
  } = {}
): Promise<FeedbackSubmissionResult> {
  const repository = options.repository ?? FEEDBACK_GITHUB_REPOSITORY;
  const runner = options.runner ?? defaultCommandRunner;
  const authenticated = await isGhAuthenticated(runner);

  if (!authenticated) {
    return await savePendingFeedback(input, {
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
      ...(options.now ? { now: options.now } : {}),
      repository
    });
  }

  const draft = normalizeFeedbackDraft(input);

  try {
    const url = await createGitHubIssue(
      draft.title,
      draft.body,
      draft.labels,
      repository,
      runner
    );

    return {
      body: draft.body,
      labels: draft.labels,
      redactionApplied: draft.redactionApplied,
      repository,
      status: "submitted",
      title: draft.title,
      type: draft.type,
      url
    };
  } catch {
    return await savePendingFeedback(input, {
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
      ...(options.now ? { now: options.now } : {}),
      repository
    });
  }
}

export async function readPendingFeedbackFile(
  filePath: string
): Promise<PendingFeedbackFile> {
  const content = await readFile(filePath, "utf8");
  return {
    filePath,
    ...parsePendingFeedbackContent(content)
  };
}

export async function listPendingFeedbackFiles(
  baseDir?: string
): Promise<string[]> {
  const paths = resolveFeedbackPaths(baseDir);

  try {
    const entries = await readdir(paths.pendingDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(FEEDBACK_PENDING_FILE_EXTENSION)
      )
      .map((entry) => path.join(paths.pendingDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

export async function submitPendingFeedback(
  options: {
    baseDir?: string;
    repository?: string;
    runner?: CommandRunner;
  } = {}
): Promise<SubmitPendingFeedbackResult> {
  const repository = options.repository ?? FEEDBACK_GITHUB_REPOSITORY;
  const runner = options.runner ?? defaultCommandRunner;
  const pendingFiles = await listPendingFeedbackFiles(options.baseDir);

  if (pendingFiles.length === 0) {
    return {
      failureCount: 0,
      failures: [],
      repository,
      submitted: [],
      submittedCount: 0
    };
  }

  if (!(await isGhAuthenticated(runner))) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "GitHub CLI authentication is required before pending feedback can be submitted. Run `gh auth login` first."
    );
  }
  const submitted: PendingFeedbackSubmissionItem[] = [];
  const failures: PendingFeedbackFailureItem[] = [];

  for (const filePath of pendingFiles) {
    try {
      const pendingFeedback = await readPendingFeedbackFile(filePath);
      const url = await createGitHubIssue(
        pendingFeedback.metadata.title,
        pendingFeedback.body,
        pendingFeedback.metadata.labels,
        repository,
        runner
      );
      await unlink(filePath);
      submitted.push({
        filePath,
        title: pendingFeedback.metadata.title,
        type: pendingFeedback.metadata.type,
        url
      });
    } catch (error) {
      const normalizedError = asLinkedInBuddyError(error);
      failures.push({
        error: normalizedError.message,
        filePath
      });
    }
  }

  return {
    failureCount: failures.length,
    failures,
    repository,
    submitted,
    submittedCount: submitted.length
  };
}

function createInitialFeedbackState(now: Date): FeedbackStateFile {
  const timestamp = now.toISOString();
  return {
    activeProfileName: null,
    invocationCount: 0,
    lastErrorStack: null,
    lastInvocationName: null,
    lastMcpToolName: null,
    lastSeenAt: timestamp,
    sessionHintShownAt: null,
    sessionId: randomUUID(),
    sessionStartedAt: timestamp
  };
}

async function readFeedbackState(baseDir?: string): Promise<FeedbackStateFile> {
  const paths = resolveFeedbackPaths(baseDir);

  try {
    const content = await readFile(paths.statePath, "utf8");
    const parsed = JSON.parse(content) as Partial<FeedbackStateFile>;
    if (
      typeof parsed.sessionId === "string" &&
      typeof parsed.sessionStartedAt === "string" &&
      typeof parsed.lastSeenAt === "string" &&
      typeof parsed.invocationCount === "number"
    ) {
      return {
        activeProfileName:
          typeof parsed.activeProfileName === "string"
            ? parsed.activeProfileName
            : null,
        invocationCount: parsed.invocationCount,
        lastErrorStack:
          typeof parsed.lastErrorStack === "string" ? parsed.lastErrorStack : null,
        lastInvocationName:
          typeof parsed.lastInvocationName === "string"
            ? parsed.lastInvocationName
            : null,
        lastMcpToolName:
          typeof parsed.lastMcpToolName === "string" ? parsed.lastMcpToolName : null,
        lastSeenAt: parsed.lastSeenAt,
        sessionHintShownAt:
          typeof parsed.sessionHintShownAt === "string"
            ? parsed.sessionHintShownAt
            : null,
        sessionId: parsed.sessionId,
        sessionStartedAt: parsed.sessionStartedAt
      };
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return createInitialFeedbackState(new Date());
    }
  }

  return createInitialFeedbackState(new Date());
}

async function writeFeedbackState(
  state: FeedbackStateFile,
  baseDir?: string
): Promise<void> {
  const paths = await ensureFeedbackDirs(baseDir);
  await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function hasSessionExpired(state: FeedbackStateFile, now: Date): boolean {
  const idleMs = resolveFeedbackSessionIdleMs();
  const lastSeenAtMs = Date.parse(state.lastSeenAt);
  if (!Number.isFinite(lastSeenAtMs)) {
    return true;
  }

  return now.getTime() - lastSeenAtMs > idleMs;
}

function buildSnapshot(
  state: FeedbackStateFile,
  now: Date
): FeedbackStateSnapshot {
  const sessionStartedAtMs = Date.parse(state.sessionStartedAt);
  const sessionDurationMs = Number.isFinite(sessionStartedAtMs)
    ? Math.max(0, now.getTime() - sessionStartedAtMs)
    : 0;

  return {
    activeProfileName: state.activeProfileName,
    invocationCount: state.invocationCount,
    lastErrorStack: state.lastErrorStack,
    lastInvocationName: state.lastInvocationName,
    lastMcpToolName: state.lastMcpToolName,
    sessionDurationMs,
    sessionId: state.sessionId,
    sessionStartedAt: state.sessionStartedAt
  };
}

function normalizeInvocationName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "invocation name must not be empty."
    );
  }

  return normalized;
}

function normalizeErrorStack(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const stack = trimOrUndefined(error.stack) ?? trimOrUndefined(error.message);
  if (!stack) {
    return null;
  }

  const scrubbed = scrubFeedbackText(stack);
  return clipText(scrubbed.value, MAX_STORED_ERROR_STACK_CHARS);
}

export async function recordFeedbackInvocation(
  input: RecordFeedbackInvocationInput
): Promise<FeedbackHintDecision> {
  const now = input.now ?? new Date();
  const currentState = await readFeedbackState(input.baseDir);
  const state = hasSessionExpired(currentState, now)
    ? createInitialFeedbackState(now)
    : currentState;

  state.invocationCount += 1;
  state.lastSeenAt = now.toISOString();
  state.lastInvocationName = normalizeInvocationName(input.invocationName);

  const normalizedProfileName = trimOrUndefined(input.activeProfileName);
  state.activeProfileName = normalizedProfileName ?? state.activeProfileName;

  if (input.source === "mcp") {
    state.lastMcpToolName = trimOrUndefined(input.mcpToolName) ?? state.lastInvocationName;
  }

  const normalizedErrorStack = normalizeErrorStack(input.error);
  state.lastErrorStack = normalizedErrorStack ?? null;

  let reason: FeedbackHintDecision["reason"];
  if (normalizedErrorStack) {
    reason = "error";
    state.sessionHintShownAt ??= now.toISOString();
  } else if (!state.sessionHintShownAt) {
    reason = "session_first";
    state.sessionHintShownAt = now.toISOString();
  } else {
    const everyNth = resolveFeedbackHintEveryN();
    if (everyNth > 0 && state.invocationCount % everyNth === 0) {
      reason = "nth_invocation";
    }
  }

  await writeFeedbackState(state, input.baseDir);

  return {
    showHint: typeof reason === "string",
    snapshot: buildSnapshot(state, now),
    ...(reason ? { reason } : {})
  };
}

export async function readFeedbackStateSnapshot(
  options: { baseDir?: string; now?: Date } = {}
): Promise<FeedbackStateSnapshot> {
  const now = options.now ?? new Date();
  const state = await readFeedbackState(options.baseDir);
  return buildSnapshot(state, now);
}

export function buildFeedbackHintMessage(): string {
  return "Found a bug or have an idea? Run `linkedin-buddy feedback` to file it directly.";
}

export function createFeedbackTechnicalContext(input: {
  cliVersion: string;
  architecture?: string;
  mcpToolName?: string | null;
  nodeVersion?: string;
  os?: string;
  snapshot: FeedbackStateSnapshot;
  source: "cli" | "mcp";
}): FeedbackTechnicalContext {
  return {
    architecture: input.architecture ?? os.arch(),
    cliVersion: input.cliVersion,
    nodeVersion: input.nodeVersion ?? process.version,
    os: input.os ?? `${os.platform()} ${os.release()}`,
    sessionDurationMs: input.snapshot.sessionDurationMs,
    source: input.source,
    ...(input.snapshot.activeProfileName !== undefined
      ? { activeProfileName: input.snapshot.activeProfileName }
      : {}),
    ...(input.snapshot.lastErrorStack !== undefined
      ? { errorStack: input.snapshot.lastErrorStack }
      : {}),
    ...(input.snapshot.lastInvocationName !== undefined
      ? { lastInvocationName: input.snapshot.lastInvocationName }
      : {}),
    ...(input.mcpToolName ?? input.snapshot.lastMcpToolName
      ? { mcpToolName: input.mcpToolName ?? input.snapshot.lastMcpToolName }
      : {})
  };
}

export function normalizeFeedbackInputType(value: string): FeedbackType {
  return normalizeFeedbackType(value);
}
