import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWriteConfirmGate } from "./helpers.js";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

const messageConfirmTest = getWriteConfirmGate(
  "LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM"
).enabled
  ? it
  : it.skip;

/**
 * Inbox Write E2E — two-phase commit message send to Simon Miller.
 *
 * Safe test target: Simon Miller (linkedin.com/in/realsimonmiller)
 * Explicitly authorised by project owner (Joakim Sigvardt).
 *
 * Flow: inbox.prepareReply → twoPhaseCommit.confirmByToken
 *
 * Opt in with LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM=1.
 */
describe("Inbox Write E2E (2PC send_message)", () => {
  let cdpOk = false;
  let authOk = false;

  beforeAll(async () => {
    cdpOk = await checkCdpAvailable();
    if (cdpOk) {
      authOk = await checkAuthenticated();
    }
  });

  afterAll(() => {
    cleanupRuntime();
  });

  messageConfirmTest("sends a message to Simon Miller via prepare → confirm", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();

    // Step 1: find Simon Miller's thread
    const threads = await runtime.inbox.listThreads({ limit: 40 });
    const simonThread = threads.find((t) =>
      /simon\s*miller/i.test(t.title)
    );

    expect(simonThread).toBeDefined();
    if (!simonThread) return; // type guard

    // Step 2: prepare a reply via 2PC
    const timestamp = new Date().toISOString();
    const messageText = `E2E test message from linkedin-owa-agentools [${timestamp}]`;

    const prepared = await runtime.inbox.prepareReply({
      thread: simonThread.thread_id,
      text: messageText,
      operatorNote: "Automated E2E write test"
    });

    expect(prepared.preparedActionId).toBeTruthy();
    expect(prepared.preparedActionId).toMatch(/^pa_/);
    expect(prepared.confirmToken).toBeTruthy();
    expect(prepared.confirmToken).toMatch(/^ct_/);
    expect(prepared.expiresAtMs).toBeGreaterThan(Date.now());
    expect(prepared.preview).toBeDefined();
    expect(prepared.preview).toHaveProperty("summary");
    expect(prepared.preview).toHaveProperty("target");
    expect(prepared.preview).toHaveProperty("outbound");

    const outbound = prepared.preview.outbound as { text: string };
    expect(outbound.text).toBe(messageText);

    // Step 3: confirm the action (execute the send)
    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("send_message");
    expect(result.result).toHaveProperty("sent", true);
  }, 120_000);

  it("prepare returns valid preview with rate limit info", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();

    const threads = await runtime.inbox.listThreads({ limit: 40 });
    const simonThread = threads.find((t) =>
      /simon\s*miller/i.test(t.title)
    );
    if (!simonThread) return;

    const prepared = await runtime.inbox.prepareReply({
      thread: simonThread.thread_id,
      text: "E2E preview-only test (will not confirm)"
    });

    expect(prepared.preview).toHaveProperty("rate_limit");
    const rateLimit = prepared.preview.rate_limit as Record<string, unknown>;
    expect(rateLimit).toHaveProperty("counter_key", "linkedin.messaging.send_message");
    expect(typeof rateLimit.remaining).toBe("number");
    expect(typeof rateLimit.allowed).toBe("boolean");

    // We intentionally do NOT confirm this one; it will expire naturally.
  }, 60_000);
});
