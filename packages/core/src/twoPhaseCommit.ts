import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AssistantDatabase, PreparedActionRow } from "./db/database.js";
import {
  LinkedInBuddyError,
  asLinkedInBuddyError,
  toLinkedInBuddyErrorPayload
} from "./errors.js";
import {
  redactStructuredValue,
  resolvePrivacyConfig,
  sealJsonRecord,
  unsealJsonRecord,
  type PrivacyConfig
} from "./privacy.js";

export const DEFAULT_CONFIRM_TOKEN_TTL_MS = 30 * 60 * 1000;

export const TEST_ECHO_ACTION_TYPE = "test.echo";

export interface TestAutoConfirmConfig {
  enabled: boolean;
  ttlMs: number;
  expiresAtMs: number;
  allowedTargets: string[];
}

export function createDefaultTestAutoConfirmConfig(): TestAutoConfirmConfig {
  const enabled =
    process.env.LINKEDIN_TEST_AUTO_CONFIRM_ENABLED === "true" ||
    process.env.LINKEDIN_TEST_AUTO_CONFIRM_ENABLED === "1";
  const ttlMs =
    Number.parseInt(process.env.LINKEDIN_TEST_AUTO_CONFIRM_TTL_MS ?? "0", 10) || 0;
  const allowedTargetsRaw = process.env.LINKEDIN_TEST_AUTO_CONFIRM_TARGETS ?? "";
  const allowedTargets = allowedTargetsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const expiresAtMs = enabled && ttlMs > 0 ? Date.now() + ttlMs : 0;

  return { enabled, ttlMs, expiresAtMs, allowedTargets };
}

export function isTestAutoConfirmActive(config: TestAutoConfirmConfig): boolean {
  if (!config.enabled) {
    return false;
  }
  if (config.expiresAtMs > 0 && Date.now() > config.expiresAtMs) {
    return false;
  }
  return true;
}

export function isTestAutoConfirmAllowedTarget(
  config: TestAutoConfirmConfig,
  targetUrl: string
): boolean {
  if (config.allowedTargets.length === 0) {
    return true;
  }
  return config.allowedTargets.some((allowed) => targetUrl.includes(allowed));
}

export interface PrepareActionInput {
  actionType: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  operatorNote?: string;
  expiresInMs?: number;
  nowMs?: number;
}

export interface PreparedActionResult {
  preparedActionId: string;
  confirmToken: string;
  expiresAtMs: number;
  preview: Record<string, unknown>;
}

export interface ConfirmByTokenInput {
  confirmToken: string;
  nowMs?: number;
}

export interface ActionExecutorResult {
  ok: true;
  result: Record<string, unknown>;
  artifacts: string[];
  /**
   * Non-fatal warnings from post-execution steps (e.g. verification, screenshot).
   * When present, the core action succeeded but ancillary steps failed.
   * Callers should treat the action as successful and NOT retry.
   */
  warnings?: string[];
}

export interface ActionExecutorInput<TRuntime> {
  runtime: TRuntime;
  action: PreparedAction;
}

export interface ActionExecutor<TRuntime> {
  execute(input: ActionExecutorInput<TRuntime>):
    | ActionExecutorResult
    | Promise<ActionExecutorResult>;
}

export type ActionExecutorRegistry<TRuntime> = Record<
  string,
  ActionExecutor<TRuntime>
>;

