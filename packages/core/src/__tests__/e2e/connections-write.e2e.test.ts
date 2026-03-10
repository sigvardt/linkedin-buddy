import { describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  getConnectionConfirmMode,
  getDefaultConnectionTarget,
  isOptInEnabled
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const connectionConfirmMode = getConnectionConfirmMode();
const connectionConfirmEnabled =
  isOptInEnabled("LINKEDIN_E2E_ENABLE_CONNECTION_CONFIRM") &&
  ["invite", "accept", "withdraw"].includes(connectionConfirmMode);
const connectionConfirmTest = connectionConfirmEnabled ? it : it.skip;

describe("Connections Write E2E (2PC invitation flows)", () => {
  const e2e = setupE2ESuite();

  it("prepare returns valid previews for all supported relationship actions", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
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
    const ignore = runtime.connections.prepareIgnoreInvitation({
      targetProfile
    });
    const remove = runtime.connections.prepareRemoveConnection({
      targetProfile
    });
    const follow = runtime.connections.prepareFollowMember({
      targetProfile
    });
    const unfollow = runtime.connections.prepareUnfollowMember({
      targetProfile
    });

    for (const prepared of [
      invite,
      accept,
      withdraw,
      ignore,
      remove,
      follow,
      unfollow
    ]) {
      expectPreparedAction(prepared);
    }
  });

  connectionConfirmTest("confirms the configured connection flow via prepare → confirm", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
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
