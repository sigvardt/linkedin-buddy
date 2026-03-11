import { describe, expect, it, vi } from "vitest";
import {
  GROUP_JOIN_ACTION_TYPE,
  GROUP_LEAVE_ACTION_TYPE,
  GROUP_POST_ACTION_TYPE,
  LinkedInGroupsService,
  buildGroupSearchUrl,
  buildGroupViewUrl,
  createGroupActionExecutors
} from "../linkedinGroups.js";
import { createAllowedRateLimiterStub } from "./rateLimiterTestUtils.js";

describe("LinkedInGroups helpers", () => {
  it("builds group search URLs", () => {
    expect(buildGroupSearchUrl("technology")).toBe(
      "https://www.linkedin.com/search/results/groups/?keywords=technology"
    );
  });

  it("builds group view URLs", () => {
    expect(buildGroupViewUrl("9806731")).toBe(
      "https://www.linkedin.com/groups/9806731/"
    );
  });
});

describe("createGroupActionExecutors", () => {
  it("registers the supported group action executors", () => {
    const executors = createGroupActionExecutors();

    expect(Object.keys(executors)).toHaveLength(3);
    expect(executors[GROUP_JOIN_ACTION_TYPE]).toBeDefined();
    expect(executors[GROUP_LEAVE_ACTION_TYPE]).toBeDefined();
    expect(executors[GROUP_POST_ACTION_TYPE]).toBeDefined();
  });
});

describe("LinkedInGroupsService prepare flows", () => {
  it("prepares join and leave actions with normalized targets", () => {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_group",
      confirmToken: "ct_group",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const rateLimiter = createAllowedRateLimiterStub();
    const service = new LinkedInGroupsService({
      rateLimiter,
      twoPhaseCommit: { prepare }
    } as unknown as ConstructorParameters<typeof LinkedInGroupsService>[0]);

    const joinPrepared = service.prepareJoinGroup({
      group: "https://www.linkedin.com/groups/9806731/"
    });
    const leavePrepared = service.prepareLeaveGroup({
      group: "9806731"
    });

    expect(joinPrepared.preview).toMatchObject({
      summary: "Join LinkedIn group 9806731",
      target: {
        group_id: "9806731",
        group_url: "https://www.linkedin.com/groups/9806731/",
        profile_name: "default"
      },
      rate_limit: {
        counter_key: "linkedin.groups.join"
      }
    });
    expect(leavePrepared.preview).toMatchObject({
      summary: "Leave LinkedIn group 9806731",
      rate_limit: {
        counter_key: "linkedin.groups.leave"
      }
    });

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actionType: GROUP_JOIN_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actionType: GROUP_LEAVE_ACTION_TYPE })
    );
  });

  it("prepares group posts with structured payloads", () => {
    const prepare = vi.fn((input: {
      payload: Record<string, unknown>;
      preview: Record<string, unknown>;
    }) => ({
      preparedActionId: "pa_group_post",
      confirmToken: "ct_group_post",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const rateLimiter = createAllowedRateLimiterStub();
    const service = new LinkedInGroupsService({
      rateLimiter,
      twoPhaseCommit: { prepare }
    } as unknown as ConstructorParameters<typeof LinkedInGroupsService>[0]);

    const prepared = service.preparePostToGroup({
      group: "9806731",
      text: "Ship it."
    });

    expect(prepared.preview).toMatchObject({
      summary: "Post in LinkedIn group 9806731",
      payload: {
        text: "Ship it."
      },
      rate_limit: {
        counter_key: "linkedin.groups.post"
      }
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: GROUP_POST_ACTION_TYPE,
        payload: {
          text: "Ship it."
        }
      })
    );
  });
});