export interface PreparedAction {
  id: string;
  actionType: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  payloadHash: string;
  previewHash: string;
  status: string;
  expiresAtMs: number;
  createdAtMs: number;
  confirmedAtMs: number | null;
  operatorNote: string | null;
  executedAtMs: number | null;
  executionResult: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ConfirmByTokenResult {
  preparedActionId: string;
  status: "executed";
  actionType: string;
  result: Record<string, unknown>;
  artifacts: string[];
  /** Non-fatal warnings from post-execution steps. Action succeeded; do not retry. */
  warnings?: string[];
}

export interface PreparedActionPreview {
  preparedActionId: string;
  status: string;
  actionType: string;
  expiresAtMs: number;
  preview: Record<string, unknown>;
  target: Record<string, unknown>;
  operatorNote: string | null;
}

export interface TwoPhaseCommitServiceOptions<TRuntime> {
  executors?: ActionExecutorRegistry<TRuntime>;
  getRuntime?: () => TRuntime;
  privacy?: Partial<PrivacyConfig>;
}

export function generateConfirmToken(entropyBytes: number = 24): string {
  return `ct_${randomBytes(entropyBytes).toString("base64url")}`;
}

export function hashConfirmToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function hashJsonPayload(json: string): string {
  return createHash("sha256").update(json).digest("base64url");
}

export function isTokenExpired(expiresAtMs: number, nowMs: number = Date.now()): boolean {
  return nowMs > expiresAtMs;
}

function parseJsonObject(
  label: string,
  value: string,
  actionId: string
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${label} must be an object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} has invalid ${label}.`,
      {
        action_id: actionId,
        label
      },
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

function unsealPreparedJsonObject(
  label: string,
  value: string,
  actionId: string,
  confirmToken: string,
  privacy: PrivacyConfig
): Record<string, unknown> {
  try {
    return unsealJsonRecord(value, confirmToken, privacy);
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} has invalid ${label}.`,
      {
        action_id: actionId,
        label
      },
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

function parseExecutionResult(
  executionResultJson: string | null,
  actionId: string
): Record<string, unknown> | null {
  if (!executionResultJson) {
    return null;
  }

  return parseJsonObject("execution_result_json", executionResultJson, actionId);
}

function mapPreparedActionRow(
  row: PreparedActionRow,
  overrides: {
    target?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  } = {}
): PreparedAction {
  return {
    id: row.id,
    actionType: row.action_type,
    target: overrides.target ?? parseJsonObject("target_json", row.target_json, row.id),
    payload:
      overrides.payload ?? parseJsonObject("payload_json", row.payload_json, row.id),
    preview: parseJsonObject("preview_json", row.preview_json, row.id),
    payloadHash: row.payload_hash,
    previewHash: row.preview_hash,
    status: row.status,
    expiresAtMs: row.expires_at,
    createdAtMs: row.created_at,
    confirmedAtMs: row.confirmed_at,
    operatorNote: row.operator_note,
    executedAtMs: row.executed_at,
    executionResult: parseExecutionResult(row.execution_result_json, row.id),
    errorCode: row.error_code,
    errorMessage: row.error_message
  };
}

function hydratePreparedActionForConfirmation(
  row: PreparedActionRow,
  confirmToken: string,
  privacy: PrivacyConfig
): PreparedAction {
  const target = row.sealed_target_json
    ? unsealPreparedJsonObject(
        "sealed_target_json",
        row.sealed_target_json,
        row.id,
        confirmToken,
        privacy
      )
    : parseJsonObject("target_json", row.target_json, row.id);
  const payload = row.sealed_payload_json
    ? unsealPreparedJsonObject(
        "sealed_payload_json",
        row.sealed_payload_json,
        row.id,
        confirmToken,
        privacy
      )
    : parseJsonObject("payload_json", row.payload_json, row.id);

  return mapPreparedActionRow(row, {
    target,
    payload
  });
}

function assertPreparedActionByToken(
  row: PreparedActionRow | undefined,
  confirmTokenHash: string
): PreparedActionRow {
  if (!row) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Prepared action not found for the provided confirmation token.",
      {
        confirm_token_hash: confirmTokenHash
      }
    );
  }

  return row;
}

function assertPreparedActionIsReady(action: PreparedAction, nowMs: number): void {
  if (action.status !== "prepared") {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${action.id} is not pending confirmation.`,
      {
        action_id: action.id,
        status: action.status
      }
    );
  }

  if (isTokenExpired(action.expiresAtMs, nowMs)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Confirmation token expired for action ${action.id}.`,
      {
        action_id: action.id,
        expires_at_ms: action.expiresAtMs,
        now_ms: nowMs
      }
    );
  }
}

export class TwoPhaseCommitService<TRuntime = unknown> {
  private readonly executors: ActionExecutorRegistry<TRuntime>;
  private readonly getRuntime: (() => TRuntime) | undefined;
  private readonly privacy: PrivacyConfig;

  constructor(
    private readonly db: AssistantDatabase,
    options: TwoPhaseCommitServiceOptions<TRuntime> = {}
  ) {
    this.executors = options.executors ?? {};
    this.getRuntime = options.getRuntime;
    this.privacy = resolvePrivacyConfig(options.privacy);
  }

