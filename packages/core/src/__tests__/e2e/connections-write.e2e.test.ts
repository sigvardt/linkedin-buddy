import { describe, expect, it } from "vitest";
import {
  ACCEPT_INVITATION_ACTION_TYPE,
  SEND_INVITATION_ACTION_TYPE,
  WITHDRAW_INVITATION_ACTION_TYPE
} from "../../linkedinConnections.js";
import { LinkedInBuddyError } from "../../errors.js";
import {
  expectPreparedAction,
  expectRateLimitPreview,
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

  it("prepare invite with note includes note in preview outbound", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();
    const note = "Would love to connect — E2E preview only";

    const prepared = runtime.connections.prepareSendInvitation({
      targetProfile,
      note
    });

    expectPreparedAction(prepared);
    const outbound = prepared.preview.outbound as Record<string, unknown>;
    expect(outbound.note).toBe(note);
  });

  it("prepare invite without note has empty note in preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareSendInvitation({
      targetProfile
    });

    expectPreparedAction(prepared);
    const outbound = prepared.preview.outbound as Record<string, unknown>;
    expect(outbound.note).toBe("");
  });

  it("prepare invite includes rate limit metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareSendInvitation({
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.connections.send_invitation");
  });

  it("prepare accept includes rate limit metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareAcceptInvitation({
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.connections.accept_invitation");
  });

  it("prepare withdraw includes rate limit metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareWithdrawInvitation({
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.connections.withdraw_invitation");
  });

  it("prepare ignore includes rate limit metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareIgnoreInvitation({
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.connections.ignore_invitation");
  });

  it("prepare remove includes rate limit metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareRemoveConnection({
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.connections.remove_connection");
  });

  it("prepare follow includes rate limit metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareFollowMember({
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.connections.follow_member");
  });

  it("prepare unfollow includes rate limit metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareUnfollowMember({
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.connections.unfollow_member");
  });

  it("prepare invite preview summary includes target profile", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const prepared = runtime.connections.prepareSendInvitation({
      targetProfile
    });

    expect(prepared.preview.summary).toContain(targetProfile);
  });

  it("prepare relationship action previews include target in summary", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const actions = [
      runtime.connections.prepareAcceptInvitation({ targetProfile }),
      runtime.connections.prepareWithdrawInvitation({ targetProfile }),
      runtime.connections.prepareIgnoreInvitation({ targetProfile }),
      runtime.connections.prepareRemoveConnection({ targetProfile }),
      runtime.connections.prepareFollowMember({ targetProfile }),
      runtime.connections.prepareUnfollowMember({ targetProfile })
    ];

    for (const prepared of actions) {
      expect(String(prepared.preview.summary)).toContain(targetProfile);
    }
  });

  it("prepare invite with empty target throws ACTION_PRECONDITION_FAILED", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.connections.prepareSendInvitation({
        targetProfile: ""
      });
    }).toThrow(LinkedInBuddyError);

    try {
      runtime.connections.prepareSendInvitation({ targetProfile: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe("ACTION_PRECONDITION_FAILED");
    }
  });

  it("prepare accept with empty target throws ACTION_PRECONDITION_FAILED", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.connections.prepareAcceptInvitation({
        targetProfile: ""
      });
    }).toThrow(LinkedInBuddyError);

    try {
      runtime.connections.prepareAcceptInvitation({ targetProfile: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe("ACTION_PRECONDITION_FAILED");
    }
  });

  it("prepare invite with whitespace-only target throws ACTION_PRECONDITION_FAILED", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.connections.prepareSendInvitation({
        targetProfile: "   "
      });
    }).toThrow(LinkedInBuddyError);
  });

  it("each prepare action returns distinct action types", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getDefaultConnectionTarget();

    const invite = runtime.connections.prepareSendInvitation({ targetProfile });
    const accept = runtime.connections.prepareAcceptInvitation({ targetProfile });
    const withdraw = runtime.connections.prepareWithdrawInvitation({ targetProfile });
    const ignore = runtime.connections.prepareIgnoreInvitation({ targetProfile });
    const remove = runtime.connections.prepareRemoveConnection({ targetProfile });
    const follow = runtime.connections.prepareFollowMember({ targetProfile });
    const unfollow = runtime.connections.prepareUnfollowMember({ targetProfile });

    const actionIds = [
      invite, accept, withdraw, ignore, remove, follow, unfollow
    ].map((p) => p.preparedActionId);
    const uniqueIds = new Set(actionIds);
    expect(uniqueIds.size).toBe(7);

    const tokens = [
      invite, accept, withdraw, ignore, remove, follow, unfollow
    ].map((p) => p.confirmToken);
    const uniqueTokens = new Set(tokens);
    expect(uniqueTokens.size).toBe(7);
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
      expect(result.actionType).toBe(ACCEPT_INVITATION_ACTION_TYPE);
      expect(result.result).toMatchObject({
        status: "invitation_accepted"
      });
      return;
    }

    if (connectionConfirmMode === "withdraw") {
      expect(result.actionType).toBe(WITHDRAW_INVITATION_ACTION_TYPE);
      expect(result.result).toMatchObject({
        status: "invitation_withdrawn"
      });
      return;
    }

    expect(result.actionType).toBe(SEND_INVITATION_ACTION_TYPE);
    expect(result.result).toMatchObject({
      status: "invitation_sent"
    });
  }, 120_000);
});
