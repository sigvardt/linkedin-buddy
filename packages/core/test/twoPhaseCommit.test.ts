import { describe, expect, it } from "vitest";
import {
  AssistantDatabase,
  DEFAULT_CONFIRM_TOKEN_TTL_MS,
  TwoPhaseCommitService,
  generateConfirmToken,
  hashConfirmToken,
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

    const prepared = service.prepare({
      actionType: "noop",
      payload: { step: "test" },
      nowMs
    });

    const row = db.getPreparedActionById(prepared.preparedActionId);
    expect(row).toBeDefined();
    expect(prepared.expiresAtMs).toBe(nowMs + DEFAULT_CONFIRM_TOKEN_TTL_MS);
    expect(row?.expires_at).toBe(prepared.expiresAtMs);
    expect(row?.confirm_token_hash).toBe(hashConfirmToken(prepared.confirmToken));
    expect(row?.confirm_token_hash).not.toBe(prepared.confirmToken);
    expect(isTokenExpired(prepared.expiresAtMs, prepared.expiresAtMs + 1)).toBe(true);

    db.close();
  });
});
