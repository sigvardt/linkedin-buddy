import { describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  expectPreparedOutboundText,
  expectRateLimitPreview,
  getMessageThread,
  isOptInEnabled
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const messageConfirmTest = isOptInEnabled("LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM")
  ? it
  : it.skip;

/**
 * Inbox Write E2E — two-phase commit message send to Simon Miller.
 *
 * Safe test target: Simon Miller (linkedin.com/in/realsimonmiller)
 * Explicitly authorised by the project owner.
 *
 * Flow: inbox.prepareReply → twoPhaseCommit.confirmByToken
 *
 * Opt in with LINKEDIN_E2E_ENABLE_MESSAGE_CONFIRM=1.
 */
describe("Inbox Write E2E (2PC send_message)", () => {
  const e2e = setupE2ESuite();

  messageConfirmTest("sends a message to Simon Miller via prepare → confirm", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const simonThread = await getMessageThread(runtime);

    const timestamp = new Date().toISOString();
    const messageText = `E2E test message from linkedin-owa-agentools [${timestamp}]`;

    const prepared = await runtime.inbox.prepareReply({
      thread: simonThread.thread_id,
      text: messageText,
      operatorNote: "Automated E2E write test"
    });

    expectPreparedAction(prepared);
    expectPreparedOutboundText(prepared, messageText);

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("send_message");
    expect(result.result).toHaveProperty("sent", true);
  }, 120_000);

  it("prepare returns valid preview with rate limit info", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const simonThread = await getMessageThread(runtime);

    const prepared = await runtime.inbox.prepareReply({
      thread: simonThread.thread_id,
      text: "E2E preview-only test (will not confirm)"
    });

    expectRateLimitPreview(prepared.preview, "linkedin.messaging.send_message");
  }, 60_000);
});
