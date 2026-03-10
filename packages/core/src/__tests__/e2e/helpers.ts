import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isFixtureReplayEnabled } from "../../fixtureReplay.js";
import type { CoreRuntime } from "../../runtime.js";
import { toLinkedInAssistantErrorPayload } from "../../errors.js";
import { TEST_ECHO_ACTION_TYPE } from "../../twoPhaseCommit.js";
import { runCli } from "../../../../cli/src/bin/linkedin.js";
import { handleToolCall } from "../../../../mcp/src/bin/linkedin-mcp.js";
import { expect } from "vitest";
import {
  LINKEDIN_ACTIONS_CONFIRM_TOOL,
  LINKEDIN_CONNECTIONS_ACCEPT_TOOL,
  LINKEDIN_CONNECTIONS_INVITE_TOOL,
  LINKEDIN_CONNECTIONS_LIST_TOOL,
  LINKEDIN_CONNECTIONS_PENDING_TOOL,
  LINKEDIN_CONNECTIONS_PREPARE_FOLLOW_TOOL,
  LINKEDIN_CONNECTIONS_PREPARE_IGNORE_TOOL,
  LINKEDIN_CONNECTIONS_PREPARE_REMOVE_TOOL,
  LINKEDIN_CONNECTIONS_PREPARE_UNFOLLOW_TOOL,
  LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
  LINKEDIN_FEED_COMMENT_TOOL,
  LINKEDIN_FEED_LIKE_TOOL,
  LINKEDIN_FEED_LIST_TOOL,
  LINKEDIN_FEED_VIEW_POST_TOOL,
  LINKEDIN_INBOX_GET_THREAD_TOOL,
  LINKEDIN_INBOX_LIST_THREADS_TOOL,
  LINKEDIN_INBOX_PREPARE_ADD_RECIPIENTS_TOOL,
  LINKEDIN_INBOX_PREPARE_NEW_THREAD_TOOL,
  LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
  LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL,
  LINKEDIN_JOBS_SEARCH_TOOL,
  LINKEDIN_JOBS_VIEW_TOOL,
  LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL,
  LINKEDIN_NOTIFICATIONS_LIST_TOOL,
  LINKEDIN_POST_PREPARE_CREATE_TOOL,
  LINKEDIN_POST_PREPARE_CREATE_MEDIA_TOOL,
  LINKEDIN_POST_PREPARE_CREATE_POLL_TOOL,
  LINKEDIN_POST_PREPARE_DELETE_TOOL,
  LINKEDIN_POST_PREPARE_EDIT_TOOL,
  LINKEDIN_PROFILE_VIEW_TOOL,
  LINKEDIN_SEARCH_TOOL,
  LINKEDIN_SESSION_HEALTH_TOOL,
  LINKEDIN_SESSION_OPEN_LOGIN_TOOL,
  LINKEDIN_SESSION_STATUS_TOOL
} from "../../../../mcp/src/index.js";
import { getCdpUrl, withAssistantHome, withE2EEnvironment } from "./setup.js";

/** Captured process result from invoking the CLI test surface. */
export interface CapturedCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: unknown;
}

/** Normalized MCP tool result used by the contract assertions. */
export interface MappedMcpResult {
  payload: Record<string, unknown>;
  isError: boolean;
}

/** Minimal prepared-action contract asserted across preview and confirm tests. */
export interface PreparedActionResult {
  preparedActionId: string;
  confirmToken: string;
  expiresAtMs?: number;
  preview: Record<string, unknown>;
}

/** Shared live identifiers captured for the CLI and MCP contract suites. */
export interface CliCoverageFixtures {
  threadId: string;
  postUrl: string;
  jobId: string;
  connectionTarget: string;
}

