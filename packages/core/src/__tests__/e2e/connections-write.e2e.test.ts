import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getConnectionConfirmMode,
  getDefaultConnectionTarget,
  getWriteConfirmGate
} from "./helpers.js";
import {
  checkAuthenticated,
  checkCdpAvailable,
  cleanupRuntime,
  getRuntime
} from "./setup.js";

const connectionConfirmMode = getConnectionConfirmMode();
const connectionConfirmEnabled =
  getWriteConfirmGate("LINKEDIN_E2E_ENABLE_CONNECTION_CONFIRM").enabled &&
  ["invite", "accept", "withdraw"].includes(connectionConfirmMode);
const connectionConfirmTest = connectionConfirmEnabled ? it : it.skip;

describe("Connections Write E2E (2PC invitation flows)", () => {
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

  it("prepare returns valid previews for invite, accept, and withdraw", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const targetProfile = getDefaultConnectionTarget();

    const invite = runtime.connections.prepareSendInvitation({
      targetProfile,
      note: "E2E preview invite"
    });
    const accept = runtime.connections.prepareAcceptInvitation({
      targetProfile
    });
    const withdraw = runtime.connections.prepareWithdrawInvitation({
      targetProfile
    });

    for (const prepared of [invite, accept, withdraw]) {
      expect(prepared.preparedActionId).toMatch(/^pa_/);
      expect(prepared.confirmToken).toMatch(/^ct_/);
      expect(prepared.preview).toHaveProperty("summary");
      expect(prepared.preview).toHaveProperty("target");
    }
  });

  connectionConfirmTest("confirms the configured connection flow via prepare → confirm", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared =
      connectionConfirmMode === "accept"
        ? runtime.connections.prepareAcceptInvitation({ targetProfile })
        : connectionConfirmMode === "withdraw"
          ? runtime.connections.prepareWithdrawInvitation({ targetProfile })
          : runtime.connections.prepareSendInvitation({
              targetProfile,
              note: "E2E connection invite"
            });

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    if (connectionConfirmMode === "accept") {
      expect(result.actionType).toBe("connections.accept_invitation");
      expect(result.result).toMatchObject({
        status: "invitation_accepted"
      });
      return;
    }

    if (connectionConfirmMode === "withdraw") {
      expect(result.actionType).toBe("connections.withdraw_invitation");
      expect(result.result).toMatchObject({
        status: "invitation_withdrawn"
      });
      return;
    }

    expect(result.actionType).toBe("connections.send_invitation");
    expect(result.result).toMatchObject({
      status: "invitation_sent"
    });
  }, 120_000);
});
