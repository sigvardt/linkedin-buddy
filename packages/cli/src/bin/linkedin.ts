#!/usr/bin/env node
import { Command } from "commander";
import { createCoreRuntime } from "@linkedin-assistant/core";

function coercePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
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
    console.log(JSON.stringify({ run_id: runtime.runId, ...status }, null, 2));
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

    console.log(JSON.stringify({ run_id: runtime.runId, ...result }, null, 2));

    if (!result.authenticated) {
      process.exitCode = 1;
    }
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

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
