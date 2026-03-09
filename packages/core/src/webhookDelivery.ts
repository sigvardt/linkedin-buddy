import { createHmac } from "node:crypto";
import type { ActivityEventType } from "./activityTypes.js";
import type { ActivityWebhookConfig } from "./config.js";
import { asLinkedInAssistantError, LinkedInAssistantError } from "./errors.js";

const MAX_RESPONSE_EXCERPT_LENGTH = 500;
const WEBHOOK_USER_AGENT = "linkedin-assistant-webhooks/1";

export interface DeliverWebhookInput {
  deliveryId: string;
  deliveryUrl: string;
  eventType: ActivityEventType;
  payloadJson: string;
  secret: string;
  retryCount: number;
  timeoutMs: number;
}

export interface DeliverWebhookResult {
  outcome: "delivered" | "retry" | "failed";
  responseStatus?: number;
  responseBodyExcerpt?: string | null;
  errorCode?: string | null;
  errorMessage: string;
  disableSubscription?: boolean;
}

function truncateExcerpt(value: string): string {
  return value.length <= MAX_RESPONSE_EXCERPT_LENGTH
    ? value
    : `${value.slice(0, MAX_RESPONSE_EXCERPT_LENGTH)}…`;
}

export function createWebhookSignature(
  secret: string,
  timestampSeconds: string,
  payloadJson: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${payloadJson}`)
    .digest("hex");
}

async function readResponseExcerpt(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.length > 0 ? truncateExcerpt(text) : null;
  } catch {
    return null;
  }
}

function isRetryableResponseStatus(status: number): boolean {
  if (status >= 500) {
    return true;
  }

  return status === 408 || status === 409 || status === 425 || status === 429;
}

export function calculateWebhookDeliveryBackoffMs(
  attemptNumber: number,
  retry: ActivityWebhookConfig["retry"]
): number {
  const exponent = Math.max(0, attemptNumber - 1);
  return Math.min(retry.maxBackoffMs, retry.initialBackoffMs * 2 ** exponent);
}

function normalizeDeliveryError(error: unknown): LinkedInAssistantError {
  if (error instanceof LinkedInAssistantError) {
    return error;
  }

  if (
    error instanceof Error &&
    /aborted|timeout/i.test(`${error.name} ${error.message}`)
  ) {
    return new LinkedInAssistantError(
      "TIMEOUT",
      "Webhook delivery timed out.",
      { cause_name: error.name },
      { cause: error }
    );
  }

  return asLinkedInAssistantError(
    error,
    "NETWORK_ERROR",
    "Webhook delivery failed."
  );
}

export async function deliverWebhook(
  input: DeliverWebhookInput
): Promise<DeliverWebhookResult> {
  const timestampSeconds = String(Math.floor(Date.now() / 1_000));
  const signature = createWebhookSignature(
    input.secret,
    timestampSeconds,
    input.payloadJson
  );

  try {
    const response = await fetch(input.deliveryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": WEBHOOK_USER_AGENT,
        "x-linkedin-assistant-event": input.eventType,
        "x-linkedin-assistant-delivery": input.deliveryId,
        "x-linkedin-assistant-retry-count": String(input.retryCount),
        "x-linkedin-assistant-timestamp": timestampSeconds,
        "x-linkedin-assistant-signature-256": `sha256=${signature}`
      },
      body: input.payloadJson,
      signal: AbortSignal.timeout(input.timeoutMs)
    });

    const responseBodyExcerpt = await readResponseExcerpt(response);

    if (response.ok) {
      return {
        outcome: "delivered",
        responseStatus: response.status,
        responseBodyExcerpt,
        errorMessage: "Webhook delivered successfully."
      };
    }

    if (isRetryableResponseStatus(response.status)) {
      return {
        outcome: "retry",
        responseStatus: response.status,
        responseBodyExcerpt,
        errorCode: response.status === 429 ? "RATE_LIMITED" : "NETWORK_ERROR",
        errorMessage: `Webhook receiver returned HTTP ${response.status}.`
      };
    }

    return {
      outcome: "failed",
      responseStatus: response.status,
      responseBodyExcerpt,
      errorCode: "ACTION_PRECONDITION_FAILED",
      errorMessage: `Webhook receiver returned HTTP ${response.status}.`,
      disableSubscription: response.status === 410
    };
  } catch (error) {
    const normalized = normalizeDeliveryError(error);
    return {
      outcome: normalized.code === "ACTION_PRECONDITION_FAILED" ? "failed" : "retry",
      errorCode: normalized.code,
      errorMessage: normalized.message
    };
  }
}
