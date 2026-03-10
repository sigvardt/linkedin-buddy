import { describe, expect, it, vi } from "vitest";
import {
  ACCEPT_INVITATION_ACTION_TYPE,
  FOLLOW_MEMBER_ACTION_TYPE,
  IGNORE_INVITATION_ACTION_TYPE,
  LinkedInConnectionsService,
  REMOVE_CONNECTION_ACTION_TYPE,
  SEND_INVITATION_ACTION_TYPE,
  UNFOLLOW_MEMBER_ACTION_TYPE,
  WITHDRAW_INVITATION_ACTION_TYPE,
  createConnectionActionExecutors
} from "../linkedinConnections.js";

describe("Connection action type constants", () => {
  it("has correct send invitation action type", () => {
    expect(SEND_INVITATION_ACTION_TYPE).toBe("connections.send_invitation");
  });

  it("has correct accept invitation action type", () => {
    expect(ACCEPT_INVITATION_ACTION_TYPE).toBe("connections.accept_invitation");
  });

  it("has correct withdraw invitation action type", () => {
    expect(WITHDRAW_INVITATION_ACTION_TYPE).toBe("connections.withdraw_invitation");
  });

  it("has correct ignore invitation action type", () => {
    expect(IGNORE_INVITATION_ACTION_TYPE).toBe("connections.ignore_invitation");
  });

  it("has correct remove connection action type", () => {
    expect(REMOVE_CONNECTION_ACTION_TYPE).toBe("connections.remove_connection");
  });

  it("has correct follow member action type", () => {
    expect(FOLLOW_MEMBER_ACTION_TYPE).toBe("connections.follow_member");
  });

  it("has correct unfollow member action type", () => {
    expect(UNFOLLOW_MEMBER_ACTION_TYPE).toBe("connections.unfollow_member");
  });
});

describe("createConnectionActionExecutors", () => {
  it("registers all seven action executors", () => {
    const executors = createConnectionActionExecutors();
    expect(Object.keys(executors)).toHaveLength(7);
    expect(executors[SEND_INVITATION_ACTION_TYPE]).toBeDefined();
    expect(executors[ACCEPT_INVITATION_ACTION_TYPE]).toBeDefined();
    expect(executors[WITHDRAW_INVITATION_ACTION_TYPE]).toBeDefined();
    expect(executors[IGNORE_INVITATION_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_CONNECTION_ACTION_TYPE]).toBeDefined();
    expect(executors[FOLLOW_MEMBER_ACTION_TYPE]).toBeDefined();
    expect(executors[UNFOLLOW_MEMBER_ACTION_TYPE]).toBeDefined();
  });

  it("each executor has an execute method", () => {
    const executors = createConnectionActionExecutors();
    for (const key of Object.keys(executors)) {
      const executor = executors[key];
      expect(executor).toBeDefined();
      expect(typeof executor!.execute).toBe("function");
    }
  });
});

describe("LinkedInConnectionsService prepare relationship actions", () => {
  it("prepares ignore, remove, follow, and unfollow actions with targeted previews", () => {
    const prepare = vi.fn((input: {
      preview: Record<string, unknown>;
    }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview
    }));

    const service = new LinkedInConnectionsService({
      twoPhaseCommit: { prepare }
    } as unknown as ConstructorParameters<typeof LinkedInConnectionsService>[0]);

    const ignorePrepared = service.prepareIgnoreInvitation({
      targetProfile: "target-user"
    });
    const removePrepared = service.prepareRemoveConnection({
      targetProfile: "target-user"
    });
    const followPrepared = service.prepareFollowMember({
      targetProfile: "target-user"
    });
    const unfollowPrepared = service.prepareUnfollowMember({
      targetProfile: "target-user"
    });

    expect(ignorePrepared.preview).toMatchObject({
      summary: "Ignore connection invitation from target-user",
      target: {
        target_profile: "target-user",
        profile_name: "default"
      }
    });
    expect(removePrepared.preview).toMatchObject({
      summary: "Remove existing connection with target-user"
    });
    expect(followPrepared.preview).toMatchObject({
      summary: "Follow target-user"
    });
    expect(unfollowPrepared.preview).toMatchObject({
      summary: "Unfollow target-user"
    });

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actionType: IGNORE_INVITATION_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actionType: REMOVE_CONNECTION_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ actionType: FOLLOW_MEMBER_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ actionType: UNFOLLOW_MEMBER_ACTION_TYPE })
    );
  });
});

describe("LinkedInConnection interface shape", () => {
  it("validates a well-formed connection object", () => {
    const connection = {
      vanity_name: "johndoe",
      full_name: "John Doe",
      headline: "Software Engineer",
      profile_url: "https://www.linkedin.com/in/johndoe/",
      connected_since: "Connected 2 months ago"
    };
    expect(connection.vanity_name).toBe("johndoe");
    expect(connection.full_name).toBe("John Doe");
    expect(connection.headline).toBe("Software Engineer");
    expect(typeof connection.profile_url).toBe("string");
    expect(typeof connection.connected_since).toBe("string");
  });

  it("allows null vanity_name", () => {
    const connection = {
      vanity_name: null,
      full_name: "Jane Doe",
      headline: "",
      profile_url: "",
      connected_since: ""
    };
    expect(connection.vanity_name).toBeNull();
  });
});

describe("LinkedInPendingInvitation interface shape", () => {
  it("validates a received invitation", () => {
    const invitation = {
      vanity_name: "janedoe",
      full_name: "Jane Doe",
      headline: "Product Manager",
      profile_url: "https://www.linkedin.com/in/janedoe/",
      sent_or_received: "received" as const
    };
    expect(invitation.sent_or_received).toBe("received");
    expect(invitation.vanity_name).toBe("janedoe");
  });

  it("validates a sent invitation", () => {
    const invitation = {
      vanity_name: "bobsmith",
      full_name: "Bob Smith",
      headline: "Designer",
      profile_url: "https://www.linkedin.com/in/bobsmith/",
      sent_or_received: "sent" as const
    };
    expect(invitation.sent_or_received).toBe("sent");
  });
});
