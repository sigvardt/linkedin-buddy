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
  LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
  LINKEDIN_FEED_COMMENT_TOOL,
  LINKEDIN_FEED_LIKE_TOOL,
  LINKEDIN_FEED_LIST_TOOL,
  LINKEDIN_FEED_VIEW_POST_TOOL,
  LINKEDIN_INBOX_GET_THREAD_TOOL,
  LINKEDIN_INBOX_LIST_THREADS_TOOL,
  LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
  LINKEDIN_JOBS_SEARCH_TOOL,
  LINKEDIN_JOBS_VIEW_TOOL,
  LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL,
  LINKEDIN_NOTIFICATIONS_LIST_TOOL,
  LINKEDIN_POST_PREPARE_CREATE_TOOL,
  LINKEDIN_PROFILE_VIEW_TOOL,
  LINKEDIN_SEARCH_TOOL,
  LINKEDIN_SESSION_HEALTH_TOOL,
  LINKEDIN_SESSION_OPEN_LOGIN_TOOL,
  LINKEDIN_SESSION_STATUS_TOOL
} from "../../../../mcp/src/index.js";
import { getCdpUrl, withAssistantHome, withE2EEnvironment } from "./setup.js";

export interface CapturedCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: unknown;
}

export interface MappedMcpResult {
  payload: Record<string, unknown>;
  isError: boolean;
}

export interface PreparedActionResult {
  preparedActionId: string;
  confirmToken: string;
  expiresAtMs?: number;
  preview: Record<string, unknown>;
}

