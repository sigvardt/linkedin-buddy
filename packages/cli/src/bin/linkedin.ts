#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import {
  LinkedInAssistantError,
  createCoreRuntime,
  toLinkedInAssistantErrorPayload
} from "@linkedin-assistant/core";

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

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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

async function runStatus(profileName: string): Promise<void> {
  const runtime = createCoreRuntime();

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

async function runLogin(
  profileName: string,
  timeoutMinutes: number
): Promise<void> {
  const runtime = createCoreRuntime();

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

async function runInboxList(input: {
  profileName: string;
  limit: number;
  unreadOnly: boolean;
}): Promise<void> {
  const runtime = createCoreRuntime();

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
}): Promise<void> {
  const runtime = createCoreRuntime();

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
}): Promise<void> {
  const runtime = createCoreRuntime();

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
}): Promise<void> {
  const runtime = createCoreRuntime();

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
}): Promise<void> {
  const runtime = createCoreRuntime();

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
}): Promise<void> {
  const runtime = createCoreRuntime();

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
}): Promise<void> {
  const runtime = createCoreRuntime();

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
}): Promise<void> {
  const runtime = createCoreRuntime();

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

async function runProfileView(input: {
  profileName: string;
  target: string;
}): Promise<void> {
  const runtime = createCoreRuntime();

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
}): Promise<void> {
  const runtime = createCoreRuntime();

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

    console.log(`Preview summary: ${summary}`);
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
    .version("0.1.0");

  program
    .command("status")
    .description("Check whether the persistent LinkedIn profile is authenticated")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (options: { profile: string }) => {
      await runStatus(options.profile);
    });

  program
    .command("login")
    .description("Open LinkedIn login in a persistent Playwright profile")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-t, --timeout-minutes <minutes>",
      "How long to wait for successful login",
      "10"
    )
    .action(
      async (options: { profile: string; timeoutMinutes: string }) => {
        const timeoutMinutes = coercePositiveInt(
          options.timeoutMinutes,
          "timeout-minutes"
        );
        await runLogin(options.profile, timeoutMinutes);
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
        });
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
        });
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
        });
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
        });
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
        });
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
        });
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
      });
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
      });
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
      });
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
        });
      }
    );

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const payload = toLinkedInAssistantErrorPayload(error);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
