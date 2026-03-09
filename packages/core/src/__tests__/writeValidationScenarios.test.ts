import { afterEach, describe, expect, it, vi } from "vitest";
import { SEND_INVITATION_ACTION_TYPE } from "../linkedinConnections.js";
import { LIKE_POST_ACTION_TYPE } from "../linkedinFeed.js";
import { FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE } from "../linkedinFollowups.js";
import { CREATE_POST_ACTION_TYPE } from "../linkedinPosts.js";
import type { CoreRuntime } from "../runtime.js";
import type { PreparedActionResult } from "../twoPhaseCommit.js";
import type { WriteValidationAccount } from "../writeValidationAccounts.js";
import {
  LINKEDIN_WRITE_VALIDATION_ACTIONS,
  WRITE_VALIDATION_SCENARIOS
} from "../writeValidationScenarios.js";
import {
  SEND_MESSAGE_ACTION_TYPE,
  WRITE_VALIDATION_FEED_URL,
  type LinkedInWriteValidationActionType,
  type ScenarioPrepareResult,
  type WriteValidationScenarioDefinition
} from "../writeValidationShared.js";

interface ScenarioRuntimeMocks {
  connections: {
    listPendingInvitations: ReturnType<typeof vi.fn>;
    prepareSendInvitation: ReturnType<typeof vi.fn>;
  };
  db: {
    getSentInvitationState: ReturnType<typeof vi.fn>;
  };
  feed: {
    prepareLikePost: ReturnType<typeof vi.fn>;
    viewPost: ReturnType<typeof vi.fn>;
  };
  followups: {
    prepareFollowupForAcceptedConnection: ReturnType<typeof vi.fn>;
  };
  inbox: {
    getThread: ReturnType<typeof vi.fn>;
    prepareReply: ReturnType<typeof vi.fn>;
  };
  posts: {
    prepareCreate: ReturnType<typeof vi.fn>;
  };
}

function createPreparedAction(
  preview: PreparedActionResult["preview"] = {
    outbound: {},
    target: {}
  }
): PreparedActionResult {
  return {
    preparedActionId: "prepared_123",
    confirmToken: "confirm_123",
    expiresAtMs: 1_746_000_000_000,
    preview
  };
}

function createRuntimeMock(): CoreRuntime & ScenarioRuntimeMocks {
  const runtime = {
    connections: {
      listPendingInvitations: vi.fn(),
      prepareSendInvitation: vi.fn()
    },
    db: {
      getSentInvitationState: vi.fn()
    },
    feed: {
      prepareLikePost: vi.fn(),
      viewPost: vi.fn()
    },
    followups: {
      prepareFollowupForAcceptedConnection: vi.fn()
    },
    inbox: {
      getThread: vi.fn(),
      prepareReply: vi.fn()
    },
    posts: {
      prepareCreate: vi.fn()
    }
  };

  return runtime as unknown as CoreRuntime & ScenarioRuntimeMocks;
}

function createAccount(
  overrides: Partial<WriteValidationAccount> = {}
): WriteValidationAccount {
  return {
    designation: "secondary",
    id: "secondary",
    label: "Secondary",
    profileName: "secondary-profile",
    sessionName: "secondary-session",
    targets: {
      "connections.send_invitation": {
        note: "Hello there",
        targetProfile: "https://www.linkedin.com/in/test-user/"
      },
      "feed.like_post": {
        postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
        reaction: "like"
      },
      "network.followup_after_accept": {
        profileUrlKey: "https://www.linkedin.com/in/test-user/"
      },
      "post.create": {
        visibility: "connections"
      },
      send_message: {
        participantPattern: "Test User",
        thread: "/messaging/thread/abc123/"
      }
    },
    ...overrides
  };
}

