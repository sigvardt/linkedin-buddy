#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import {
  DEFAULT_FOLLOWUP_SINCE,
  clearRateLimitState,
  isInRateLimitCooldown,
  LINKEDIN_FEED_REACTION_TYPES,
  LINKEDIN_POST_VISIBILITY_TYPES,
  LINKEDIN_SELECTOR_LOCALES,
  LinkedInAssistantError,
  createCoreRuntime,
  normalizeLinkedInFeedReaction,
  normalizeLinkedInPostVisibility,
  resolveFollowupSinceWindow,
  redactStructuredValue,
  resolveConfigPaths,
  resolvePrivacyConfig,
  toLinkedInAssistantErrorPayload,
  type SearchCategory,
  type SelectorAuditReport
} from "@linkedin-assistant/core";
import {
  formatSelectorAuditError,
  formatSelectorAuditReport,
  resolveSelectorAuditOutputMode,
  SelectorAuditProgressReporter
} from "../selectorAuditOutput.js";

const cliPrivacyConfig = resolvePrivacyConfig();
const SELECTOR_AUDIT_DOC_PATH = "docs/selector-audit.md";
const SELECTOR_AUDIT_DOC_REFERENCE =
  `See ${SELECTOR_AUDIT_DOC_PATH} for sample output, configuration, and troubleshooting.`;
let cliSelectorLocale: string | undefined;

function coercePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a positive integer.`
    );
  }
  return parsed;
}

function coerceSearchCategory(value: string): SearchCategory {
  if (value === "people" || value === "companies" || value === "jobs") {
    return value;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    "category must be one of: people, companies, jobs."
  );
}

function coerceProfileName(value: string, label: string = "profile"): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`
    );
  }

  if (normalized === "." || normalized === ".." || /[\\/]/.test(normalized)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not contain path separators or relative path segments.`
    );
  }

  return normalized;
}

function printJson(value: unknown): void {
  console.log(
    JSON.stringify(redactStructuredValue(value, cliPrivacyConfig, "cli"), null, 2)
  );
}

function createRuntime(cdpUrl?: string) {
  if (cdpUrl) {
    process.stderr.write(
      [
        "[linkedin] Warning: --cdp-url attaches to an existing browser session.",
        "This can share cookies/state with other Chrome sessions.",
        "For an isolated tool-only profile, omit --cdp-url."
      ].join(" ")
    );
    process.stderr.write("\n");
  }
  return createCoreRuntime(
    cdpUrl
      ? {
          cdpUrl,
          privacy: cliPrivacyConfig,
          ...(cliSelectorLocale ? { selectorLocale: cliSelectorLocale } : {})
        }
      : {
          privacy: cliPrivacyConfig,
          ...(cliSelectorLocale ? { selectorLocale: cliSelectorLocale } : {})
        }
  );
}

interface KeepAliveState {
  pid: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  status: "starting" | "running" | "degraded" | "stopped";
  intervalMs: number;
  jitterMs: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  lastTickAt?: string;
  lastHealthyAt?: string;
  authenticated?: boolean;
  browserHealthy?: boolean;
  currentUrl?: string;
  reason?: string;
  lastError?: string;
  cdpUrl?: string;
  stoppedAt?: string;
}

interface KeepAliveFiles {
  dir: string;
  pidPath: string;
  statePath: string;
  logPath: string;
}

function profileSlug(profileName: string): string {
  return profileName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getKeepAliveFiles(profileName: string): KeepAliveFiles {
  const baseDir = resolveConfigPaths().baseDir;
  const slug = profileSlug(profileName);
  const dir = path.join(baseDir, "keepalive");
  return {
    dir,
    pidPath: path.join(dir, `${slug}.pid`),
    statePath: path.join(dir, `${slug}.state.json`),
    logPath: path.join(dir, `${slug}.events.jsonl`)
  };
}

async function ensureKeepAliveDir(files: KeepAliveFiles): Promise<void> {
  await mkdir(files.dir, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readKeepAlivePid(profileName: string): Promise<number | null> {
  const files = getKeepAliveFiles(profileName);
  try {
    const raw = await readFile(files.pidPath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function writeKeepAlivePid(profileName: string, pid: number): Promise<void> {
  const files = getKeepAliveFiles(profileName);
  await ensureKeepAliveDir(files);
  await writeFile(files.pidPath, `${pid}\n`, "utf8");
}

async function removeKeepAlivePid(profileName: string): Promise<void> {
  const files = getKeepAliveFiles(profileName);
  try {
    await unlink(files.pidPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

async function readKeepAliveState(
  profileName: string
): Promise<KeepAliveState | null> {
  const files = getKeepAliveFiles(profileName);
  return readJsonFile<KeepAliveState>(files.statePath);
}

async function writeKeepAliveState(
  profileName: string,
  state: KeepAliveState
): Promise<void> {
  const files = getKeepAliveFiles(profileName);
  await ensureKeepAliveDir(files);
  await writeJsonFile(files.statePath, state);
}

async function appendKeepAliveEvent(
  profileName: string,
  event: Record<string, unknown>
): Promise<void> {
  const files = getKeepAliveFiles(profileName);
  await ensureKeepAliveDir(files);
  await appendFile(files.logPath, `${JSON.stringify(event)}\n`, "utf8");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "EPERM") {
        return true;
      }
      if (error.code === "ESRCH") {
        return false;
      }
    }
    return false;
  }
}

function isProfileLockHeldError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /lock file is already being held/i.test(error.message)
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function promptYesNo(question: string): Promise<boolean> {
  const readline = createInterface({
    input: stdin,
    output: stdout
  });

  try {
    const response = await readline.question(`${question} Type "yes" to confirm: `);
    return response.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}

async function runStatus(profileName: string, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.status.start", { profileName });
    const status = await runtime.auth.status({ profileName });
    runtime.logger.log("info", "cli.status.done", {
      profileName,
      authenticated: status.authenticated
    });
    printJson({ run_id: runtime.runId, ...status });
  } finally {
    runtime.close();
  }
}

async function runRateLimitStatus(clear: boolean): Promise<void> {
  if (clear) {
    await clearRateLimitState();
    printJson({
      cleared: true
    });
    return;
  }

  const status = await isInRateLimitCooldown();
  printJson(status);
}

async function runKeepAliveStart(input: {
  profileName: string;
  intervalSeconds: number;
  jitterSeconds: number;
  maxConsecutiveFailures: number;
}, cdpUrl?: string): Promise<void> {
  const existingPid = await readKeepAlivePid(input.profileName);
  if (existingPid && isProcessRunning(existingPid)) {
    const currentState = await readKeepAliveState(input.profileName);
    printJson({
      started: false,
      reason: "Keepalive daemon is already running for this profile.",
      profile_name: input.profileName,
      pid: existingPid,
      state: currentState
    });
    return;
  }

  if (existingPid && !isProcessRunning(existingPid)) {
    await removeKeepAlivePid(input.profileName);
  }

  const cliEntrypoint = process.argv[1];
  if (!cliEntrypoint) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "Could not resolve CLI entrypoint for keepalive daemon startup."
    );
  }

  const daemonArgs = [cliEntrypoint];
  if (cdpUrl) {
    daemonArgs.push("--cdp-url", cdpUrl);
  }
  if (cliSelectorLocale) {
    daemonArgs.push("--selector-locale", cliSelectorLocale);
  }
  daemonArgs.push(
    "keepalive",
    "__run",
    "--profile",
    input.profileName,
    "--interval-seconds",
    String(input.intervalSeconds),
    "--jitter-seconds",
    String(input.jitterSeconds),
    "--max-consecutive-failures",
    String(input.maxConsecutiveFailures)
  );

  const daemon = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  daemon.unref();

  if (!daemon.pid) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "Keepalive daemon did not return a process id."
    );
  }

  const now = new Date().toISOString();
  const initialState: KeepAliveState = {
    pid: daemon.pid,
    profileName: input.profileName,
    startedAt: now,
    updatedAt: now,
    status: "starting",
    intervalMs: input.intervalSeconds * 1_000,
    jitterMs: input.jitterSeconds * 1_000,
    maxConsecutiveFailures: input.maxConsecutiveFailures,
    consecutiveFailures: 0,
    ...(cdpUrl ? { cdpUrl } : {})
  };

  await writeKeepAlivePid(input.profileName, daemon.pid);
  await writeKeepAliveState(input.profileName, initialState);

  printJson({
    started: true,
    profile_name: input.profileName,
    pid: daemon.pid,
    state_path: getKeepAliveFiles(input.profileName).statePath
  });
}

async function runKeepAliveStatus(profileName: string): Promise<void> {
  const pid = await readKeepAlivePid(profileName);
  const state = await readKeepAliveState(profileName);
  const running = typeof pid === "number" ? isProcessRunning(pid) : false;

  printJson({
    profile_name: profileName,
    running,
    pid,
    state,
    stale_pid_file: Boolean(pid && !running)
  });
}

async function runKeepAliveStop(profileName: string): Promise<void> {
  const pid = await readKeepAlivePid(profileName);
  const previousState = await readKeepAliveState(profileName);

  if (!pid) {
    printJson({
      stopped: false,
      profile_name: profileName,
      reason: "No keepalive daemon pid file found."
    });
    return;
  }

  if (!isProcessRunning(pid)) {
    await removeKeepAlivePid(profileName);
    const now = new Date().toISOString();
    if (previousState) {
      await writeKeepAliveState(profileName, {
        ...previousState,
        status: "stopped",
        updatedAt: now,
        stoppedAt: now,
        lastError: "Recovered from stale pid file."
      });
    }
    printJson({
      stopped: true,
      profile_name: profileName,
      pid,
      reason: "Recovered stale keepalive pid file."
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "Failed to send SIGTERM to keepalive daemon.",
      {
        profile_name: profileName,
        pid,
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }

  const deadline = Date.now() + 5_000;
  let running = true;
  while (Date.now() < deadline) {
    await sleep(200);
    running = isProcessRunning(pid);
    if (!running) {
      break;
    }
  }

  if (running) {
    process.kill(pid, "SIGKILL");
  }

  await removeKeepAlivePid(profileName);
  const now = new Date().toISOString();
  if (previousState) {
    await writeKeepAliveState(profileName, {
      ...previousState,
      status: "stopped",
      updatedAt: now,
      stoppedAt: now,
      ...(running
        ? { lastError: "Keepalive daemon required SIGKILL to stop." }
        : {})
    });
  }

  printJson({
    stopped: true,
    profile_name: profileName,
    pid,
    forced: running
  });
}

async function runKeepAliveDaemon(input: {
  profileName: string;
  intervalSeconds: number;
  jitterSeconds: number;
  maxConsecutiveFailures: number;
}, cdpUrl?: string): Promise<void> {
  const runtime = createCoreRuntime(
    cdpUrl
      ? {
          cdpUrl,
          ...(cliSelectorLocale ? { selectorLocale: cliSelectorLocale } : {})
        }
      : {
          ...(cliSelectorLocale ? { selectorLocale: cliSelectorLocale } : {})
        }
  );
  const profileName = input.profileName;
  let stopRequested = false;
  let consecutiveFailures = 0;

  const requestStop = () => {
    stopRequested = true;
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  const initialState: KeepAliveState = {
    pid: process.pid,
    profileName,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    intervalMs: input.intervalSeconds * 1_000,
    jitterMs: input.jitterSeconds * 1_000,
    maxConsecutiveFailures: input.maxConsecutiveFailures,
    consecutiveFailures: 0,
    ...(cdpUrl ? { cdpUrl } : {})
  };

  await writeKeepAlivePid(profileName, process.pid);
  await writeKeepAliveState(profileName, initialState);
  await appendKeepAliveEvent(profileName, {
    ts: new Date().toISOString(),
    event: "keepalive.daemon.started",
    pid: process.pid,
    profile_name: profileName,
    cdp_url: cdpUrl ?? null
  });

  try {
    while (!stopRequested) {
      const tickAt = new Date().toISOString();

      try {
        const health = await runtime.healthCheck({ profileName });
        const healthy = health.browser.healthy && health.session.authenticated;
        consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;

        const priorState = (await readKeepAliveState(profileName)) ?? initialState;
        const nextState: KeepAliveState = {
          ...priorState,
          pid: process.pid,
          profileName,
          updatedAt: tickAt,
          status:
            consecutiveFailures >= input.maxConsecutiveFailures
              ? "degraded"
              : "running",
          intervalMs: input.intervalSeconds * 1_000,
          jitterMs: input.jitterSeconds * 1_000,
          maxConsecutiveFailures: input.maxConsecutiveFailures,
          consecutiveFailures,
          lastTickAt: tickAt,
          authenticated: health.session.authenticated,
          browserHealthy: health.browser.healthy,
          currentUrl: health.session.currentUrl,
          reason: health.session.reason
        };
        if (healthy) {
          nextState.lastHealthyAt = tickAt;
          delete nextState.lastError;
        }

        await writeKeepAliveState(profileName, nextState);
        await appendKeepAliveEvent(profileName, {
          ts: tickAt,
          event: "keepalive.tick",
          profile_name: profileName,
          healthy,
          consecutive_failures: consecutiveFailures,
          browser_healthy: health.browser.healthy,
          authenticated: health.session.authenticated,
          reason: health.session.reason
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lockHeld = isProfileLockHeldError(error);
        if (!lockHeld) {
          consecutiveFailures += 1;
        }

        const nextState: KeepAliveState = {
          ...(await readKeepAliveState(profileName) ?? initialState),
          pid: process.pid,
          profileName,
          updatedAt: tickAt,
          status:
            consecutiveFailures >= input.maxConsecutiveFailures
              ? "degraded"
              : "running",
          intervalMs: input.intervalSeconds * 1_000,
          jitterMs: input.jitterSeconds * 1_000,
          maxConsecutiveFailures: input.maxConsecutiveFailures,
          consecutiveFailures,
          lastTickAt: tickAt,
          lastError: message
        };
        await writeKeepAliveState(profileName, nextState);
        await appendKeepAliveEvent(profileName, {
          ts: tickAt,
          event: lockHeld ? "keepalive.tick.skipped" : "keepalive.tick.error",
          profile_name: profileName,
          consecutive_failures: consecutiveFailures,
          error: message,
          ...(lockHeld ? { reason: "profile_lock_held" } : {})
        });
      }

      if (stopRequested) {
        break;
      }

      const jitter = (Math.random() * 2 - 1) * (input.jitterSeconds * 1_000);
      let sleepRemainingMs = Math.max(
        1_000,
        input.intervalSeconds * 1_000 + jitter
      );
      while (!stopRequested && sleepRemainingMs > 0) {
        const chunkMs = Math.min(500, sleepRemainingMs);
        await sleep(chunkMs);
        sleepRemainingMs -= chunkMs;
      }
    }
  } finally {
    const now = new Date().toISOString();
    const lastState = (await readKeepAliveState(profileName)) ?? initialState;
    await writeKeepAliveState(profileName, {
      ...lastState,
      pid: process.pid,
      profileName,
      status: "stopped",
      updatedAt: now,
      stoppedAt: now
    });
    await appendKeepAliveEvent(profileName, {
      ts: now,
      event: "keepalive.daemon.stopped",
      pid: process.pid,
      profile_name: profileName
    });

    await removeKeepAlivePid(profileName).catch(() => undefined);
    runtime.close();
  }
}

async function runLogin(
  profileName: string,
  timeoutMinutes: number,
  cdpUrl?: string
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.login.start", {
      profileName,
      timeoutMinutes
    });

    const result = await runtime.auth.openLogin({
      profileName,
      timeoutMs: timeoutMinutes * 60_000
    });

    runtime.logger.log("info", "cli.login.done", {
      profileName,
      authenticated: result.authenticated,
      timedOut: result.timedOut
    });

    printJson({ run_id: runtime.runId, ...result });

    if (!result.authenticated) {
      process.exitCode = 1;
    }
  } finally {
    runtime.close();
  }
}

async function runHeadlessLogin(input: {
  profileName: string;
  email: string;
  password: string;
  mfaCode?: string;
  mfaCallback?: () => Promise<string | undefined>;
  timeoutMinutes: number;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.login.headless.start", {
      profileName: input.profileName,
      email: input.email
    });

    const result = await runtime.auth.headlessLogin({
      profileName: input.profileName,
      email: input.email,
      password: input.password,
      ...(typeof input.mfaCode === "string" ? { mfaCode: input.mfaCode } : {}),
      ...(input.mfaCallback ? { mfaCallback: input.mfaCallback } : {}),
      timeoutMs: input.timeoutMinutes * 60_000
    });

    runtime.logger.log("info", "cli.login.headless.done", {
      profileName: input.profileName,
      authenticated: result.authenticated,
      timedOut: result.timedOut,
      checkpoint: result.checkpoint,
      checkpointType: result.checkpointType,
      mfaRequired: result.mfaRequired
    });

    printJson({ run_id: runtime.runId, ...result });

    if (!result.authenticated) {
      process.exitCode = 1;
    }
  } finally {
    runtime.close();
  }
}

async function runInboxList(input: {
  profileName: string;
  limit: number;
  unreadOnly: boolean;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.list.start", {
      profileName: input.profileName,
      limit: input.limit,
      unreadOnly: input.unreadOnly
    });

    const threads = await runtime.inbox.listThreads({
      profileName: input.profileName,
      limit: input.limit,
      unreadOnly: input.unreadOnly
    });

    runtime.logger.log("info", "cli.inbox.list.done", {
      profileName: input.profileName,
      count: threads.length
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: threads.length,
      threads
    });
  } finally {
    runtime.close();
  }
}

async function runInboxShow(input: {
  profileName: string;
  thread: string;
  limit: number;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.show.start", {
      profileName: input.profileName,
      thread: input.thread,
      limit: input.limit
    });

    const thread = await runtime.inbox.getThread({
      profileName: input.profileName,
      thread: input.thread,
      limit: input.limit
    });

    runtime.logger.log("info", "cli.inbox.show.done", {
      profileName: input.profileName,
      threadId: thread.thread_id
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      thread
    });
  } finally {
    runtime.close();
  }
}

async function runPrepareReply(input: {
  profileName: string;
  thread: string;
  text: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.prepare_reply.start", {
      profileName: input.profileName,
      thread: input.thread
    });

    const prepared = await runtime.inbox.prepareReply({
      profileName: input.profileName,
      thread: input.thread,
      text: input.text
    });

    runtime.logger.log("info", "cli.inbox.prepare_reply.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsList(input: {
  profileName: string;
  limit: number;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.list.start", {
      profileName: input.profileName,
      limit: input.limit
    });

    const connections = await runtime.connections.listConnections({
      profileName: input.profileName,
      limit: input.limit
    });

    runtime.logger.log("info", "cli.connections.list.done", {
      profileName: input.profileName,
      count: connections.length
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: connections.length,
      connections
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsPending(input: {
  profileName: string;
  filter: "sent" | "received" | "all";
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.pending.start", {
      profileName: input.profileName,
      filter: input.filter
    });

    const invitations = await runtime.connections.listPendingInvitations({
      profileName: input.profileName,
      filter: input.filter
    });

    runtime.logger.log("info", "cli.connections.pending.done", {
      profileName: input.profileName,
      count: invitations.length
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      filter: input.filter,
      count: invitations.length,
      invitations
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsInvite(input: {
  profileName: string;
  targetProfile: string;
  note?: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.invite.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile
    });

    const prepared = runtime.connections.prepareSendInvitation({
      profileName: input.profileName,
      targetProfile: input.targetProfile,
      ...(input.note ? { note: input.note } : {})
    });

    runtime.logger.log("info", "cli.connections.invite.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsAccept(input: {
  profileName: string;
  targetProfile: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.accept.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile
    });

    const prepared = runtime.connections.prepareAcceptInvitation({
      profileName: input.profileName,
      targetProfile: input.targetProfile
    });

    runtime.logger.log("info", "cli.connections.accept.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsWithdraw(input: {
  profileName: string;
  targetProfile: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.withdraw.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile
    });

    const prepared = runtime.connections.prepareWithdrawInvitation({
      profileName: input.profileName,
      targetProfile: input.targetProfile
    });

    runtime.logger.log("info", "cli.connections.withdraw.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function runFollowupsList(input: {
  profileName: string;
  since: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const { since, sinceMs } = resolveFollowupSinceWindow(input.since);

  try {
    runtime.logger.log("info", "cli.followups.list.start", {
      profileName: input.profileName,
      since
    });

    const acceptedConnections = await runtime.followups.listAcceptedConnections({
      profileName: input.profileName,
      since
    });

    runtime.logger.log("info", "cli.followups.list.done", {
      profileName: input.profileName,
      count: acceptedConnections.length
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      since,
      since_ms: sinceMs,
      since_at: new Date(sinceMs).toISOString(),
      count: acceptedConnections.length,
      accepted_connections: acceptedConnections
    });
  } finally {
    runtime.close();
  }
}

async function runFollowupsPrepare(input: {
  profileName: string;
  since: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const { since, sinceMs } = resolveFollowupSinceWindow(input.since);

  try {
    runtime.logger.log("info", "cli.followups.prepare.start", {
      profileName: input.profileName,
      since
    });

    const result = await runtime.followups.prepareFollowupsAfterAccept({
      profileName: input.profileName,
      since
    });

    runtime.logger.log("info", "cli.followups.prepare.done", {
      profileName: input.profileName,
      acceptedConnectionCount: result.acceptedConnections.length,
      preparedCount: result.preparedFollowups.length
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      since,
      since_ms: sinceMs,
      since_at: new Date(sinceMs).toISOString(),
      accepted_connection_count: result.acceptedConnections.length,
      prepared_count: result.preparedFollowups.length,
      accepted_connections: result.acceptedConnections,
      prepared_followups: result.preparedFollowups
    });
  } finally {
    runtime.close();
  }
}

async function runFeedList(input: {
  profileName: string;
  limit: number;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.list.start", {
      profileName: input.profileName,
      limit: input.limit
    });

    const posts = await runtime.feed.viewFeed({
      profileName: input.profileName,
      limit: input.limit
    });

    runtime.logger.log("info", "cli.feed.list.done", {
      profileName: input.profileName,
      count: posts.length
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: posts.length,
      posts
    });
  } finally {
    runtime.close();
  }
}

async function runFeedView(input: {
  profileName: string;
  postUrl: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.view.start", {
      profileName: input.profileName,
      postUrl: input.postUrl
    });

    const post = await runtime.feed.viewPost({
      profileName: input.profileName,
      postUrl: input.postUrl
    });

    runtime.logger.log("info", "cli.feed.view.done", {
      profileName: input.profileName,
      postId: post.post_id
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      post
    });
  } finally {
    runtime.close();
  }
}

async function runFeedLike(input: {
  profileName: string;
  postUrl: string;
  reaction?: string;
  operatorNote?: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const reaction = normalizeLinkedInFeedReaction(input.reaction, "like");

  try {
    runtime.logger.log("info", "cli.feed.like.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
      reaction
    });

    const prepared = runtime.feed.prepareLikePost({
      profileName: input.profileName,
      postUrl: input.postUrl,
      reaction,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });

    runtime.logger.log("info", "cli.feed.like.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
      reaction
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function runFeedComment(input: {
  profileName: string;
  postUrl: string;
  text: string;
  operatorNote?: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.comment.start", {
      profileName: input.profileName,
      postUrl: input.postUrl
    });

    const prepared = runtime.feed.prepareCommentOnPost({
      profileName: input.profileName,
      postUrl: input.postUrl,
      text: input.text,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });

    runtime.logger.log("info", "cli.feed.comment.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function runPostPrepare(input: {
  profileName: string;
  text: string;
  visibility?: string;
  operatorNote?: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const visibility = normalizeLinkedInPostVisibility(input.visibility, "public");

  try {
    runtime.logger.log("info", "cli.post.prepare.start", {
      profileName: input.profileName,
      visibility
    });

    const prepared = await runtime.posts.prepareCreate({
      profileName: input.profileName,
      text: input.text,
      visibility,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });

    runtime.logger.log("info", "cli.post.prepare.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
      visibility
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function runProfileView(input: {
  profileName: string;
  target: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.profile.view.start", {
      profileName: input.profileName,
      target: input.target
    });

    const profile = await runtime.profile.viewProfile({
      profileName: input.profileName,
      target: input.target
    });

    runtime.logger.log("info", "cli.profile.view.done", {
      profileName: input.profileName,
      fullName: profile.full_name
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      profile
    });
  } finally {
    runtime.close();
  }
}

async function runSearch(input: {
  profileName: string;
  query: string;
  category?: SearchCategory;
  limit?: number;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    const category = input.category ?? "people";
    const limit = input.limit ?? 10;

    runtime.logger.log("info", "cli.search.start", {
      profileName: input.profileName,
      query: input.query,
      category,
      limit
    });

    const result = await runtime.search.search({
      profileName: input.profileName,
      query: input.query,
      ...(input.category ? { category: input.category } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {})
    });

    runtime.logger.log("info", "cli.search.done", {
      profileName: input.profileName,
      category: result.category,
      count: result.count
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result
    });
  } finally {
    runtime.close();
  }
}

async function runNotificationsList(input: {
  profileName: string;
  limit: number;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.notifications.list.start", {
      profileName: input.profileName,
      limit: input.limit
    });

    const notifications = await runtime.notifications.listNotifications({
      profileName: input.profileName,
      limit: input.limit
    });

    runtime.logger.log("info", "cli.notifications.list.done", {
      profileName: input.profileName,
      count: notifications.length
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: notifications.length,
      notifications
    });
  } finally {
    runtime.close();
  }
}

async function runJobsSearch(input: {
  profileName: string;
  query: string;
  location?: string;
  limit: number;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.search.start", {
      profileName: input.profileName,
      query: input.query,
      location: input.location ?? "",
      limit: input.limit
    });

    const result = await runtime.jobs.searchJobs({
      profileName: input.profileName,
      query: input.query,
      ...(input.location ? { location: input.location } : {}),
      limit: input.limit
    });

    runtime.logger.log("info", "cli.jobs.search.done", {
      profileName: input.profileName,
      count: result.count
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result
    });
  } finally {
    runtime.close();
  }
}

async function runJobsView(input: {
  profileName: string;
  jobId: string;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.view.start", {
      profileName: input.profileName,
      jobId: input.jobId
    });

    const job = await runtime.jobs.viewJob({
      profileName: input.profileName,
      jobId: input.jobId
    });

    runtime.logger.log("info", "cli.jobs.view.done", {
      profileName: input.profileName,
      jobId: job.job_id
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      job
    });
  } finally {
    runtime.close();
  }
}

async function runSelectorAudit(input: {
  profileName: string;
  json: boolean;
  progress: boolean;
  verbose: boolean;
}, cdpUrl?: string): Promise<void> {
  const outputMode = resolveSelectorAuditOutputMode(
    { json: input.json },
    Boolean(stdout.isTTY)
  );
  const progressReporter = new SelectorAuditProgressReporter({
    enabled:
      outputMode === "human" &&
      input.progress &&
      Boolean(process.stderr.isTTY)
  });
  let profileName = input.profileName;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let restoreLogger = () => {};

  try {
    profileName = coerceProfileName(input.profileName);
    runtime = createRuntime(cdpUrl);
    const selectorAuditRuntime = runtime;

    const originalLog = selectorAuditRuntime.logger.log.bind(selectorAuditRuntime.logger);
    // Mirror stable selector-audit lifecycle logs into the optional progress
    // reporter without changing the core service API surface.
    selectorAuditRuntime.logger.log = ((level, event, payload = {}) => {
      const entry = originalLog(level, event, payload);
      progressReporter.handleLog(entry);
      return entry;
    }) as typeof selectorAuditRuntime.logger.log;
    restoreLogger = () => {
      selectorAuditRuntime.logger.log = originalLog;
    };

    selectorAuditRuntime.logger.log("info", "cli.audit.selectors.start", {
      profileName,
      outputMode,
      verbose: input.verbose,
      progress: outputMode === "human" && input.progress
    });

    const report = await selectorAuditRuntime.selectorAudit.auditSelectors({ profileName });

    selectorAuditRuntime.logger.log("info", "cli.audit.selectors.done", {
      profileName,
      totalCount: report.total_count,
      passCount: report.pass_count,
      failCount: report.fail_count,
      fallbackCount: report.fallback_count,
      reportPath: report.report_path
    });

    if (outputMode === "json") {
      printJson(report);
    } else {
      const redactedReport = redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli"
      ) as SelectorAuditReport;

      console.log(
        formatSelectorAuditReport(redactedReport, {
          verbose: input.verbose
        })
      );
    }

    if (report.fail_count > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const errorPayload = toLinkedInAssistantErrorPayload(error, cliPrivacyConfig);

    runtime?.logger.log("error", "cli.audit.selectors.failed", {
      profileName,
      error: errorPayload
    });

    if (outputMode === "json") {
      throw error;
    }

    process.stderr.write(`${formatSelectorAuditError(errorPayload)}\n`);
    process.exitCode = 1;
  } finally {
    restoreLogger();
    runtime?.close();
  }
}

function readTargetProfileName(target: Record<string, unknown>): string | undefined {
  const value = target.profile_name;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

async function runConfirmAction(input: {
  profileName: string;
  token: string;
  yes: boolean;
}, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.actions.confirm.start", {
      profileName: input.profileName
    });

    const preview = runtime.twoPhaseCommit.getPreparedActionPreviewByToken({
      confirmToken: input.token
    });

    const preparedProfileName = readTargetProfileName(preview.target);
    if (preparedProfileName && preparedProfileName !== input.profileName) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Prepared action belongs to profile "${preparedProfileName}", but "${input.profileName}" was requested.`,
        {
          expected_profile_name: preparedProfileName,
          provided_profile_name: input.profileName
        }
      );
    }

    const summary =
      typeof preview.preview.summary === "string"
        ? preview.preview.summary
        : `Action ${preview.actionType}`;
    const summaryPayload = redactStructuredValue(
      { summary },
      cliPrivacyConfig,
      "cli"
    );

    console.log(`Preview summary: ${summaryPayload.summary}`);
    printJson({
      prepared_action_id: preview.preparedActionId,
      action_type: preview.actionType,
      status: preview.status,
      expires_at_ms: preview.expiresAtMs,
      preview: preview.preview
    });

    if (!input.yes) {
      if (!stdin.isTTY || !stdout.isTTY) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          "Refusing to confirm action without --yes in non-interactive mode."
        );
      }

      const confirmed = await promptYesNo("Confirm this action?");
      if (!confirmed) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          "Operator declined action confirmation."
        );
      }
    }

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: input.token
    });

    runtime.logger.log("info", "cli.actions.confirm.done", {
      profileName: input.profileName,
      preparedActionId: result.preparedActionId,
      status: result.status
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result
    });
  } finally {
    runtime.close();
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("linkedin")
    .description("LinkedIn assistant CLI")
    .version("0.1.0")
    .option(
      "--cdp-url <url>",
      "Connect to existing browser via CDP endpoint (e.g., http://127.0.0.1:18800)"
    )
    .option(
      "--selector-locale <locale>",
      `Selector locale for LinkedIn UI text fallbacks (${LINKEDIN_SELECTOR_LOCALES.join(", ")})`
    )
    .addHelpText(
      "after",
      [
        "",
        "Diagnostics:",
        "  linkedin audit selectors --help",
        `  ${SELECTOR_AUDIT_DOC_REFERENCE}`
      ].join("\n")
    );

  const readCdpUrl = (): string | undefined => {
    const options = program.opts<{ cdpUrl?: string }>();
    return typeof options.cdpUrl === "string" && options.cdpUrl.trim().length > 0
      ? options.cdpUrl.trim()
      : undefined;
  };

  const readSelectorLocale = (): string | undefined => {
    const options = program.opts<{ selectorLocale?: string }>();
    return typeof options.selectorLocale === "string" &&
      options.selectorLocale.trim().length > 0
      ? options.selectorLocale.trim()
      : undefined;
  };

  program.hook("preAction", () => {
    cliSelectorLocale = readSelectorLocale();
  });

  program
    .command("status")
    .description("Check whether the persistent LinkedIn profile is authenticated")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (options: { profile: string }) => {
      await runStatus(options.profile, readCdpUrl());
    });

  program
    .command("rate-limit")
    .description("Show or clear persistent auth rate-limit cooldown state")
    .option("--clear", "Clear saved rate-limit cooldown state", false)
    .action(async (options: { clear: boolean }) => {
      await runRateLimitStatus(options.clear);
    });

  const keepAliveCommand = program
    .command("keepalive")
    .description("Run and manage a background session keepalive daemon");

  keepAliveCommand
    .command("start")
    .description("Start keepalive daemon for a profile")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--interval-seconds <seconds>",
      "Health/refresh check interval in seconds",
      "300"
    )
    .option(
      "--jitter-seconds <seconds>",
      "Random +/- jitter per interval in seconds",
      "30"
    )
    .option(
      "--max-consecutive-failures <count>",
      "Mark daemon degraded after this many consecutive failures",
      "5"
    )
    .action(
      async (options: {
        profile: string;
        intervalSeconds: string;
        jitterSeconds: string;
        maxConsecutiveFailures: string;
      }) => {
        await runKeepAliveStart(
          {
            profileName: options.profile,
            intervalSeconds: coercePositiveInt(
              options.intervalSeconds,
              "interval-seconds"
            ),
            jitterSeconds: coercePositiveInt(
              options.jitterSeconds,
              "jitter-seconds"
            ),
            maxConsecutiveFailures: coercePositiveInt(
              options.maxConsecutiveFailures,
              "max-consecutive-failures"
            )
          },
          readCdpUrl()
        );
      }
    );

  keepAliveCommand
    .command("status")
    .description("Show keepalive daemon status for a profile")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (options: { profile: string }) => {
      await runKeepAliveStatus(options.profile);
    });

  keepAliveCommand
    .command("stop")
    .description("Stop keepalive daemon for a profile")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (options: { profile: string }) => {
      await runKeepAliveStop(options.profile);
    });

  keepAliveCommand
    .command("__run", { hidden: true })
    .description("Internal daemon command")
    .requiredOption("-p, --profile <profile>", "Profile name")
    .requiredOption("--interval-seconds <seconds>", "Loop interval in seconds")
    .requiredOption("--jitter-seconds <seconds>", "Interval jitter in seconds")
    .requiredOption(
      "--max-consecutive-failures <count>",
      "Maximum failures before degraded status"
    )
    .action(
      async (options: {
        profile: string;
        intervalSeconds: string;
        jitterSeconds: string;
        maxConsecutiveFailures: string;
      }) => {
        await runKeepAliveDaemon(
          {
            profileName: options.profile,
            intervalSeconds: coercePositiveInt(
              options.intervalSeconds,
              "interval-seconds"
            ),
            jitterSeconds: coercePositiveInt(
              options.jitterSeconds,
              "jitter-seconds"
            ),
            maxConsecutiveFailures: coercePositiveInt(
              options.maxConsecutiveFailures,
              "max-consecutive-failures"
            )
          },
          readCdpUrl()
        );
      }
    );

  program
    .command("login")
    .description("Open LinkedIn login in a persistent Playwright profile")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-t, --timeout-minutes <minutes>",
      "How long to wait for successful login",
      "10"
    )
    .option("--headless", "Authenticate headlessly with email and password", false)
    .option("--email <email>", "LinkedIn email (or set LINKEDIN_EMAIL env var)")
    .option(
      "--password <password>",
      "LinkedIn password (or set LINKEDIN_PASSWORD env var)"
    )
    .option(
      "--mfa-code <code>",
      "MFA verification code (or set LINKEDIN_MFA_CODE env var)"
    )
    .option("--mfa-interactive", "Prompt for MFA code interactively via stdin", false)
    .action(
      async (options: {
        profile: string;
        timeoutMinutes: string;
        headless: boolean;
        email?: string;
        password?: string;
        mfaCode?: string;
        mfaInteractive: boolean;
      }) => {
        const timeoutMinutes = coercePositiveInt(
          options.timeoutMinutes,
          "timeout-minutes"
        );

        if (options.headless) {
          const email = options.email ?? process.env.LINKEDIN_EMAIL;
          const password = options.password ?? process.env.LINKEDIN_PASSWORD;
          const mfaCode = options.mfaCode ?? process.env.LINKEDIN_MFA_CODE;

          let mfaCallback: (() => Promise<string | undefined>) | undefined;
          if (options.mfaInteractive && !mfaCode) {
            mfaCallback = async () => {
              const rl = createInterface({ input: stdin, output: process.stderr });
              try {
                const code = await rl.question("LinkedIn verification code: ");
                return code.trim() || undefined;
              } finally {
                rl.close();
              }
            };
          }

          if (!email) {
            throw new LinkedInAssistantError(
              "ACTION_PRECONDITION_FAILED",
              "Headless login requires --email or LINKEDIN_EMAIL environment variable."
            );
          }

          if (!password) {
            throw new LinkedInAssistantError(
              "ACTION_PRECONDITION_FAILED",
              "Headless login requires --password or LINKEDIN_PASSWORD environment variable."
            );
          }

          await runHeadlessLogin(
            {
              profileName: options.profile,
              email,
              password,
              ...(typeof mfaCode === "string" ? { mfaCode } : {}),
              ...(mfaCallback ? { mfaCallback } : {}),
              timeoutMinutes
            },
            readCdpUrl()
          );
        } else {
          await runLogin(options.profile, timeoutMinutes, readCdpUrl());
        }
      }
    );

  program
    .command("search")
    .description("Search LinkedIn")
    .argument("<query>", "Search keywords")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-c, --category <category>",
      "Search category: people, companies, or jobs",
      "people"
    )
    .option("-l, --limit <limit>", "Max results", "10")
    .action(
      async (
        query: string,
        options: { profile: string; category: string; limit: string }
      ) => {
        await runSearch({
          profileName: options.profile,
          query,
          category: coerceSearchCategory(options.category),
          limit: coercePositiveInt(options.limit, "limit")
        }, readCdpUrl());
      }
    );

  const inboxCommand = program
    .command("inbox")
    .description("List and inspect LinkedIn inbox threads");

  inboxCommand
    .command("list")
    .description("List inbox threads")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-u, --unread", "Only show unread threads", false)
    .option("-l, --limit <limit>", "Max threads", "20")
    .action(
      async (options: { profile: string; unread: boolean; limit: string }) => {
        await runInboxList({
          profileName: options.profile,
          unreadOnly: options.unread,
          limit: coercePositiveInt(options.limit, "limit")
        }, readCdpUrl());
      }
    );

  inboxCommand
    .command("show")
    .description("Show details for one inbox thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max messages to return", "20")
    .action(
      async (options: { profile: string; thread: string; limit: string }) => {
        await runInboxShow({
          profileName: options.profile,
          thread: options.thread,
          limit: coercePositiveInt(options.limit, "limit")
        }, readCdpUrl());
      }
    );

  inboxCommand
    .command("prepare-reply")
    .description("Prepare a two-phase send_message action for a thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .requiredOption("--text <text>", "Message text")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (options: { profile: string; thread: string; text: string }) => {
        await runPrepareReply({
          profileName: options.profile,
          thread: options.thread,
          text: options.text
        }, readCdpUrl());
      }
    );

  const connectionsCommand = program
    .command("connections")
    .description("Manage LinkedIn connections");

  connectionsCommand
    .command("list")
    .description("List your LinkedIn connections")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max connections to return", "40")
    .action(
      async (options: { profile: string; limit: string }) => {
        await runConnectionsList({
          profileName: options.profile,
          limit: coercePositiveInt(options.limit, "limit")
        }, readCdpUrl());
      }
    );

  connectionsCommand
    .command("pending")
    .description("List pending connection invitations")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-f, --filter <filter>",
      "Filter: sent, received, or all",
      "all"
    )
    .action(
      async (options: { profile: string; filter: string }) => {
        const filter = options.filter as "sent" | "received" | "all";
        if (!["sent", "received", "all"].includes(filter)) {
          throw new LinkedInAssistantError(
            "ACTION_PRECONDITION_FAILED",
            "Filter must be 'sent', 'received', or 'all'."
          );
        }
        await runConnectionsPending({
          profileName: options.profile,
          filter
        }, readCdpUrl());
      }
    );

  connectionsCommand
    .command("invite")
    .description("Prepare a connection invitation (two-phase)")
    .argument("<target>", "Vanity name or profile URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-n, --note <note>", "Optional invitation note")
    .action(
      async (target: string, options: { profile: string; note?: string }) => {
        await runConnectionsInvite({
          profileName: options.profile,
          targetProfile: target,
          ...(options.note ? { note: options.note } : {})
        }, readCdpUrl());
      }
    );

  connectionsCommand
    .command("accept")
    .description("Prepare to accept a connection invitation (two-phase)")
    .argument("<target>", "Vanity name or profile URL of the sender")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runConnectionsAccept({
        profileName: options.profile,
        targetProfile: target
      }, readCdpUrl());
    });

  connectionsCommand
    .command("withdraw")
    .description("Prepare to withdraw a sent invitation (two-phase)")
    .argument("<target>", "Vanity name or profile URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runConnectionsWithdraw({
        profileName: options.profile,
        targetProfile: target
      }, readCdpUrl());
    });

  const followupsCommand = program
    .command("followups")
    .description("Detect accepted invitations and prepare follow-up messages");

  followupsCommand
    .command("list")
    .description("List recently accepted connections detected from sent invites")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-s, --since <window>",
      "Lookback window such as 30m, 12h, 7d, or 2w",
      DEFAULT_FOLLOWUP_SINCE
    )
    .action(async (options: { profile: string; since: string }) => {
      await runFollowupsList({
        profileName: options.profile,
        since: options.since
      }, readCdpUrl());
    });

  followupsCommand
    .command("prepare")
    .description(
      "Prepare follow-up messages for newly accepted connections (two-phase)"
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-s, --since <window>",
      "Lookback window such as 30m, 12h, 7d, or 2w",
      DEFAULT_FOLLOWUP_SINCE
    )
    .action(async (options: { profile: string; since: string }) => {
      await runFollowupsPrepare({
        profileName: options.profile,
        since: options.since
      }, readCdpUrl());
    });

  const feedCommand = program
    .command("feed")
    .description("Browse and prepare actions for LinkedIn feed posts");

  feedCommand
    .command("list")
    .description("List posts from your LinkedIn feed")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max posts to return", "10")
    .action(
      async (options: { profile: string; limit: string }) => {
        await runFeedList({
          profileName: options.profile,
          limit: coercePositiveInt(options.limit, "limit")
        }, readCdpUrl());
      }
    );

  feedCommand
    .command("view")
    .description("View details for one LinkedIn feed post")
    .argument("<post>", "Post URL, URN, or activity id")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (post: string, options: { profile: string }) => {
      await runFeedView({
        profileName: options.profile,
        postUrl: post
      }, readCdpUrl());
    });

  feedCommand
    .command("like")
    .alias("react")
    .description("Prepare to react to a LinkedIn post (two-phase)")
    .argument("<post>", "Post URL, URN, or activity id")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-r, --reaction <reaction>",
      `Reaction type (${LINKEDIN_FEED_REACTION_TYPES.join(", ")})`,
      "like"
    )
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; reaction: string; operatorNote?: string }
      ) => {
        await runFeedLike({
          profileName: options.profile,
          postUrl: post,
          reaction: options.reaction,
          ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
        }, readCdpUrl());
      }
    );

  feedCommand
    .command("comment")
    .description("Prepare to comment on a LinkedIn post (two-phase)")
    .argument("<post>", "Post URL, URN, or activity id")
    .requiredOption("--text <text>", "Comment text")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; text: string; operatorNote?: string }
      ) => {
        await runFeedComment({
          profileName: options.profile,
          postUrl: post,
          text: options.text,
          ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
        }, readCdpUrl());
      }
    );

  const postCommand = program
    .command("post")
    .description("Prepare and confirm LinkedIn post creation");

  postCommand
    .command("prepare")
    .description("Prepare a new LinkedIn post (two-phase)")
    .requiredOption("--text <text>", "Post text")
    .option(
      "-v, --visibility <visibility>",
      `Visibility (${LINKEDIN_POST_VISIBILITY_TYPES.join(", ")})`,
      "public"
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (options: {
        profile: string;
        text: string;
        visibility: string;
        operatorNote?: string;
      }) => {
        await runPostPrepare({
          profileName: options.profile,
          text: options.text,
          visibility: options.visibility,
          ...(options.operatorNote ? { operatorNote: options.operatorNote } : {})
        }, readCdpUrl());
      }
    );

  postCommand
    .command("confirm")
    .description("Confirm and publish a prepared LinkedIn post by token")
    .requiredOption("--token <token>", "Confirmation token (ct_...)")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-y, --yes", "Skip interactive confirmation prompt", false)
    .action(
      async (options: { profile: string; token: string; yes: boolean }) => {
        await runConfirmAction({
          profileName: options.profile,
          token: options.token,
          yes: options.yes
        }, readCdpUrl());
      }
    );

  const notificationsCommand = program
    .command("notifications")
    .description("Browse LinkedIn notifications");

  notificationsCommand
    .command("list")
    .description("List your LinkedIn notifications")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max notifications to return", "20")
    .action(
      async (options: { profile: string; limit: string }) => {
        await runNotificationsList({
          profileName: options.profile,
          limit: coercePositiveInt(options.limit, "limit")
        }, readCdpUrl());
      }
    );

  const jobsCommand = program
    .command("jobs")
    .description("Search and view LinkedIn job postings");

  jobsCommand
    .command("search")
    .description("Search for LinkedIn jobs")
    .argument("<query>", "Search keywords")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--location <location>", "Location filter")
    .option("-l, --limit <limit>", "Max results", "10")
    .action(
      async (
        query: string,
        options: { profile: string; location?: string; limit: string }
      ) => {
        await runJobsSearch({
          profileName: options.profile,
          query,
          ...(options.location ? { location: options.location } : {}),
          limit: coercePositiveInt(options.limit, "limit")
        }, readCdpUrl());
      }
    );

  jobsCommand
    .command("view")
    .description("View details for a LinkedIn job posting")
    .argument("<jobId>", "LinkedIn job ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (jobId: string, options: { profile: string }) => {
      await runJobsView({
        profileName: options.profile,
        jobId
      }, readCdpUrl());
    });

  const profileCommand = program
    .command("profile")
    .description("View LinkedIn profiles");

  profileCommand
    .command("view")
    .description("View a LinkedIn profile")
    .argument(
      "[target]",
      "Vanity name, profile URL, or 'me' for own profile",
      "me"
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runProfileView({
        profileName: options.profile,
        target
      }, readCdpUrl());
    });

  const auditCommand = program
    .command("audit")
    .description("Run read-only LinkedIn audits and diagnostics");

  auditCommand
    .command("selectors")
    .description("Audit selector groups across key LinkedIn pages and capture failure artifacts")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the full JSON report (recommended for automation)", false)
    .option(
      "--verbose",
      "Show selector-by-selector details in human-readable output",
      false
    )
    .option("--no-progress", "Hide per-page progress updates in human-readable output")
    .addHelpText(
      "after",
      [
        "",
        "Interactive terminals default to a human-readable summary with per-page progress.",
        "Use --json for automation, piping, or other agent workflows.",
        SELECTOR_AUDIT_DOC_REFERENCE
      ].join("\n")
    )
    .action(async (options: {
      profile: string;
      json: boolean;
      progress: boolean;
      verbose: boolean;
    }) => {
      await runSelectorAudit({
        profileName: options.profile,
        json: options.json,
        progress: options.progress,
        verbose: options.verbose
      }, readCdpUrl());
    });

  const actionsCommand = program
    .command("actions")
    .description("Manage prepared actions");

  actionsCommand
    .command("confirm")
    .description("Confirm and execute a prepared action by confirmation token")
    .requiredOption("--token <token>", "Confirmation token (ct_...)")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-y, --yes", "Skip interactive confirmation prompt", false)
    .action(
      async (options: { profile: string; token: string; yes: boolean }) => {
        await runConfirmAction({
          profileName: options.profile,
          token: options.token,
          yes: options.yes
        }, readCdpUrl());
      }
    );

  program
    .command("health")
    .description("Check browser and LinkedIn session health")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (options: { profile: string }) => {
      const runtime = createRuntime(readCdpUrl());
      try {
        const health = await runtime.healthCheck({ profileName: options.profile });
        printJson({ run_id: runtime.runId, ...health });
        if (!health.browser.healthy || !health.session.authenticated) {
          process.exitCode = 1;
        }
      } finally {
        runtime.close();
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const payload = toLinkedInAssistantErrorPayload(error, cliPrivacyConfig);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
