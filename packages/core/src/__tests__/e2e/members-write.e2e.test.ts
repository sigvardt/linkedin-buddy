import { describe, expect, it } from "vitest";
import {
  BLOCK_MEMBER_ACTION_TYPE,
  LINKEDIN_MEMBER_REPORT_REASONS,
  UNBLOCK_MEMBER_ACTION_TYPE
} from "../../linkedinMembers.js";
import { LinkedInBuddyError } from "../../errors.js";
import {
  callMcpTool,
  expectPreparedAction,
  expectRateLimitPreview,
  getDefaultProfileName,
  getLastJsonObject,
  isOptInEnabled,
  isReplayModeEnabled,
  MCP_TOOL_NAMES,
  runCliCommand
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const DEFAULT_MEMBER_TARGET = "realsimonmiller";

function getMemberTarget(): string {
  const env = process.env.LINKEDIN_E2E_MEMBER_TARGET;
  return typeof env === "string" && env.trim().length > 0
    ? env.trim()
    : DEFAULT_MEMBER_TARGET;
}

const blockConfirmEnabled = !isReplayModeEnabled() && isOptInEnabled(
  "LINKEDIN_E2E_ENABLE_BLOCK_CONFIRM"
);
const blockConfirmTest = blockConfirmEnabled ? it : it.skip;

const unblockConfirmEnabled = !isReplayModeEnabled() && isOptInEnabled(
  "LINKEDIN_E2E_ENABLE_UNBLOCK_CONFIRM"
);
const unblockConfirmTest = unblockConfirmEnabled ? it : it.skip;

describe("Members Write E2E (2PC block/unblock/report)", () => {
  const e2e = setupE2ESuite();
  const profileName = getDefaultProfileName();

  it("prepare block returns valid preview", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareBlockMember({
      profileName,
      targetProfile
    });

    expectPreparedAction(prepared);
  });

  it("prepare block preview summary includes target profile", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareBlockMember({
      profileName,
      targetProfile
    });

    expect(String(prepared.preview.summary)).toContain(targetProfile);
  });

  it("prepare block includes rate limit metadata", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareBlockMember({
      profileName,
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.members.block_member"
    );
  });

  it("prepare block preview target includes profile name and target", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareBlockMember({
      profileName,
      targetProfile
    });

    const target = prepared.preview.target as Record<string, unknown>;
    expect(target.profile_name).toBe(profileName);
    expect(target.target_profile).toBe(targetProfile);
  });

  it("prepare unblock returns valid preview", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareUnblockMember({
      profileName,
      targetProfile
    });

    expectPreparedAction(prepared);
  });

  it("prepare unblock preview summary includes target profile", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareUnblockMember({
      profileName,
      targetProfile
    });

    expect(String(prepared.preview.summary)).toContain(targetProfile);
  });

  it("prepare unblock includes rate limit metadata", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareUnblockMember({
      profileName,
      targetProfile
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.members.unblock_member"
    );
  });

  it("prepare unblock preview target includes profile name and target", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareUnblockMember({
      profileName,
      targetProfile
    });

    const target = prepared.preview.target as Record<string, unknown>;
    expect(target.profile_name).toBe(profileName);
    expect(target.target_profile).toBe(targetProfile);
  });

  it("prepare report returns valid preview with reason in payload", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareReportMember({
      profileName,
      targetProfile,
      reason: "spam"
    });

    expectPreparedAction(prepared);
    expect(prepared.preview).toHaveProperty("payload");
    const payload = prepared.preview.payload as Record<string, unknown>;
    expect(payload.reason).toBe("spam");
  });

  it("prepare report with details includes details in payload", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareReportMember({
      profileName,
      targetProfile,
      reason: "spam",
      details: "Repeated unsolicited outreach."
    });

    expectPreparedAction(prepared);
    const payload = prepared.preview.payload as Record<string, unknown>;
    expect(payload.reason).toBe("spam");
    expect(payload.details).toBe("Repeated unsolicited outreach.");
  });

  it("prepare report preview summary includes target and reason", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareReportMember({
      profileName,
      targetProfile,
      reason: "harassment"
    });

    expect(String(prepared.preview.summary)).toContain(targetProfile);
    expect(String(prepared.preview.summary)).toContain("harassment");
  });

  it("prepare report includes rate limit metadata", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const prepared = runtime.members.prepareReportMember({
      profileName,
      targetProfile,
      reason: "spam"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.members.report_member"
    );
  });

  for (const reason of LINKEDIN_MEMBER_REPORT_REASONS) {
    it(`prepare report accepts reason "${reason}"`, (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();
      const targetProfile = getMemberTarget();

      const prepared = runtime.members.prepareReportMember({
        profileName,
        targetProfile,
        reason
      });

      expectPreparedAction(prepared);
      const payload = prepared.preview.payload as Record<string, unknown>;
      expect(payload.reason).toBe(reason);
      expect(String(prepared.preview.summary)).toContain(reason);
    });
  }

  it("block, unblock, and report return distinct action IDs and tokens", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    const block = runtime.members.prepareBlockMember({
      profileName,
      targetProfile
    });
    const unblock = runtime.members.prepareUnblockMember({
      profileName,
      targetProfile
    });
    const report = runtime.members.prepareReportMember({
      profileName,
      targetProfile,
      reason: "spam"
    });

    const actionIds = [block, unblock, report].map(
      (p) => p.preparedActionId
    );
    expect(new Set(actionIds).size).toBe(3);

    const tokens = [block, unblock, report].map((p) => p.confirmToken);
    expect(new Set(tokens).size).toBe(3);
  });

  it("prepare block with empty target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.members.prepareBlockMember({
        profileName,
        targetProfile: ""
      });
    }).toThrow(LinkedInBuddyError);

    try {
      runtime.members.prepareBlockMember({ profileName, targetProfile: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe(
        "ACTION_PRECONDITION_FAILED"
      );
    }
  });

  it("prepare unblock with empty target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.members.prepareUnblockMember({
        profileName,
        targetProfile: ""
      });
    }).toThrow(LinkedInBuddyError);

    try {
      runtime.members.prepareUnblockMember({
        profileName,
        targetProfile: ""
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe(
        "ACTION_PRECONDITION_FAILED"
      );
    }
  });

  it("prepare report with empty target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.members.prepareReportMember({
        profileName,
        targetProfile: "",
        reason: "spam"
      });
    }).toThrow(LinkedInBuddyError);

    try {
      runtime.members.prepareReportMember({
        profileName,
        targetProfile: "",
        reason: "spam"
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe(
        "ACTION_PRECONDITION_FAILED"
      );
    }
  });

  it("prepare block with whitespace-only target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.members.prepareBlockMember({
        profileName,
        targetProfile: "   "
      });
    }).toThrow(LinkedInBuddyError);
  });

  it("prepare unblock with whitespace-only target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.members.prepareUnblockMember({
        profileName,
        targetProfile: "   "
      });
    }).toThrow(LinkedInBuddyError);
  });

  it("prepare report with whitespace-only target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.members.prepareReportMember({
        profileName,
        targetProfile: "   ",
        reason: "spam"
      });
    }).toThrow(LinkedInBuddyError);
  });

  it("prepare report with invalid reason throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetProfile = getMemberTarget();

    expect(() => {
      runtime.members.prepareReportMember({
        profileName,
        targetProfile,
        reason: "not_a_valid_reason"
      });
    }).toThrow(LinkedInBuddyError);

    try {
      runtime.members.prepareReportMember({
        profileName,
        targetProfile,
        reason: "not_a_valid_reason"
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe(
        "ACTION_PRECONDITION_FAILED"
      );
      expect((error as LinkedInBuddyError).message).toContain(
        "reason must be one of"
      );
    }
  });

  it("CLI members block returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "members",
      "block",
      getMemberTarget(),
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(getLastJsonObject(result.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("CLI members unblock returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "members",
      "unblock",
      getMemberTarget(),
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(getLastJsonObject(result.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("CLI members report returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "members",
      "report",
      getMemberTarget(),
      "--reason",
      "spam",
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(getLastJsonObject(result.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("CLI members report with details returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "members",
      "report",
      getMemberTarget(),
      "--reason",
      "harassment",
      "--details",
      "Persistent unwanted contact.",
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(getLastJsonObject(result.stdout)).toMatchObject({
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("CLI members report with invalid reason exits with error", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "members",
      "report",
      getMemberTarget(),
      "--reason",
      "bogus_reason",
      "--profile",
      profileName
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("reason must be one of");
  });

  it("CLI members report help lists all valid report reasons", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand(["members", "report", "--help"]);

    for (const reason of LINKEDIN_MEMBER_REPORT_REASONS) {
      expect(result.stdout).toContain(reason);
    }
  });

  it("MCP prepare block returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.membersPrepareBlock, {
      profileName,
      targetProfile: getMemberTarget()
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("MCP prepare unblock returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.membersPrepareUnblock, {
      profileName,
      targetProfile: getMemberTarget()
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("MCP prepare report returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.membersPrepareReport, {
      profileName,
      targetProfile: getMemberTarget(),
      reason: "spam"
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("MCP prepare report with invalid reason returns error", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.membersPrepareReport, {
      profileName,
      targetProfile: getMemberTarget(),
      reason: "not_valid"
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.payload)).toContain("reason must be one of");
  });

  blockConfirmTest(
    "blocks a member via prepare → confirm",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();
      const targetProfile = getMemberTarget();

      const prepared = runtime.members.prepareBlockMember({
        profileName,
        targetProfile,
        operatorNote: "Automated E2E block test"
      });

      expectPreparedAction(prepared);

      const result = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken
      });

      expect(result.status).toBe("executed");
      expect(result.actionType).toBe(BLOCK_MEMBER_ACTION_TYPE);
      expect(result.result).toMatchObject({
        status: "member_blocked"
      });
    },
    120_000
  );

  unblockConfirmTest(
    "unblocks a member via prepare → confirm",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();
      const targetProfile = getMemberTarget();

      const prepared = runtime.members.prepareUnblockMember({
        profileName,
        targetProfile,
        operatorNote: "Automated E2E unblock test"
      });

      expectPreparedAction(prepared);

      const result = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken
      });

      expect(result.status).toBe("executed");
      expect(result.actionType).toBe(UNBLOCK_MEMBER_ACTION_TYPE);
      expect(result.result).toMatchObject({
        status: "member_unblocked"
      });
    },
    120_000
  );
});
