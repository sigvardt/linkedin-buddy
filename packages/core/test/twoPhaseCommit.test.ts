import { describe, expect, it } from "vitest";
import {
  AssistantDatabase,
  DEFAULT_CONFIRM_TOKEN_TTL_MS,
  TwoPhaseCommitService,
  generateConfirmToken,
  hashConfirmToken,
  hashJsonPayload,
  isTokenExpired
} from "../src/index.js";

describe("two-phase commit tokens", () => {
  it("generates ct_ tokens using base64url-safe characters", () => {
    const token = generateConfirmToken();

    expect(token.startsWith("ct_")).toBe(true);
    expect(token.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes tokens deterministically without storing raw token", () => {
    const token = "ct_example_token";
    const hashA = hashConfirmToken(token);
    const hashB = hashConfirmToken(token);

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(token);
  });

  it("uses a 30 minute default expiry and stores only token hash", () => {
    const db = new AssistantDatabase(":memory:");
    const service = new TwoPhaseCommitService(db);
    const nowMs = 1_700_000_000_000;
    const target = { thread_id: "1234" };
    const payload = { step: "test" };
    const preview = { summary: "testing" };

    const prepared = service.prepare({
      actionType: "noop",
      target,
      payload,
      preview,
      nowMs
    });

    const row = db.getPreparedActionById(prepared.preparedActionId);
    expect(row).toBeDefined();
    expect(prepared.expiresAtMs).toBe(nowMs + DEFAULT_CONFIRM_TOKEN_TTL_MS);
    expect(row?.expires_at).toBe(prepared.expiresAtMs);
    expect(row?.confirm_token_hash).toBe(hashConfirmToken(prepared.confirmToken));
    expect(row?.confirm_token_hash).not.toBe(prepared.confirmToken);
    expect(row?.target_json).toBe(JSON.stringify(target));
    expect(row?.preview_json).toBe(JSON.stringify(preview));
    expect(row?.payload_hash).toBe(hashJsonPayload(JSON.stringify(payload)));
    expect(row?.preview_hash).toBe(hashJsonPayload(JSON.stringify(preview)));
    expect(isTokenExpired(prepared.expiresAtMs, prepared.expiresAtMs + 1)).toBe(true);

    db.close();
  });

  it("confirms and executes by confirmation token lookup", async () => {
    const db = new AssistantDatabase(":memory:");
    const runtime = { label: "runtime" };
    const service = new TwoPhaseCommitService(db, {
      getRuntime: () => runtime,
      executors: {
        send_message: {
          execute: ({ action, runtime: executorRuntime }) => {
            expect(executorRuntime).toBe(runtime);
            expect(action.actionType).toBe("send_message");
            return {
              ok: true,
              result: { sent: true },
              artifacts: ["linkedin/screenshot-confirm.png"]
            };
          }
        }
      }
    });

    const prepared = service.prepare({
      actionType: "send_message",
      target: { profile_name: "default", thread_id: "thread-123" },
      payload: { text: "Hello!" },
      preview: { summary: "Send hello." },
      nowMs: 1_700_000_010_000
    });

    const confirmed = await service.confirmByToken({
      confirmToken: prepared.confirmToken,
      nowMs: 1_700_000_011_000
    });

    expect(confirmed.status).toBe("executed");
    expect(confirmed.result).toEqual({ sent: true });

    const row = db.getPreparedActionById(prepared.preparedActionId);
    expect(row?.status).toBe("executed");
    expect(row?.execution_result_json).toBeDefined();
    expect(row?.error_code).toBeNull();
    expect(row?.error_message).toBeNull();

    db.close();
  });
});
