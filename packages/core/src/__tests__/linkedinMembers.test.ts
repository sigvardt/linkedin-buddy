import { describe, expect, it, vi } from "vitest";
import {
  BLOCK_MEMBER_ACTION_TYPE,
  LINKEDIN_MEMBER_REPORT_REASONS,
  LinkedInMembersService,
  REPORT_MEMBER_ACTION_TYPE,
  UNBLOCK_MEMBER_ACTION_TYPE,
  createMemberActionExecutors,
  normalizeLinkedInMemberReportReason
} from "../linkedinMembers.js";

describe("LinkedIn member safety constants", () => {
  it("exposes the supported report reasons", () => {
    expect(LINKEDIN_MEMBER_REPORT_REASONS).toEqual([
      "fake_profile",
      "impersonation",
      "harassment",
      "spam",
      "scam",
      "misinformation",
      "inappropriate_content",
      "something_else"
    ]);
  });

  it("has stable action type constants", () => {
    expect(BLOCK_MEMBER_ACTION_TYPE).toBe("members.block_member");
    expect(UNBLOCK_MEMBER_ACTION_TYPE).toBe("members.unblock_member");
    expect(REPORT_MEMBER_ACTION_TYPE).toBe("members.report_member");
  });
});

describe("normalizeLinkedInMemberReportReason", () => {
  it("normalizes known reasons", () => {
    expect(normalizeLinkedInMemberReportReason("spam")).toBe("spam");
  });

  it("rejects unknown reasons", () => {
    expect(() => normalizeLinkedInMemberReportReason("unknown")).toThrow(
      "reason must be one of"
    );
  });
});

describe("createMemberActionExecutors", () => {
  it("registers the member safety action executors", () => {
    const executors = createMemberActionExecutors();

    expect(Object.keys(executors)).toHaveLength(3);
    expect(executors[BLOCK_MEMBER_ACTION_TYPE]).toBeDefined();
    expect(executors[UNBLOCK_MEMBER_ACTION_TYPE]).toBeDefined();
    expect(executors[REPORT_MEMBER_ACTION_TYPE]).toBeDefined();
  });
});

describe("LinkedInMembersService prepare flows", () => {
  it("prepares block and unblock actions with targeted previews", () => {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const service = new LinkedInMembersService({
      twoPhaseCommit: { prepare }
    } as unknown as ConstructorParameters<typeof LinkedInMembersService>[0]);

    const blockPrepared = service.prepareBlockMember({
      targetProfile: "target-user"
    });
    const unblockPrepared = service.prepareUnblockMember({
      targetProfile: "target-user"
    });

    expect(blockPrepared.preview).toMatchObject({
      summary: "Block LinkedIn member target-user",
      target: {
        target_profile: "target-user",
        profile_name: "default"
      }
    });
    expect(unblockPrepared.preview).toMatchObject({
      summary: "Unblock LinkedIn member target-user"
    });

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actionType: BLOCK_MEMBER_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actionType: UNBLOCK_MEMBER_ACTION_TYPE })
    );
  });

  it("prepares report actions with structured payload", () => {
    const prepare = vi.fn((input: {
      payload: Record<string, unknown>;
      preview: Record<string, unknown>;
    }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const service = new LinkedInMembersService({
      twoPhaseCommit: { prepare }
    } as unknown as ConstructorParameters<typeof LinkedInMembersService>[0]);

    const prepared = service.prepareReportMember({
      targetProfile: "target-user",
      reason: "spam",
      details: "Repeated unsolicited outreach."
    });

    expect(prepared.preview).toMatchObject({
      summary: "Report LinkedIn member target-user for spam",
      payload: {
        reason: "spam",
        details: "Repeated unsolicited outreach."
      }
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: REPORT_MEMBER_ACTION_TYPE,
        payload: {
          reason: "spam",
          details: "Repeated unsolicited outreach."
        }
      })
    );
  });
});
