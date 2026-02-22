import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import type { AssistantDatabase, PreparedActionRow } from "./db/database.js";

export const DEFAULT_CONFIRM_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface PrepareActionInput {
  actionType: string;
  payload: Record<string, unknown>;
  expiresInMs?: number;
  nowMs?: number;
}

export interface PreparedActionResult {
  preparedActionId: string;
  confirmToken: string;
  expiresAtMs: number;
}

export interface ConfirmActionInput {
  preparedActionId: string;
  confirmToken: string;
  nowMs?: number;
}

export interface ConfirmActionResult {
  preparedActionId: string;
  status: "confirmed";
  executed: false;
  actionType: string;
  payload: Record<string, unknown>;
}

export function generateConfirmToken(entropyBytes: number = 24): string {
  return `ct_${randomBytes(entropyBytes).toString("base64url")}`;
}

export function hashConfirmToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function isTokenExpired(expiresAtMs: number, nowMs: number = Date.now()): boolean {
  return nowMs > expiresAtMs;
}

function tokenHashMatches(rawToken: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashConfirmToken(rawToken));
  const expected = Buffer.from(storedHash);

  if (candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(candidate, expected);
}

function assertPreparedActionReady(
  action: PreparedActionRow | undefined,
  preparedActionId: string
): PreparedActionRow {
  if (!action) {
    throw new Error(`Prepared action not found: ${preparedActionId}`);
  }

  if (action.status !== "prepared") {
    throw new Error(`Prepared action is not pending confirmation: ${preparedActionId}`);
  }

  return action;
}

export class TwoPhaseCommitService {
  constructor(private readonly db: AssistantDatabase) {}

  prepare(input: PrepareActionInput): PreparedActionResult {
    const nowMs = input.nowMs ?? Date.now();
    const expiresInMs = input.expiresInMs ?? DEFAULT_CONFIRM_TOKEN_TTL_MS;
    const preparedActionId = `pa_${randomUUID().replaceAll("-", "")}`;
    const confirmToken = generateConfirmToken();
    const confirmTokenHash = hashConfirmToken(confirmToken);
    const expiresAtMs = nowMs + expiresInMs;

    this.db.insertPreparedAction({
      id: preparedActionId,
      actionType: input.actionType,
      payloadJson: JSON.stringify(input.payload),
      status: "prepared",
      confirmTokenHash,
      expiresAtMs,
      createdAtMs: nowMs
    });

    return {
      preparedActionId,
      confirmToken,
      expiresAtMs
    };
  }

  confirm(input: ConfirmActionInput): ConfirmActionResult {
    const action = assertPreparedActionReady(
      this.db.getPreparedActionById(input.preparedActionId),
      input.preparedActionId
    );

    const nowMs = input.nowMs ?? Date.now();

    if (isTokenExpired(action.expires_at, nowMs)) {
      throw new Error(`Confirmation token expired for action: ${input.preparedActionId}`);
    }

    if (!tokenHashMatches(input.confirmToken, action.confirm_token_hash)) {
      throw new Error("Confirmation token mismatch.");
    }

    this.db.markPreparedActionConfirmed(input.preparedActionId, nowMs);

    return {
      preparedActionId: input.preparedActionId,
      status: "confirmed",
      executed: false,
      actionType: action.action_type,
      payload: JSON.parse(action.payload_json) as Record<string, unknown>
    };
  }
}