export interface CommandExecutionOptions {
  assistantHome?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export type CliRunner = (argv: string[]) => Promise<void>;
export type McpToolCaller = (
  name: string,
  args: Record<string, unknown>
) => Promise<unknown>;

const DEFAULT_PROFILE_NAME = process.env.LINKEDIN_E2E_PROFILE ?? "default";
const DEFAULT_MESSAGE_TARGET_PATTERN =
  process.env.LINKEDIN_E2E_MESSAGE_TARGET_PATTERN ?? "Simon Miller";
const DEFAULT_CONNECTION_TARGET =
  process.env.LINKEDIN_E2E_CONNECTION_TARGET ?? "realsimonmiller";
const DEFAULT_LIKE_POST_URL = process.env.LINKEDIN_E2E_LIKE_POST_URL;
const DEFAULT_COMMENT_POST_URL = process.env.LINKEDIN_E2E_COMMENT_POST_URL;
const DEFAULT_CONNECTION_CONFIRM_MODE =
  process.env.LINKEDIN_E2E_CONNECTION_CONFIRM_MODE ?? "";
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const TRANSIENT_E2E_ERROR_PATTERN =
  /timed out|timeout|Target closed|Execution context was destroyed|page crashed|browser has been closed|context was closed|ECONNRESET|ECONNREFUSED|EPIPE/i;

function readEnabledFlag(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true";
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

async function captureCommandExecution(
  execute: () => Promise<void>
): Promise<CapturedCommandResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  let exitCode = 0;

  process.stdout.write = createWriteInterceptor(stdoutChunks);
  process.stderr.write = createWriteInterceptor(stderrChunks);
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

export function getDefaultProfileName(): string {
  return DEFAULT_PROFILE_NAME;
}

export function getDefaultConnectionTarget(): string {
  return DEFAULT_CONNECTION_TARGET;
}

export function getDefaultMessageTargetPattern(): RegExp {
  return new RegExp(DEFAULT_MESSAGE_TARGET_PATTERN, "i");
}

export function isOptInEnabled(name: string): boolean {
  return readEnabledFlag(name);
}

export function getConnectionConfirmMode(): string {
  return DEFAULT_CONNECTION_CONFIRM_MODE;
}

export function getOptInLikePostUrl(): string | undefined {
  return DEFAULT_LIKE_POST_URL;
}

export function getOptInCommentPostUrl(): string | undefined {
  return DEFAULT_COMMENT_POST_URL;
}

export async function runCliCommandWith(
  runner: CliRunner,
  args: string[],
  options: CommandExecutionOptions = {}
): Promise<CapturedCommandResult> {
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const retryDelayMs = resolveRetryDelayMs(options.retryDelayMs);
  const timeoutMs = getTimeoutMs(options.timeoutMs);
  let lastResult: CapturedCommandResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const execute = async (): Promise<void> => {
      await runner(["node", "linkedin", "--cdp-url", getCdpUrl(), ...args]);
    };

    const wrappedExecution = async (): Promise<void> => {
      if (options.assistantHome) {
        await withAssistantHome(options.assistantHome, execute);
        return;
      }

      await withE2EEnvironment(execute);
    };

    const result = await captureCommandExecution(() =>
      withOptionalTimeout(
        wrappedExecution(),
        `CLI command ${args.join(" ")}`,
        timeoutMs
      )
    );
    lastResult = result;

    if (!result.error || !shouldRetryTransientError(result.error) || attempt >= maxAttempts) {
      return result;
    }

    await sleep(retryDelayMs);
  }

  return lastResult ?? {
    stdout: "",
    stderr: "",
    exitCode: 1,
    error: new Error("CLI command did not produce a result.")
  };
}

export async function runCliCommand(
  args: string[],
  options: CommandExecutionOptions = {}
): Promise<CapturedCommandResult> {
  return runCliCommandWith(runCli, args, options);
}

export function getLastJsonObject(text: string): Record<string, unknown> {
  const objects = parseJsonObjects(text);
  const lastObject = objects.at(-1);
  if (!lastObject) {
    throw new Error(`No JSON object found in output:\n${text}`);
  }
  return lastObject;
}

export async function callMcpToolWith(
  caller: McpToolCaller,
  name: string,
  args: Record<string, unknown> = {},
  options: CommandExecutionOptions = {}
): Promise<MappedMcpResult> {
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const retryDelayMs = resolveRetryDelayMs(options.retryDelayMs);
  const timeoutMs = getTimeoutMs(options.timeoutMs);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const execute = async (): Promise<unknown> =>
      caller(name, {
        cdpUrl: getCdpUrl(),
        ...args
      });

    const wrappedExecution = async (): Promise<unknown> => {
      if (options.assistantHome) {
        return await withAssistantHome(options.assistantHome, execute);
      }

      return await withE2EEnvironment(execute);
    };

    try {
      const rawResult = await withOptionalTimeout(
        wrappedExecution(),
        `MCP tool ${name}`,
        timeoutMs
      );
      return mapMcpToolResult(name, rawResult);
    } catch (error) {
      lastError = error;
      if (!shouldRetryTransientError(error) || attempt >= maxAttempts) {
        throw error;
      }

      await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

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

export function expectPreparedAction(prepared: PreparedActionResult): void {
  expect(prepared.preparedActionId).toMatch(/^pa_/);
  expect(prepared.confirmToken).toMatch(/^ct_/);
  if (typeof prepared.expiresAtMs === "number") {
    expect(prepared.expiresAtMs).toBeGreaterThan(Date.now());
  }
  expect(prepared.preview).toHaveProperty("summary");
  expect(prepared.preview).toHaveProperty("target");
}

export function expectPreparedOutboundText(
  prepared: PreparedActionResult,
  text: string
): void {
  const outbound = asRecord(prepared.preview.outbound, "prepared.preview.outbound");

  expect(outbound.text).toBe(text);
}

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
  const profileName = input.profileName ?? DEFAULT_PROFILE_NAME;
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

export async function getMessageThread(runtime: CoreRuntime): Promise<{
  thread_id: string;
  title: string;
  thread_url: string;
}> {
  const threads = await runtime.inbox.listThreads({
    limit: 40,
    profileName: DEFAULT_PROFILE_NAME
  });

  const match = threads.find((thread) => getDefaultMessageTargetPattern().test(thread.title));
  if (!match) {
    throw new Error(
      `Could not find inbox thread matching ${DEFAULT_MESSAGE_TARGET_PATTERN}.`
    );
  }

  return {
    thread_id: match.thread_id,
    title: match.title,
    thread_url: match.thread_url
  };
}

export async function getFeedPost(runtime: CoreRuntime): Promise<{
  post_id: string;
  post_url: string;
  author_name: string;
}> {
  const posts = await runtime.feed.viewFeed({
    profileName: DEFAULT_PROFILE_NAME,
    limit: 10
  });

  const post = posts[0];
  if (!post) {
    throw new Error("No feed post was available for E2E coverage.");
  }

  return {
    post_id: post.post_id,
    post_url: post.post_url,
    author_name: post.author_name
  };
}

export async function getJob(runtime: CoreRuntime): Promise<{
  job_id: string;
  title: string;
}> {
  const search = await runtime.jobs.searchJobs({
    profileName: DEFAULT_PROFILE_NAME,
    query: "software engineer",
    location: "Copenhagen",
    limit: 5
  });

  const job = search.results[0];
  if (!job) {
    throw new Error("No LinkedIn job result was available for E2E coverage.");
  }

  return {
    job_id: job.job_id,
    title: job.title
  };
}

export async function getCliCoverageFixtures(runtime: CoreRuntime): Promise<{
  threadId: string;
  postUrl: string;
  jobId: string;
  connectionTarget: string;
}> {
  const thread = await getMessageThread(runtime);
  const post = await getFeedPost(runtime);
  const job = await getJob(runtime);

  return {
    threadId: thread.thread_id,
    postUrl: post.post_url,
    jobId: job.job_id,
    connectionTarget: DEFAULT_CONNECTION_TARGET
  };
}

export const MCP_TOOL_NAMES = {
  sessionStatus: LINKEDIN_SESSION_STATUS_TOOL,
  sessionOpenLogin: LINKEDIN_SESSION_OPEN_LOGIN_TOOL,
  sessionHealth: LINKEDIN_SESSION_HEALTH_TOOL,
  inboxListThreads: LINKEDIN_INBOX_LIST_THREADS_TOOL,
  inboxGetThread: LINKEDIN_INBOX_GET_THREAD_TOOL,
  inboxPrepareReply: LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
  profileView: LINKEDIN_PROFILE_VIEW_TOOL,
  search: LINKEDIN_SEARCH_TOOL,
  connectionsList: LINKEDIN_CONNECTIONS_LIST_TOOL,
  connectionsPending: LINKEDIN_CONNECTIONS_PENDING_TOOL,
  connectionsInvite: LINKEDIN_CONNECTIONS_INVITE_TOOL,
  connectionsAccept: LINKEDIN_CONNECTIONS_ACCEPT_TOOL,
  connectionsWithdraw: LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
  followupsPrepareAfterAccept: LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL,
  feedList: LINKEDIN_FEED_LIST_TOOL,
  feedViewPost: LINKEDIN_FEED_VIEW_POST_TOOL,
  feedLike: LINKEDIN_FEED_LIKE_TOOL,
  feedComment: LINKEDIN_FEED_COMMENT_TOOL,
  postPrepareCreate: LINKEDIN_POST_PREPARE_CREATE_TOOL,
  notificationsList: LINKEDIN_NOTIFICATIONS_LIST_TOOL,
  jobsSearch: LINKEDIN_JOBS_SEARCH_TOOL,
  jobsView: LINKEDIN_JOBS_VIEW_TOOL,
  actionsConfirm: LINKEDIN_ACTIONS_CONFIRM_TOOL
} as const;