function getScenario(
  actionType: LinkedInWriteValidationActionType
): WriteValidationScenarioDefinition {
  const scenario = WRITE_VALIDATION_SCENARIOS.find(
    (candidate) => candidate.actionType === actionType
  );

  if (!scenario) {
    throw new Error(`Missing scenario for ${actionType}.`);
  }

  return scenario;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("writeValidationScenarios", () => {
  it("keeps the fixed write-action order and operator-facing metadata stable", () => {
    expect(LINKEDIN_WRITE_VALIDATION_ACTIONS).toMatchInlineSnapshot(`
      [
        {
          "actionType": "post.create",
          "expectedOutcome": "A new post is published successfully and visible in the feed.",
          "riskClass": "public",
          "summary": "Create a connections-only post and verify it appears in the feed.",
        },
        {
          "actionType": "connections.send_invitation",
          "expectedOutcome": "The approved profile shows a pending invitation or sent-invitation confirmation.",
          "riskClass": "network",
          "summary": "Send a connection invitation to the approved profile and verify it appears in sent invitations.",
        },
        {
          "actionType": "send_message",
          "expectedOutcome": "The outbound message is echoed in the approved conversation thread.",
          "riskClass": "private",
          "summary": "Send a message in the approved thread and verify the outbound message appears.",
        },
        {
          "actionType": "network.followup_after_accept",
          "expectedOutcome": "The follow-up send succeeds and local follow-up state records the confirmation.",
          "riskClass": "network",
          "summary": "Send the approved follow-up after an accepted connection and verify it records as sent.",
        },
        {
          "actionType": "feed.like_post",
          "expectedOutcome": "The approved reaction is active on the approved post.",
          "riskClass": "public",
          "summary": "React to the approved post and verify the reaction is registered.",
        },
      ]
    `);
  });

  it("prepares and verifies post creation against the published feed item", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T10:00:00.000Z"));

    const scenario = getScenario(CREATE_POST_ACTION_TYPE);
    const runtime = createRuntimeMock();
    const preparedAction = createPreparedAction({
      outbound: {
        text: "Quick validation update • 2026-03-09T10:00:00.000Z"
      },
      target: {}
    });

    runtime.posts.prepareCreate.mockResolvedValue(preparedAction);
    runtime.feed.viewPost.mockResolvedValue({
      text: "  Quick validation update • 2026-03-09T10:00:00.000Z  "
    });

    const prepared = await scenario.prepare(runtime, createAccount());
    const confirmed = {
      actionType: CREATE_POST_ACTION_TYPE,
      artifacts: [],
      preparedActionId: "prepared_123",
      result: {
        published_post_url: "https://www.linkedin.com/feed/update/urn:li:activity:987/"
      },
      status: "executed"
    };
    const verification = await scenario.verify(
      runtime,
      createAccount(),
      prepared,
      confirmed
    );

    expect(runtime.posts.prepareCreate).toHaveBeenCalledWith({
      operatorNote: "Tier 3 write-validation harness",
      profileName: "secondary-profile",
      text: "Quick validation update • 2026-03-09T10:00:00.000Z",
      visibility: "connections"
    });
    expect(prepared.beforeScreenshotUrl).toBe(WRITE_VALIDATION_FEED_URL);
    expect(prepared.verificationContext).toEqual({
      post_text: "Quick validation update • 2026-03-09T10:00:00.000Z",
      visibility: "connections"
    });
    expect(scenario.resolveAfterScreenshotUrl(createAccount(), prepared, confirmed)).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:987/"
    );
    expect(verification).toEqual({
      details: {
        observed_text: "  Quick validation update • 2026-03-09T10:00:00.000Z  ",
        post_url: "https://www.linkedin.com/feed/update/urn:li:activity:987/"
      },
      message: "Published post was re-observed in LinkedIn feed content.",
      source: "feed.viewPost",
      state_synced: null,
      verified: true
    });
  });

  it("reports a failed post verification when the publish result has no URL", async () => {
    const scenario = getScenario(CREATE_POST_ACTION_TYPE);
    const result = await scenario.verify(
      createRuntimeMock(),
      createAccount(),
      {
        beforeScreenshotUrl: WRITE_VALIDATION_FEED_URL,
        cleanupGuidance: [],
        prepared: createPreparedAction(),
        verificationContext: {
          post_text: "Quick validation update"
        }
      },
      {
        actionType: CREATE_POST_ACTION_TYPE,
        artifacts: [],
        preparedActionId: "prepared_123",
        result: {},
        status: "executed"
      }
    );

    expect(result).toEqual({
      details: {
        result: {}
      },
      message: "Post publish result did not include a published_post_url.",
      source: "post_publish_result",
      state_synced: null,
      verified: false
    });
  });

  it("uses approved invitation targets and matches pending invitations by vanity name", async () => {
    const scenario = getScenario(SEND_INVITATION_ACTION_TYPE);
    const runtime = createRuntimeMock();
    const preparedAction = createPreparedAction({
      outbound: {},
      target: {
        profile_url: "https://www.linkedin.com/in/test-user/"
      }
    });

    runtime.connections.prepareSendInvitation.mockReturnValue(preparedAction);
    runtime.connections.listPendingInvitations.mockResolvedValue([
      {
        invitation_sent_at: "2026-03-09T10:00:05.000Z",
        message: "Hello there",
        name: "Test User",
        profile_url: "https://www.linkedin.com/in/someone-else/",
        vanity_name: "test-user"
      }
    ]);
    runtime.db.getSentInvitationState.mockReturnValue({
      sent_at: "2026-03-09T10:00:04.000Z"
    });

    const prepared = await scenario.prepare(runtime, createAccount());
    const verification = await scenario.verify(
      runtime,
      createAccount(),
      prepared,
      {
        actionType: SEND_INVITATION_ACTION_TYPE,
        artifacts: [],
        preparedActionId: "prepared_123",
        result: {},
        status: "executed"
      }
    );

    expect(runtime.connections.prepareSendInvitation).toHaveBeenCalledWith({
      note: "Hello there",
      operatorNote: "Tier 3 write-validation harness",
      profileName: "secondary-profile",
      targetProfile: "https://www.linkedin.com/in/test-user/"
    });
    expect(prepared.beforeScreenshotUrl).toBe("https://www.linkedin.com/in/test-user/");
    expect(verification).toEqual({
      details: {
        matched_invitation: {
          invitation_sent_at: "2026-03-09T10:00:05.000Z",
          message: "Hello there",
          name: "Test User",
          profile_url: "https://www.linkedin.com/in/someone-else/",
          vanity_name: "test-user"
        },
        state_synced: true,
        target_profile: "https://www.linkedin.com/in/test-user/"
      },
      message: "Sent invitation was re-observed in the pending sent-invitations list.",
      source: "connections.listPendingInvitations",
      state_synced: true,
      verified: true
    });
  });

  it("rejects missing approved invitation targets", async () => {
    const scenario = getScenario(SEND_INVITATION_ACTION_TYPE);
    const runtime = createRuntimeMock();
    const account = createAccount({
      targets: {}
    });

    await expect(scenario.prepare(runtime, account)).rejects.toThrow(
      'Write-validation account "secondary" is missing targets.connections.send_invitation in config.json.'
    );
  });

  it("rejects missing approved messaging targets", async () => {
    const scenario = getScenario(SEND_MESSAGE_ACTION_TYPE);
    const runtime = createRuntimeMock();
    const account = createAccount({
      targets: {
        ...createAccount().targets,
        send_message: undefined
      }
    });

    await expect(scenario.prepare(runtime, account)).rejects.toThrow(
      'Write-validation account "secondary" is missing targets.send_message in config.json.'
    );
    expect(runtime.inbox.prepareReply).not.toHaveBeenCalled();
  });

  it("verifies sent messages using the most recent non-empty thread message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T10:00:00.000Z"));

    const scenario = getScenario(SEND_MESSAGE_ACTION_TYPE);
    const runtime = createRuntimeMock();
    runtime.inbox.prepareReply.mockResolvedValue(createPreparedAction());
    runtime.inbox.getThread.mockResolvedValue({
      messages: [
        { text: "Older message" },
        { text: "   " },
        { text: "  Quick validation ping • 2026-03-09T10:00:00.000Z  " }
      ],
      thread_id: "abc123"
    });

    const prepared = await scenario.prepare(runtime, createAccount());
    const verification = await scenario.verify(
      runtime,
      createAccount(),
      prepared,
      {
        actionType: SEND_MESSAGE_ACTION_TYPE,
        artifacts: [],
        preparedActionId: "prepared_123",
        result: {},
        status: "executed"
      }
    );

    expect(runtime.inbox.prepareReply).toHaveBeenCalledWith({
      operatorNote: "Tier 3 write-validation harness",
      profileName: "secondary-profile",
      text: "Quick validation ping • 2026-03-09T10:00:00.000Z",
      thread: "/messaging/thread/abc123/"
    });
    expect(scenario.resolveAfterScreenshotUrl(createAccount(), prepared, {
      actionType: SEND_MESSAGE_ACTION_TYPE,
      artifacts: [],
      preparedActionId: "prepared_123",
      result: {},
      status: "executed"
    })).toBe("https://www.linkedin.com/messaging/thread/abc123/");
    expect(verification).toEqual({
      details: {
        expected_text: "Quick validation ping • 2026-03-09T10:00:00.000Z",
        recent_message_text: "Quick validation ping • 2026-03-09T10:00:00.000Z",
        thread_id: "abc123"
      },
      message: "Sent message was re-observed in the approved conversation thread.",
      source: "inbox.getThread",
      state_synced: null,
      verified: true
    });
  });

  it("requires a prepared follow-up and keeps missing confirmation state unsynced", async () => {
    const scenario = getScenario(FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE);
    const runtime = createRuntimeMock();

    runtime.followups.prepareFollowupForAcceptedConnection.mockResolvedValue(null);

    await expect(scenario.prepare(runtime, createAccount())).rejects.toThrow(
      "No accepted connection follow-up could be prepared for https://www.linkedin.com/in/test-user/."
    );

    const prepared: ScenarioPrepareResult = {
      beforeScreenshotUrl: "https://www.linkedin.com/in/test-user/",
      cleanupGuidance: [],
      prepared: createPreparedAction(),
      verificationContext: {
        profile_url_key: "https://www.linkedin.com/in/test-user/"
      }
    };
    runtime.db.getSentInvitationState.mockReturnValue(undefined);

    const verification = await scenario.verify(
      runtime,
      createAccount(),
      prepared,
      {
        actionType: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
        artifacts: [],
        preparedActionId: "prepared_123",
        result: {
          sent: true
        },
        status: "executed"
      }
    );

    expect(verification).toEqual({
      details: {
        confirm_result: {
          sent: true
        },
        followup_confirmed_at: null,
        profile_url_key: "https://www.linkedin.com/in/test-user/"
      },
      message: "Follow-up send returned a positive message-echo confirmation.",
      source: "followups.confirm_result",
      state_synced: false,
      verified: true
    });
  });

  it("normalizes approved reactions and reflects executor confirmation", async () => {
    const scenario = getScenario(LIKE_POST_ACTION_TYPE);
    const runtime = createRuntimeMock();
    runtime.feed.prepareLikePost.mockReturnValue(createPreparedAction());

    const prepared = await scenario.prepare(
      runtime,
      createAccount({
        targets: {
          ...createAccount().targets,
          "feed.like_post": {
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
            reaction: undefined
          }
        }
      })
    );
    const verification = await scenario.verify(
      runtime,
      createAccount(),
      prepared,
      {
        actionType: LIKE_POST_ACTION_TYPE,
        artifacts: [],
        preparedActionId: "prepared_123",
        result: {
          reacted: false,
          reaction: "like"
        },
        status: "executed"
      }
    );

    expect(runtime.feed.prepareLikePost).toHaveBeenCalledWith({
      operatorNote: "Tier 3 write-validation harness",
      postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
      profileName: "secondary-profile",
      reaction: "like"
    });
    expect(scenario.resolveAfterScreenshotUrl(createAccount(), prepared, {
      actionType: LIKE_POST_ACTION_TYPE,
      artifacts: [],
      preparedActionId: "prepared_123",
      result: {},
      status: "executed"
    })).toBe("https://www.linkedin.com/feed/update/urn:li:activity:123/");
    expect(verification).toEqual({
      details: {
        confirm_result: {
          reacted: false,
          reaction: "like"
        },
        reaction: "like"
      },
      message: "Reaction executor did not report the target reaction as active after confirmation.",
      source: "feed.like_post.confirm_result",
      state_synced: null,
      verified: false
    });
  });
});