  prepare(input: PrepareActionInput): PreparedActionResult {
    const nowMs = input.nowMs ?? Date.now();
    const expiresInMs = input.expiresInMs ?? DEFAULT_CONFIRM_TOKEN_TTL_MS;
    const preparedActionId = `pa_${randomUUID().replaceAll("-", "")}`;
    const confirmToken = generateConfirmToken();
    const confirmTokenHash = hashConfirmToken(confirmToken);
    const expiresAtMs = nowMs + expiresInMs;

    const targetJson = JSON.stringify(input.target);
    const payloadJson = JSON.stringify(input.payload);
    const previewJson = JSON.stringify(input.preview);
    const storedTarget = redactStructuredValue(input.target, this.privacy, "storage");
    const storedPayload = redactStructuredValue(input.payload, this.privacy, "storage");
    const storedPreview = redactStructuredValue(input.preview, this.privacy, "storage");
    const storedTargetJson = JSON.stringify(storedTarget);
    const storedPayloadJson = JSON.stringify(storedPayload);
    const storedPreviewJson = JSON.stringify(storedPreview);
    const storedOperatorNote =
      typeof input.operatorNote === "string"
        ? (() => {
            const sanitized = redactStructuredValue(
              { note: input.operatorNote },
              this.privacy,
              "storage"
            );
            return typeof sanitized.note === "string"
              ? sanitized.note
              : input.operatorNote;
          })()
        : null;
    const payloadHash = hashJsonPayload(payloadJson);
    const previewHash = hashJsonPayload(previewJson);

    this.db.insertPreparedAction({
      id: preparedActionId,
      actionType: input.actionType,
      targetJson: storedTargetJson,
      sealedTargetJson:
        storedTargetJson === targetJson
          ? null
          : sealJsonRecord(input.target, confirmToken, this.privacy),
      payloadJson: storedPayloadJson,
      sealedPayloadJson:
        storedPayloadJson === payloadJson
          ? null
          : sealJsonRecord(input.payload, confirmToken, this.privacy),
      previewJson: storedPreviewJson,
      payloadHash,
      previewHash,
      status: "prepared",
      confirmTokenHash,
      expiresAtMs,
      createdAtMs: nowMs,
      operatorNote: storedOperatorNote
    });

    return {
      preparedActionId,
      confirmToken,
      expiresAtMs,
      preview: input.preview
    };
  }

  getPreparedActionPreviewByToken(input: ConfirmByTokenInput): PreparedActionPreview {
    const confirmTokenHash = hashConfirmToken(input.confirmToken);
    const row = assertPreparedActionByToken(
      this.db.getPreparedActionByConfirmTokenHash(confirmTokenHash),
      confirmTokenHash
    );
    const action = mapPreparedActionRow(row);

    return {
      preparedActionId: action.id,
      status: action.status,
      actionType: action.actionType,
      expiresAtMs: action.expiresAtMs,
      preview: action.preview,
      target: action.target,
      operatorNote: action.operatorNote
    };
  }

  async confirm(input: ConfirmByTokenInput): Promise<ConfirmByTokenResult> {
    return this.confirmByToken(input);
  }

  async confirmByToken(input: ConfirmByTokenInput): Promise<ConfirmByTokenResult> {
    const confirmTokenHash = hashConfirmToken(input.confirmToken);
    const row = assertPreparedActionByToken(
      this.db.getPreparedActionByConfirmTokenHash(confirmTokenHash),
      confirmTokenHash
    );
    const action = hydratePreparedActionForConfirmation(
      row,
      input.confirmToken,
      this.privacy
    );
    const nowMs = input.nowMs ?? Date.now();

    assertPreparedActionIsReady(action, nowMs);

    const executor = this.executors[action.actionType];
    if (!executor) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `No executor registered for action type "${action.actionType}".`,
        {
          action_id: action.id,
          action_type: action.actionType
        }
      );
    }

    if (!this.getRuntime) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "No runtime provider configured for action execution.",
        {
          action_id: action.id
        }
      );
    }

    let executionResult: ActionExecutorResult;

    try {
      executionResult = await executor.execute({
        runtime: this.getRuntime(),
        action
      });
    } catch (error) {
      const assistantError = asLinkedInBuddyError(error);
      const errorPayload = toLinkedInBuddyErrorPayload(assistantError, this.privacy);
      const updated = this.db.markPreparedActionFailed({
        id: action.id,
        confirmedAtMs: nowMs,
        executedAtMs: nowMs,
        errorCode: assistantError.code,
        errorMessage: errorPayload.message
      });

      if (!updated) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          `Prepared action ${action.id} is no longer executable.`,
          {
            action_id: action.id
          }
        );
      }

      throw assistantError;
    }

    const storedExecutionResult = redactStructuredValue(
      {
        result: executionResult.result,
        artifacts: executionResult.artifacts
      },
      this.privacy,
      "storage"
    );
    const updated = this.db.markPreparedActionExecuted({
      id: action.id,
      confirmedAtMs: nowMs,
      executedAtMs: nowMs,
      executionResultJson: JSON.stringify(storedExecutionResult)
    });

    if (!updated) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `Prepared action ${action.id} could not be marked as executed.`,
        {
          action_id: action.id
        }
      );
    }

    return {
      preparedActionId: action.id,
      status: "executed",
      actionType: action.actionType,
      result: executionResult.result,
      artifacts: executionResult.artifacts,
      ...(executionResult.warnings && executionResult.warnings.length > 0
        ? { warnings: executionResult.warnings }
        : {})
    };
  }
}

export class TestEchoActionExecutor<TRuntime = unknown>
  implements ActionExecutor<TRuntime>
{
  execute(input: ActionExecutorInput<TRuntime>): ActionExecutorResult {
    const text =
      typeof input.action.payload.text === "string"
        ? input.action.payload.text
        : JSON.stringify(input.action.payload);

    return {
      ok: true,
      result: { echo: text },
      artifacts: []
    };
  }
}
