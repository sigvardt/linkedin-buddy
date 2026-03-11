import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { BrowserContext, Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import { LinkedInBuddyError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import type { ActionExecutorResult } from "./twoPhaseCommit.js";

interface TraceArchiveResizeResult {
  originalBytes: number;
  finalBytes: number;
  trimmedToLimit: boolean;
  pruned: boolean;
  keptEntries: string[];
  droppedEntries: string[];
}

export interface ConfirmFailureArtifactRuntime {
  artifacts: ArtifactHelpers;
  logger: Pick<JsonEventLogger, "log">;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface ExecuteConfirmActionWithArtifactsInput<
  TRuntime extends ConfirmFailureArtifactRuntime
> {
  runtime: TRuntime;
  context: BrowserContext;
  page: Page;
  actionId: string;
  actionType: string;
  profileName: string;
  targetUrl?: string | undefined;
  persistTraceOnSuccess?: boolean;
  metadata?: Record<string, unknown> | undefined;
  errorDetails?: Record<string, unknown> | undefined;
  beforeExecute?: (() => void) | undefined;
  mapError: (error: unknown) => LinkedInBuddyError;
  execute: () => Promise<ActionExecutorResult>;
}

function slugifyActionType(actionType: string): string {
  return actionType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "action";
}

function getArtifactPathsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function getArtifactPathsFromError(error: unknown): string[] {
  if (!(error instanceof LinkedInBuddyError)) {
    return [];
  }

  return [
    ...getArtifactPathsFromUnknown(error.details.artifact_paths),
    ...getArtifactPathsFromUnknown(error.details.artifacts)
  ];
}

function dedupeArtifactPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

function attachArtifactPaths(
  error: LinkedInBuddyError,
  artifactPaths: string[],
  extraDetails: Record<string, unknown>
): LinkedInBuddyError {
  const mergedArtifactPaths = dedupeArtifactPaths([
    ...getArtifactPathsFromError(error),
    ...artifactPaths
  ]);

  for (const [key, value] of Object.entries(extraDetails)) {
    if (value === undefined || key in error.details) {
      continue;
    }
    error.details[key] = value;
  }

  error.details.artifact_paths = mergedArtifactPaths;
  error.details.artifacts = mergedArtifactPaths;

  return error;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getPageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

async function captureAccessibilitySnapshot(page: Page): Promise<unknown> {
  const cdpSession = await page.context().newCDPSession(page);
  try {
    return await cdpSession.send("Accessibility.getFullAXTree");
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
}

function buildArtifactPath(
  prefix: string,
  actionType: string,
  extension: string,
  timestampMs: number
): string {
  return `${prefix}-${slugifyActionType(actionType)}-${timestampMs}.${extension}`;
}

function filterTraceEntries(
  entries: Record<string, Uint8Array>,
  predicate: (entryName: string) => boolean
): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(entries).filter(([entryName]) => predicate(entryName))
  );
}

function resizeTraceArchive(
  absoluteTracePath: string,
  maxBytes: number
): TraceArchiveResizeResult {
  const originalBytes = statSync(absoluteTracePath).size;
  if (originalBytes <= maxBytes) {
    return {
      originalBytes,
      finalBytes: originalBytes,
      trimmedToLimit: true,
      pruned: false,
      keptEntries: [],
      droppedEntries: []
    };
  }

  try {
    const archive = unzipSync(readFileSync(absoluteTracePath));
    const entryNames = Object.keys(archive);
    const strategies = [
      (entryName: string) =>
        !entryName.startsWith("resources/") &&
        !entryName.startsWith("src@") &&
        !entryName.startsWith("sources/"),
      (entryName: string) =>
        !entryName.includes("/") || /\.(trace|network|stacks|json)$/i.test(entryName),
      (entryName: string) => /\.(trace|network|stacks)$/i.test(entryName),
      (entryName: string) => /\.(trace|network)$/i.test(entryName),
      (entryName: string) => /\.trace$/i.test(entryName)
    ] as const;

    let smallestArchive: {
      bytes: Uint8Array;
      keptEntries: string[];
    } | null = null;

    for (const strategy of strategies) {
      const reducedEntries = filterTraceEntries(archive, strategy);
      const keptEntries = Object.keys(reducedEntries);
      if (keptEntries.length === 0) {
        continue;
      }

      const reducedArchive = zipSync(reducedEntries, { level: 9 });
      if (smallestArchive === null || reducedArchive.length < smallestArchive.bytes.length) {
        smallestArchive = {
          bytes: reducedArchive,
          keptEntries
        };
      }

      if (reducedArchive.length <= maxBytes) {
        writeFileSync(absoluteTracePath, Buffer.from(reducedArchive));
        return {
          originalBytes,
          finalBytes: reducedArchive.length,
          trimmedToLimit: true,
          pruned: true,
          keptEntries,
          droppedEntries: entryNames.filter((entryName) => !keptEntries.includes(entryName))
        };
      }
    }

    if (smallestArchive !== null && smallestArchive.bytes.length < originalBytes) {
      writeFileSync(absoluteTracePath, Buffer.from(smallestArchive.bytes));
      return {
        originalBytes,
        finalBytes: smallestArchive.bytes.length,
        trimmedToLimit: smallestArchive.bytes.length <= maxBytes,
        pruned: true,
        keptEntries: smallestArchive.keptEntries,
        droppedEntries: entryNames.filter(
          (entryName) => !smallestArchive.keptEntries.includes(entryName)
        )
      };
    }
  } catch {
    // Fall back to the original trace archive when pruning fails.
  }

  return {
    originalBytes,
    finalBytes: originalBytes,
    trimmedToLimit: false,
    pruned: false,
    keptEntries: [],
    droppedEntries: []
  };
}

async function captureScreenshotArtifact(
  runtime: ConfirmFailureArtifactRuntime,
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, fullPage: true });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

async function captureFailureArtifacts(
  input: {
    runtime: ConfirmFailureArtifactRuntime;
    page: Page;
    actionId: string;
    actionType: string;
    profileName: string;
    targetUrl?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    timestampMs: number;
  }
): Promise<string[]> {
  const currentUrl = getPageUrl(input.page);
  const artifactDetails = {
    action: input.actionType,
    action_id: input.actionId,
    action_type: input.actionType,
    profile_name: input.profileName,
    target_url: input.targetUrl,
    current_url: currentUrl,
    capture_stage: "confirm_failure",
    ...input.metadata
  };
  const artifactPaths: string[] = [];
  const attempts = [
    {
      artifactPath: buildArtifactPath(
        "linkedin/screenshot-confirm-error",
        input.actionType,
        "png",
        input.timestampMs
      ),
      capture: async () => {
        await captureScreenshotArtifact(
          input.runtime,
          input.page,
          buildArtifactPath(
            "linkedin/screenshot-confirm-error",
            input.actionType,
            "png",
            input.timestampMs
          ),
          {
            ...artifactDetails,
            artifact_role: "failure_screenshot"
          }
        );
      }
    },
    {
      artifactPath: buildArtifactPath(
        "linkedin/dom-confirm-error",
        input.actionType,
        "html",
        input.timestampMs
      ),
      capture: async () => {
        input.runtime.artifacts.writeText(
          buildArtifactPath(
            "linkedin/dom-confirm-error",
            input.actionType,
            "html",
            input.timestampMs
          ),
          await input.page.content(),
          "text/html",
          {
            ...artifactDetails,
            artifact_role: "failure_dom"
          }
        );
      }
    },
    {
      artifactPath: buildArtifactPath(
        "linkedin/accessibility-confirm-error",
        input.actionType,
        "json",
        input.timestampMs
      ),
      capture: async () => {
        input.runtime.artifacts.writeJson(
          buildArtifactPath(
            "linkedin/accessibility-confirm-error",
            input.actionType,
            "json",
            input.timestampMs
          ),
          await captureAccessibilitySnapshot(input.page),
          {
            ...artifactDetails,
            artifact_role: "failure_accessibility"
          }
        );
      }
    }
  ] as const;

  for (const attempt of attempts) {
    try {
      await attempt.capture();
      artifactPaths.push(attempt.artifactPath);
    } catch (error) {
      input.runtime.logger.log("warn", "confirm.failure_artifact.capture_failed", {
        action_id: input.actionId,
        action_type: input.actionType,
        artifact_path: attempt.artifactPath,
        message: getErrorMessage(error)
      });
    }
  }

  return artifactPaths;
}

async function stopTracingWithPersistence(
  input: {
    runtime: ConfirmFailureArtifactRuntime;
    context: BrowserContext;
    actionId: string;
    actionType: string;
    profileName: string;
    targetUrl?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    timestampMs: number;
  }
): Promise<string[]> {
  const tracePath = buildArtifactPath(
    "linkedin/trace-confirm",
    input.actionType,
    "zip",
    input.timestampMs
  );
  const absoluteTracePath = input.runtime.artifacts.resolve(tracePath);
  mkdirSync(path.dirname(absoluteTracePath), { recursive: true });

  try {
    await input.context.tracing.stop({ path: absoluteTracePath });
  } catch (error) {
    input.runtime.logger.log("warn", "confirm.trace.stop_failed", {
      action_id: input.actionId,
      action_type: input.actionType,
      message: getErrorMessage(error)
    });
    return [];
  }

  const traceResize = resizeTraceArchive(
    absoluteTracePath,
    input.runtime.confirmFailureArtifacts.traceMaxBytes
  );

  if (traceResize.pruned) {
    input.runtime.logger.log("info", "confirm.trace.pruned", {
      action_id: input.actionId,
      action_type: input.actionType,
      original_bytes: traceResize.originalBytes,
      final_bytes: traceResize.finalBytes,
      max_bytes: input.runtime.confirmFailureArtifacts.traceMaxBytes,
      trimmed_to_limit: traceResize.trimmedToLimit
    });
  }

  if (!traceResize.trimmedToLimit) {
    input.runtime.logger.log("warn", "confirm.trace.limit_exceeded", {
      action_id: input.actionId,
      action_type: input.actionType,
      original_bytes: traceResize.originalBytes,
      final_bytes: traceResize.finalBytes,
      max_bytes: input.runtime.confirmFailureArtifacts.traceMaxBytes
    });
  }

  input.runtime.artifacts.registerArtifact(tracePath, "application/zip", {
    action: input.actionType,
    action_id: input.actionId,
    action_type: input.actionType,
    profile_name: input.profileName,
    target_url: input.targetUrl,
    capture_stage: "confirm_trace",
    trace_max_bytes: input.runtime.confirmFailureArtifacts.traceMaxBytes,
    trace_original_bytes: traceResize.originalBytes,
    trace_final_bytes: traceResize.finalBytes,
    trace_pruned: traceResize.pruned,
    trace_trimmed_to_limit: traceResize.trimmedToLimit,
    trace_kept_entries: traceResize.keptEntries,
    trace_dropped_entries: traceResize.droppedEntries,
    ...input.metadata
  });

  return [tracePath];
}

export async function executeConfirmActionWithArtifacts<
  TRuntime extends ConfirmFailureArtifactRuntime
>(
  input: ExecuteConfirmActionWithArtifactsInput<TRuntime>
): Promise<ActionExecutorResult> {
  const timestampMs = Date.now();
  let tracingStarted = false;

  try {
    await input.context.tracing.start({
      screenshots: false,
      snapshots: false,
      sources: false
    });
    tracingStarted = true;
  } catch (error) {
    input.runtime.logger.log("warn", "confirm.trace.start_failed", {
      action_id: input.actionId,
      action_type: input.actionType,
      message: getErrorMessage(error)
    });
  }

  try {
    input.beforeExecute?.();
    const result = await input.execute();
    const artifactPaths = [...result.artifacts];

    if (tracingStarted) {
      if (input.persistTraceOnSuccess) {
        artifactPaths.push(
          ...(
            await stopTracingWithPersistence({
              runtime: input.runtime,
              context: input.context,
              actionId: input.actionId,
              actionType: input.actionType,
              profileName: input.profileName,
              targetUrl: input.targetUrl,
              metadata: input.metadata,
              timestampMs
            })
          )
        );
      } else {
        try {
          await input.context.tracing.stop();
        } catch (error) {
          input.runtime.logger.log("warn", "confirm.trace.stop_failed", {
            action_id: input.actionId,
            action_type: input.actionType,
            message: getErrorMessage(error)
          });
        }
      }
    }

    return {
      ...result,
      artifacts: dedupeArtifactPaths(artifactPaths)
    };
  } catch (error) {
    const capturedArtifacts = await captureFailureArtifacts({
      runtime: input.runtime,
      page: input.page,
      actionId: input.actionId,
      actionType: input.actionType,
      profileName: input.profileName,
      targetUrl: input.targetUrl,
      metadata: input.metadata,
      timestampMs
    });

    const traceArtifacts = tracingStarted
      ? await stopTracingWithPersistence({
          runtime: input.runtime,
          context: input.context,
          actionId: input.actionId,
          actionType: input.actionType,
          profileName: input.profileName,
          targetUrl: input.targetUrl,
          metadata: input.metadata,
          timestampMs
        })
      : [];

    const assistantError = attachArtifactPaths(
      input.mapError(error),
      dedupeArtifactPaths([
        ...getArtifactPathsFromError(error),
        ...capturedArtifacts,
        ...traceArtifacts
      ]),
      {
        action_id: input.actionId,
        action_type: input.actionType,
        profile_name: input.profileName,
        target_url: input.targetUrl,
        current_url: getPageUrl(input.page),
        ...input.errorDetails
      }
    );

    throw assistantError;
  }
}