/** Optional execution controls shared by the CLI and MCP wrapper helpers. */
export interface CommandExecutionOptions {
  assistantHome?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** Test-local adapter used to invoke the CLI entrypoint directly. */
export type CliRunner = (argv: string[]) => Promise<void>;

/** Test-local adapter used to invoke one MCP tool call directly. */
export type McpToolCaller = (
  name: string,
  args: Record<string, unknown>
) => Promise<unknown>;

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_JOB_QUERY = "software engineer";
const DEFAULT_JOB_LOCATION = "Copenhagen";
const E2E_FIXTURE_FORMAT_VERSION = 1;
const TRANSIENT_E2E_ERROR_PATTERN =
  /timed out|timeout|Target closed|Execution context was destroyed|page crashed|browser has been closed|context was closed|ECONNRESET|ECONNREFUSED|EPIPE/i;
const DEFAULT_REPLAY_POST_URL =
  "https://www.linkedin.com/feed/update/urn:li:activity:fixture-post-1/";

/**
 * On-disk JSON contract stored in `LINKEDIN_E2E_FIXTURE_FILE`.
 *
 * These saved discovery targets are distinct from the replay manifest under
 * `test/fixtures/manifest.json`: they only cache a few live identifiers needed
 * by the thin CLI and MCP E2E suites.
 */
interface CliCoverageFixtureFile extends CliCoverageFixtures {
  capturedAt: string;
  format: number;
  profileName: string;
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEnabledFlag(name: string): boolean {
  const value = readTrimmedEnv(name);
  return value === "1" || value === "true";
}

export function isReplayModeEnabled(): boolean {
  return isFixtureReplayEnabled();
}

function getDefaultJobQuery(): string {
  return readTrimmedEnv("LINKEDIN_E2E_JOB_QUERY") ?? DEFAULT_JOB_QUERY;
}

function getDefaultJobLocation(): string {
  return readTrimmedEnv("LINKEDIN_E2E_JOB_LOCATION") ?? DEFAULT_JOB_LOCATION;
}

function getFixtureFilePath(): string | undefined {
  const configuredPath = readTrimmedEnv("LINKEDIN_E2E_FIXTURE_FILE");
  return configuredPath ? path.resolve(configuredPath) : undefined;
}

function coerceChunk(
  chunk: string | Uint8Array,
  encoding?: string | undefined
): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  return Buffer.from(chunk).toString(encoding);
}

function createWriteInterceptor(
  chunks: string[]
): typeof process.stdout.write {
  return ((chunk, encoding, callback) => {
    const resolvedEncoding = typeof encoding === "string" ? encoding : undefined;
    chunks.push(coerceChunk(chunk, resolvedEncoding));

    if (typeof encoding === "function") {
      encoding();
    }
    if (typeof callback === "function") {
      callback();
    }

    return true;
  }) as typeof process.stdout.write;
}

// CLI and MCP E2Es often print progress lines before their final JSON payload.
// Extract every top-level JSON object so tests can reliably assert on the last
// machine-readable result without forcing the command surface to stay silent.
function parseJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate) as unknown;
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
            objects.push(parsed as Record<string, unknown>);
          }
        } catch {
          // Ignore non-JSON brace blocks.
        }
        start = -1;
      }
    }
  }

  return objects;
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function parseCliCoverageFixtures(
  value: unknown,
  sourceLabel: string
): CliCoverageFixtures {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${sourceLabel} must contain a JSON object.`);
  }

  const record = value as Record<string, unknown>;
  const fixtureFormat = record.format;
  if (fixtureFormat !== undefined && fixtureFormat !== E2E_FIXTURE_FORMAT_VERSION) {
    throw new Error(
      `${sourceLabel} uses unsupported format ${String(fixtureFormat)}. ` +
        "Refresh the fixtures to rewrite the file with the current format."
    );
  }

  const capturedProfileName = record.profileName;
  const expectedProfileName = getDefaultProfileName();
  if (
    typeof capturedProfileName === "string" &&
    capturedProfileName.trim().length > 0 &&
    capturedProfileName.trim() !== expectedProfileName
  ) {
    throw new Error(
      `${sourceLabel} was captured for profile ${capturedProfileName.trim()} but the current ` +
        `E2E profile is ${expectedProfileName}. Refresh the fixtures or set LINKEDIN_E2E_PROFILE to match.`
    );
  }

  return {
    threadId: assertNonEmptyString(record.threadId, `${sourceLabel}.threadId`),
    postUrl: assertNonEmptyString(record.postUrl, `${sourceLabel}.postUrl`),
    jobId: assertNonEmptyString(record.jobId, `${sourceLabel}.jobId`),
    connectionTarget: assertNonEmptyString(
      record.connectionTarget,
      `${sourceLabel}.connectionTarget`
    )
  };
}

function readCliCoverageFixturesFromFile(filePath: string): CliCoverageFixtures {
  try {
    const raw = readFileSync(filePath, "utf8");
    return parseCliCoverageFixtures(JSON.parse(raw) as unknown, `Discovery fixture file ${filePath}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not load discovery fixtures from ${filePath}. ${reason} ` +
        "Delete the file or rerun with --refresh-fixtures (LINKEDIN_E2E_REFRESH_FIXTURES=1)."
    );
  }
}

function writeCliCoverageFixturesToFile(
  filePath: string,
  fixtures: CliCoverageFixtures
): void {
  const payload: CliCoverageFixtureFile = {
    format: E2E_FIXTURE_FORMAT_VERSION,
    capturedAt: new Date().toISOString(),
    profileName: getDefaultProfileName(),
    ...fixtures
  };

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}

function summarizeUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveMaxAttempts(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_ATTEMPTS;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer.");
  }

  return value;
}

function resolveRetryDelayMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_RETRY_DELAY_MS;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error("retryDelayMs must be zero or greater.");
  }

  return value;
}

function getTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("timeoutMs must be a positive number.");
  }

  return value;
}

function shouldRetryTransientError(error: unknown): boolean {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : summarizeUnknownValue(error);

  return TRANSIENT_E2E_ERROR_PATTERN.test(message);
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function withOptionalTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number | undefined
): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  return await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

async function withCommandExecutionEnvironment<T>(
  options: CommandExecutionOptions,
  execute: (cdpUrl: string | undefined) => Promise<T>
): Promise<T> {
  const run = () => execute(getCdpUrl());

  if (options.assistantHome) {
    return withAssistantHome(options.assistantHome, run);
  }

  return withE2EEnvironment(run);
}

async function retryTransientExecution<T>(input: {
  execute: () => Promise<T>;
  getRetryError?: (result: T) => unknown;
  maxAttempts: number;
  retryDelayMs: number;
}): Promise<T> {
  let lastError: unknown;
  let lastResult: T | undefined;

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      const result = await input.execute();
      lastResult = result;
      const retryError = input.getRetryError?.(result);

      if (
        retryError === undefined ||
        !shouldRetryTransientError(retryError) ||
        attempt >= input.maxAttempts
      ) {
        return result;
      }

      lastError = retryError;
    } catch (error) {
      lastError = error;
      if (!shouldRetryTransientError(error) || attempt >= input.maxAttempts) {
        throw error;
      }
    }

    await sleep(input.retryDelayMs);
  }

  if (lastResult !== undefined) {
    return lastResult;
  }

  throw lastError ?? new Error("Command did not produce a result.");
}

async function captureCommandExecution(
  execute: () => Promise<void>
): Promise<CapturedCommandResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalExitCode = process.exitCode;
  let exitCode = 0;

  process.stdout.write = createWriteInterceptor(stdoutChunks);
  process.stderr.write = createWriteInterceptor(stderrChunks);
  console.log = (...args: unknown[]) => {
    stdoutChunks.push(`${args.map((value) => summarizeUnknownValue(value)).join(" ")}
`);
  };
  console.error = (...args: unknown[]) => {
    stderrChunks.push(`${args.map((value) => summarizeUnknownValue(value)).join(" ")}
`);
  };
  process.exitCode = 0;

  let error: unknown;

  try {
    await execute();
  } catch (caught) {
    error = caught;
    if ((process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }

    stderrChunks.push(
      `${JSON.stringify(toLinkedInAssistantErrorPayload(caught), null, 2)}\n`
    );
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    exitCode = process.exitCode ?? 0;
    process.exitCode = originalExitCode;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
    ...(error === undefined ? {} : { error })
  };
}

function assertObjectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function parseJsonObjectText(text: string, label: string): Record<string, unknown> {
  try {
    return assertObjectRecord(JSON.parse(text) as unknown, label);
  } catch {
    const objects = parseJsonObjects(text);
    const lastObject = objects.at(-1);
    if (lastObject) {
      return lastObject;
    }

    throw new Error(`${label} did not contain a JSON object: ${text}`);
  }
}

/** Normalizes raw MCP tool output into a payload plus `isError` bit. */
export function mapMcpToolResult(name: string, rawResult: unknown): MappedMcpResult {
  const record = assertObjectRecord(rawResult, `Tool ${name} result`);
  const content = record.content;
  if (!Array.isArray(content)) {
    throw new Error(`Tool ${name} returned invalid content: ${summarizeUnknownValue(content)}`);
  }

  const textItems = content.filter((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }

    const entry = item as Record<string, unknown>;
    return entry.type === "text" && typeof entry.text === "string";
  }) as Array<Record<string, unknown>>;

  const lastText = textItems.at(-1)?.text;
  if (typeof lastText !== "string" || lastText.trim().length === 0) {
    throw new Error(`Tool ${name} returned no text content.`);
  }

  const payload = parseJsonObjectText(lastText, `Tool ${name} payload`);

  return {
    payload,
    isError: record.isError === true
  };
}

/** Returns the logical profile name used by the real-session E2E helpers. */
export function getDefaultProfileName(): string {
  return readTrimmedEnv("LINKEDIN_E2E_PROFILE") ?? "default";
}

/** Returns the default connection target slug used by preview and confirm tests. */
export function getDefaultConnectionTarget(): string {
  return readTrimmedEnv("LINKEDIN_E2E_CONNECTION_TARGET") ?? "realsimonmiller";
}

/** Returns the regex used to discover the approved message thread. */
export function getDefaultMessageTargetPattern(): RegExp {
  return new RegExp(
    readTrimmedEnv("LINKEDIN_E2E_MESSAGE_TARGET_PATTERN") ?? "Simon Miller",
    "i"
  );
}

/** Returns whether an opt-in E2E flag is enabled. */
export function isOptInEnabled(name: string): boolean {
  return isReplayModeEnabled() || readEnabledFlag(name);
}

/** Returns the configured connection confirm mode for real outbound tests. */
export function getConnectionConfirmMode(): string {
  return readTrimmedEnv("LINKEDIN_E2E_CONNECTION_CONFIRM_MODE") ??
    (isReplayModeEnabled() ? "invite" : "");
}

/** Returns the approved post URL used by the real like confirm test. */
export function getOptInLikePostUrl(): string | undefined {
  return readTrimmedEnv("LINKEDIN_E2E_LIKE_POST_URL") ??
    (isReplayModeEnabled() ? DEFAULT_REPLAY_POST_URL : undefined);
}

/** Returns the approved post URL used by the real comment confirm test. */
export function getOptInCommentPostUrl(): string | undefined {
  return readTrimmedEnv("LINKEDIN_E2E_COMMENT_POST_URL") ??
    (isReplayModeEnabled() ? DEFAULT_REPLAY_POST_URL : undefined);
}

/**
 * Invokes the CLI entrypoint, applying optional retries, assistant-home
 * overrides, and timeout handling.
 */
export async function runCliCommandWith(
  runner: CliRunner,
  args: string[],
  options: CommandExecutionOptions = {}
): Promise<CapturedCommandResult> {
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const retryDelayMs = resolveRetryDelayMs(options.retryDelayMs);
  const timeoutMs = getTimeoutMs(options.timeoutMs);

  return retryTransientExecution({
    maxAttempts,
    retryDelayMs,
    execute: () =>
      captureCommandExecution(() =>
        withOptionalTimeout(
          withCommandExecutionEnvironment(options, async (cdpUrl) => {
            await runner([
              "node",
              "linkedin",
              ...(cdpUrl ? ["--cdp-url", cdpUrl] : []),
              ...args
            ]);
          }),
          `CLI command ${args.join(" ")}`,
          timeoutMs
        )
      ),
    getRetryError: (result) => result.error
  });
}

/** Invokes the real CLI entrypoint used by the contract suites. */
export async function runCliCommand(
  args: string[],
  options: CommandExecutionOptions = {}
): Promise<CapturedCommandResult> {
  return runCliCommandWith(runCli, args, options);
}

/** Extracts the last top-level JSON object from mixed CLI or MCP output. */
export function getLastJsonObject(text: string): Record<string, unknown> {
  const objects = parseJsonObjects(text);
  const lastObject = objects.at(-1);
  if (!lastObject) {
    throw new Error(`No JSON object found in output:\n${text}`);
  }
  return lastObject;
}

/**
 * Invokes one MCP tool call with retries, optional assistant-home overrides,
 * and timeout handling.
 */
export async function callMcpToolWith(
  caller: McpToolCaller,
  name: string,
  args: Record<string, unknown> = {},
  options: CommandExecutionOptions = {}
): Promise<MappedMcpResult> {
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const retryDelayMs = resolveRetryDelayMs(options.retryDelayMs);
  const timeoutMs = getTimeoutMs(options.timeoutMs);

  const rawResult = await retryTransientExecution({
    maxAttempts,
    retryDelayMs,
    execute: () =>
      withOptionalTimeout(
        withCommandExecutionEnvironment(options, (cdpUrl) => {
          return caller(name, {
            ...args,
            ...(cdpUrl ? { cdpUrl } : {})
          });
        }),
        `MCP tool ${name}`,
        timeoutMs
      )
  });

  return mapMcpToolResult(name, rawResult);
}

/** Invokes the real MCP tool handler used by the contract suites. */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown> = {},
  options: CommandExecutionOptions = {}
): Promise<MappedMcpResult> {
  return callMcpToolWith(handleToolCall, name, args, options);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

/** Asserts the minimal prepared-action contract returned by preview commands. */
export function expectPreparedAction(prepared: PreparedActionResult): void {
  expect(prepared.preparedActionId).toMatch(/^pa_/);
  expect(prepared.confirmToken).toMatch(/^ct_/);
  if (typeof prepared.expiresAtMs === "number") {
    expect(prepared.expiresAtMs).toBeGreaterThan(Date.now());
  }
  expect(prepared.preview).toHaveProperty("summary");
  expect(prepared.preview).toHaveProperty("target");
}

/** Asserts that a prepared-action preview contains the expected outbound text. */
export function expectPreparedOutboundText(
  prepared: PreparedActionResult,
  text: string
): void {
  const outbound = asRecord(prepared.preview.outbound, "prepared.preview.outbound");

  expect(outbound.text).toBe(text);
}

/** Asserts that a preview contains the expected rate-limit metadata. */
export function expectRateLimitPreview(
  preview: Record<string, unknown>,
  counterKey: string
): void {
  expect(preview).toHaveProperty("rate_limit");

  const rateLimit = asRecord(preview.rate_limit, "prepared.preview.rate_limit");
  expect(rateLimit).toHaveProperty("counter_key", counterKey);
  expect(typeof rateLimit.remaining).toBe("number");
  expect(typeof rateLimit.allowed).toBe("boolean");
}

/** Creates a safe `test.echo` prepared action for generic confirm coverage. */
export function prepareEchoAction(
  runtime: CoreRuntime,
  input: {
    profileName?: string;
    text?: string;
    summary?: string;
  } = {}
): {
  preparedActionId: string;
  confirmToken: string;
  expiresAtMs: number;
  preview: Record<string, unknown>;
} {
  const profileName = input.profileName ?? getDefaultProfileName();
  const text = input.text ?? `echo-${Date.now()}`;
  const target = {
    profile_name: profileName
  } satisfies Record<string, unknown>;

  return runtime.twoPhaseCommit.prepare({
    actionType: TEST_ECHO_ACTION_TYPE,
    target,
    payload: {
      text
    },
    preview: {
      summary: input.summary ?? `Echo action for ${profileName}`,
      target,
      outbound: {
        text
      }
    }
  });
}

/** Discovers the approved inbox thread used by live message coverage. */
export async function getMessageThread(runtime: CoreRuntime): Promise<{
  thread_id: string;
  title: string;
  thread_url: string;
}> {
  const profileName = getDefaultProfileName();
  const threads = await runtime.inbox.listThreads({
    limit: 40,
    profileName
  });

  const match = threads.find((thread) => getDefaultMessageTargetPattern().test(thread.title));
  if (!match) {
    throw new Error(
      `Could not find an inbox thread matching ${getDefaultMessageTargetPattern()} for profile ${profileName}. ` +
        "Adjust LINKEDIN_E2E_MESSAGE_TARGET_PATTERN or reuse a saved fixture file with --fixtures <file>."
    );
  }

  return {
    thread_id: match.thread_id,
    title: match.title,
    thread_url: match.thread_url
  };
}

/** Discovers one feed post suitable for preview-only or approved write tests. */
export async function getFeedPost(runtime: CoreRuntime): Promise<{
  post_id: string;
  post_url: string;
  author_name: string;
}> {
  const posts = await runtime.feed.viewFeed({
    profileName: getDefaultProfileName(),
    limit: 10
  });

  const post = posts[0];
  if (!post) {
    throw new Error(
      "No feed post was available for E2E coverage. Scroll the dedicated browser session to load the feed or refresh the saved fixtures with --refresh-fixtures."
    );
  }

  return {
    post_id: post.post_id,
    post_url: post.post_url,
    author_name: post.author_name
  };
}

/** Discovers one job result used by the CLI and MCP contract suites. */
export async function getJob(runtime: CoreRuntime): Promise<{
  job_id: string;
  title: string;
}> {
  const profileName = getDefaultProfileName();
  const jobQuery = getDefaultJobQuery();
  const jobLocation = getDefaultJobLocation();
  const search = await runtime.jobs.searchJobs({
    profileName,
    query: jobQuery,
    location: jobLocation,
    limit: 5
  });

  const job = search.results[0];
  if (!job) {
    throw new Error(
      `No LinkedIn job result was available for E2E coverage with query ${jobQuery} in ${jobLocation}. ` +
        "Adjust LINKEDIN_E2E_JOB_QUERY / LINKEDIN_E2E_JOB_LOCATION or refresh the saved fixtures."
    );
  }

  return {
    job_id: job.job_id,
    title: job.title
  };
}

async function discoverCliCoverageFixtures(runtime: CoreRuntime): Promise<CliCoverageFixtures> {
  const thread = await getMessageThread(runtime);
  const post = await getFeedPost(runtime);
  const job = await getJob(runtime);

  return {
    threadId: thread.thread_id,
    postUrl: post.post_url,
    jobId: job.job_id,
    connectionTarget: getDefaultConnectionTarget()
  };
}

/**
 * Returns the shared live identifiers for CLI and MCP contract coverage,
 * either by replaying a saved fixture file or by discovering fresh targets.
 */
export async function getCliCoverageFixtures(runtime: CoreRuntime): Promise<CliCoverageFixtures> {
  const fixtureFilePath = getFixtureFilePath();

  if (!fixtureFilePath) {
    return discoverCliCoverageFixtures(runtime);
  }

  if (!readEnabledFlag("LINKEDIN_E2E_REFRESH_FIXTURES") && existsSync(fixtureFilePath)) {
    return readCliCoverageFixturesFromFile(fixtureFilePath);
  }

  const fixtures = await discoverCliCoverageFixtures(runtime);
  writeCliCoverageFixturesToFile(fixtureFilePath, fixtures);
  return fixtures;
}

/** Canonical MCP tool names used by the E2E contract suites. */
export const MCP_TOOL_NAMES = {
  sessionStatus: LINKEDIN_SESSION_STATUS_TOOL,
  sessionOpenLogin: LINKEDIN_SESSION_OPEN_LOGIN_TOOL,
  sessionHealth: LINKEDIN_SESSION_HEALTH_TOOL,
  inboxSearchRecipients: LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL,
  inboxListThreads: LINKEDIN_INBOX_LIST_THREADS_TOOL,
  inboxGetThread: LINKEDIN_INBOX_GET_THREAD_TOOL,
  inboxPrepareReply: LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
  inboxPrepareNewThread: LINKEDIN_INBOX_PREPARE_NEW_THREAD_TOOL,
  inboxPrepareAddRecipients: LINKEDIN_INBOX_PREPARE_ADD_RECIPIENTS_TOOL,
  profileView: LINKEDIN_PROFILE_VIEW_TOOL,
  search: LINKEDIN_SEARCH_TOOL,
  connectionsList: LINKEDIN_CONNECTIONS_LIST_TOOL,
  connectionsPending: LINKEDIN_CONNECTIONS_PENDING_TOOL,
  connectionsInvite: LINKEDIN_CONNECTIONS_INVITE_TOOL,
  connectionsAccept: LINKEDIN_CONNECTIONS_ACCEPT_TOOL,
  connectionsWithdraw: LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
  connectionsPrepareIgnore: LINKEDIN_CONNECTIONS_PREPARE_IGNORE_TOOL,
  connectionsPrepareRemove: LINKEDIN_CONNECTIONS_PREPARE_REMOVE_TOOL,
  connectionsPrepareFollow: LINKEDIN_CONNECTIONS_PREPARE_FOLLOW_TOOL,
  connectionsPrepareUnfollow: LINKEDIN_CONNECTIONS_PREPARE_UNFOLLOW_TOOL,
  followupsPrepareAfterAccept: LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL,
  feedList: LINKEDIN_FEED_LIST_TOOL,
  feedViewPost: LINKEDIN_FEED_VIEW_POST_TOOL,
  feedLike: LINKEDIN_FEED_LIKE_TOOL,
  feedComment: LINKEDIN_FEED_COMMENT_TOOL,
  postPrepareCreate: LINKEDIN_POST_PREPARE_CREATE_TOOL,
  postPrepareCreateMedia: LINKEDIN_POST_PREPARE_CREATE_MEDIA_TOOL,
  postPrepareCreatePoll: LINKEDIN_POST_PREPARE_CREATE_POLL_TOOL,
  postPrepareEdit: LINKEDIN_POST_PREPARE_EDIT_TOOL,
  postPrepareDelete: LINKEDIN_POST_PREPARE_DELETE_TOOL,
  notificationsList: LINKEDIN_NOTIFICATIONS_LIST_TOOL,
  jobsSearch: LINKEDIN_JOBS_SEARCH_TOOL,
  jobsView: LINKEDIN_JOBS_VIEW_TOOL,
  actionsConfirm: LINKEDIN_ACTIONS_CONFIRM_TOOL
} as const;
