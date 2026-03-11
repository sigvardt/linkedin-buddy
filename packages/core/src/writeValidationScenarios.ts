import { LinkedInBuddyError } from "./errors.js";
import {
  LIKE_POST_ACTION_TYPE,
  normalizeLinkedInFeedReaction,
  type LinkedInFeedReaction
} from "./linkedinFeed.js";
import {
  SEND_INVITATION_ACTION_TYPE,
  type LinkedInPendingInvitation
} from "./linkedinConnections.js";
import { FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE } from "./linkedinFollowups.js";
import {
  normalizeLinkedInProfileUrl,
  resolveProfileUrl
} from "./linkedinProfile.js";
import {
  CREATE_POST_ACTION_TYPE,
  normalizeLinkedInPostVisibility
} from "./linkedinPosts.js";
import type {
  LinkedInWriteValidationActionDefinition,
  ScenarioPrepareResult,
  WriteValidationScenarioDefinition
} from "./writeValidationShared.js";
import {
  SEND_MESSAGE_ACTION_TYPE,
  WRITE_VALIDATION_FEED_URL
} from "./writeValidationShared.js";
import type { WriteValidationAccountTargets } from "./writeValidationAccounts.js";

const WRITE_VALIDATION_OPERATOR_NOTE = "Tier 3 write-validation harness";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function createWriteValidationTag(): string {
  return new Date().toISOString();
}

function buildWriteValidationPostText(): string {
  return `Quick validation update • ${createWriteValidationTag()}`;
}

function buildWriteValidationMessageText(): string {
  return `Quick validation ping • ${createWriteValidationTag()}`;
}

function resolveThreadUrl(thread: string): string {
  const trimmedThread = thread.trim();
  if (!trimmedThread) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Thread identifier is required."
    );
  }

  if (/^https?:\/\//iu.test(trimmedThread)) {
    const parsedUrl = new URL(trimmedThread);
    return `${parsedUrl.origin}${parsedUrl.pathname}${parsedUrl.search}`.replace(
      /\/$/u,
      "/"
    );
  }

  if (trimmedThread.startsWith("/messaging/thread/")) {
    return `https://www.linkedin.com${trimmedThread}`;
  }

  return `https://www.linkedin.com/messaging/thread/${encodeURIComponent(trimmedThread)}/`;
}

function getRequiredTarget<T>(
  targets: WriteValidationAccountTargets,
  actionType: keyof WriteValidationAccountTargets,
  accountId: string
): T {
  const target = targets[actionType];
  if (target !== undefined) {
    return target as T;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `Write-validation account "${accountId}" is missing targets.${String(actionType)} in config.json.`,
    {
      account_id: accountId,
      missing_target_key: actionType
    }
  );
}

function matchPendingInvitation(
  invitations: LinkedInPendingInvitation[],
  targetProfile: string
): LinkedInPendingInvitation | null {
  const normalizedTargetProfile = normalizeLinkedInProfileUrl(
    resolveProfileUrl(targetProfile)
  );
  const targetSlug =
    /\/in\/([^/?#]+)/u.exec(normalizedTargetProfile)?.[1] ?? null;

  for (const invitation of invitations) {
    const normalizedInvitationProfile = normalizeLinkedInProfileUrl(
      resolveProfileUrl(invitation.profile_url)
    );

    if (normalizedInvitationProfile === normalizedTargetProfile) {
      return invitation;
    }

    if (
      targetSlug !== null &&
      typeof invitation.vanity_name === "string" &&
      invitation.vanity_name.trim().toLowerCase() === targetSlug.toLowerCase()
    ) {
      return invitation;
    }
  }

  return null;
}

function extractRecentMessageText(messages: readonly { text: string }[]): string | null {
  const lastMessage = [...messages]
    .reverse()
    .find((message) => normalizeText(message.text).length > 0);
  return lastMessage ? normalizeText(lastMessage.text) : null;
}

/** Fixed write-validation scenarios executed by the Tier 3 harness in order. */
export const WRITE_VALIDATION_SCENARIOS = [
  {
    actionType: CREATE_POST_ACTION_TYPE,
    summary:
      "Create a connections-only post and verify it appears in the feed.",
    expectedOutcome:
      "A new post is published successfully and visible in the feed.",
    riskClass: "public",
    validateConfig(account) {
      void normalizeLinkedInPostVisibility(
        account.targets["post.create"]?.visibility,
        "connections"
      );
    },
    async prepare(runtime, account) {
      const visibility = normalizeLinkedInPostVisibility(
        account.targets["post.create"]?.visibility,
        "connections"
      );
      const text = buildWriteValidationPostText();
      const prepared = await runtime.posts.prepareCreate({
        profileName: account.profileName,
        text,
        visibility,
        operatorNote: WRITE_VALIDATION_OPERATOR_NOTE
      });

      return {
        prepared,
        beforeScreenshotUrl: WRITE_VALIDATION_FEED_URL,
        cleanupGuidance: [
          "Delete the validation post manually after review if you do not want it to remain in the feed."
        ],
        verificationContext: {
          post_text: text,
          visibility
        }
      } satisfies ScenarioPrepareResult;
    },
    resolveAfterScreenshotUrl(_account, _prepared, confirmed) {
      const publishedPostUrl = confirmed.result.published_post_url;
      return typeof publishedPostUrl === "string"
        ? publishedPostUrl
        : WRITE_VALIDATION_FEED_URL;
    },
    async verify(runtime, account, prepared, confirmed) {
      const publishedPostUrl = confirmed.result.published_post_url;
      const expectedText =
        typeof prepared.verificationContext.post_text === "string"
          ? prepared.verificationContext.post_text
          : "";

      if (typeof publishedPostUrl !== "string") {
        return {
          verified: false,
          state_synced: null,
          source: "post_publish_result",
          message: "Post publish result did not include a published_post_url.",
          details: {
            result: confirmed.result
          }
        };
      }

      const post = await runtime.feed.viewPost({
        profileName: account.profileName,
        postUrl: publishedPostUrl
      });

      const verified = normalizeText(post.text).includes(normalizeText(expectedText));

      return {
        verified,
        state_synced: null,
        source: "feed.viewPost",
        message: verified
          ? "Published post was re-observed in LinkedIn feed content."
          : "Published post could not be matched by text in the feed after confirmation.",
        details: {
          post_url: publishedPostUrl,
          observed_text: post.text
        }
      };
    }
  },
  {
    actionType: SEND_INVITATION_ACTION_TYPE,
    summary:
      "Send a connection invitation to the approved profile and verify it appears in sent invitations.",
    expectedOutcome:
      "The approved profile shows a pending invitation or sent-invitation confirmation.",
    riskClass: "network",
    validateConfig(account) {
      void getRequiredTarget<{
        note?: string;
        targetProfile: string;
      }>(account.targets, "connections.send_invitation", account.id);
    },
    async prepare(runtime, account) {
      const target = getRequiredTarget<{
        note?: string;
        targetProfile: string;
      }>(account.targets, "connections.send_invitation", account.id);

      const prepared = runtime.connections.prepareSendInvitation({
        profileName: account.profileName,
        targetProfile: target.targetProfile,
        ...(target.note ? { note: target.note } : {}),
        operatorNote: WRITE_VALIDATION_OPERATOR_NOTE
      });

      return {
        prepared,
        beforeScreenshotUrl: resolveProfileUrl(target.targetProfile),
        cleanupGuidance: [
          "Withdraw the validation invitation manually after review if the recipient should not keep it pending."
        ],
        verificationContext: {
          target_profile: target.targetProfile
        }
      } satisfies ScenarioPrepareResult;
    },
    resolveAfterScreenshotUrl(_account, prepared) {
      const targetProfile = prepared.verificationContext.target_profile;
      return typeof targetProfile === "string"
        ? resolveProfileUrl(targetProfile)
        : null;
    },
    async verify(runtime, account, prepared) {
      const targetProfile = prepared.verificationContext.target_profile;
      if (typeof targetProfile !== "string") {
        return {
          verified: false,
          state_synced: false,
          source: "connections.listPendingInvitations",
          message: "Connection target profile was missing from the verification context.",
          details: {}
        };
      }

      const invitations = await runtime.connections.listPendingInvitations({
        profileName: account.profileName,
        filter: "sent"
      });
      const matchedInvitation = matchPendingInvitation(invitations, targetProfile);
      const stateRow = runtime.db.getSentInvitationState({
        profileName: account.profileName,
        profileUrlKey: normalizeLinkedInProfileUrl(resolveProfileUrl(targetProfile))
      });

      return {
        verified: matchedInvitation !== null,
        state_synced: stateRow !== undefined,
        source: "connections.listPendingInvitations",
        message:
          matchedInvitation !== null
            ? "Sent invitation was re-observed in the pending sent-invitations list."
            : "Sent invitation could not be re-observed in the pending sent-invitations list.",
        details: {
          target_profile: targetProfile,
          matched_invitation: matchedInvitation,
          state_synced: stateRow !== undefined
        }
      };
    }
  },
  {
    actionType: SEND_MESSAGE_ACTION_TYPE,
    summary:
      "Send a message in the approved thread and verify the outbound message appears.",
    expectedOutcome:
      "The outbound message is echoed in the approved conversation thread.",
    riskClass: "private",
    validateConfig(account) {
      const target = getRequiredTarget<{
        participantPattern?: string;
        thread: string;
      }>(account.targets, "send_message", account.id);
      void resolveThreadUrl(target.thread);
    },
    async prepare(runtime, account) {
      const target = getRequiredTarget<{
        participantPattern?: string;
        thread: string;
      }>(account.targets, "send_message", account.id);
      const text = buildWriteValidationMessageText();

      const prepared = await runtime.inbox.prepareReply({
        profileName: account.profileName,
        thread: target.thread,
        text,
        operatorNote: WRITE_VALIDATION_OPERATOR_NOTE
      });

      return {
        prepared,
        beforeScreenshotUrl: resolveThreadUrl(target.thread),
        cleanupGuidance: [],
        verificationContext: {
          message_text: text,
          participant_pattern: target.participantPattern,
          thread: target.thread
        }
      } satisfies ScenarioPrepareResult;
    },
    resolveAfterScreenshotUrl(_account, prepared) {
      const thread = prepared.verificationContext.thread;
      return typeof thread === "string" ? resolveThreadUrl(thread) : null;
    },
    async verify(runtime, account, prepared) {
      const expectedText = prepared.verificationContext.message_text;
      const thread = prepared.verificationContext.thread;

      if (typeof expectedText !== "string" || typeof thread !== "string") {
        return {
          verified: false,
          state_synced: null,
          source: "inbox.getThread",
          message: "Message verification context was incomplete.",
          details: {}
        };
      }

      const detail = await runtime.inbox.getThread({
        profileName: account.profileName,
        thread,
        limit: 8
      });
      const recentMessageText = extractRecentMessageText(detail.messages);
      const verified = recentMessageText === normalizeText(expectedText);

      return {
        verified,
        state_synced: null,
        source: "inbox.getThread",
        message: verified
          ? "Sent message was re-observed in the approved conversation thread."
          : "Sent message was not found as the most recent thread message after confirmation.",
        details: {
          thread_id: detail.thread_id,
          recent_message_text: recentMessageText,
          expected_text: expectedText
        }
      };
    }
  },
  {
    actionType: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
    summary:
      "Send the approved follow-up after an accepted connection and verify it records as sent.",
    expectedOutcome:
      "The follow-up send succeeds and local follow-up state records the confirmation.",
    riskClass: "network",
    validateConfig(account) {
      void getRequiredTarget<{
        profileUrlKey: string;
      }>(account.targets, "network.followup_after_accept", account.id);
    },
    async prepare(runtime, account) {
      const target = getRequiredTarget<{
        profileUrlKey: string;
      }>(account.targets, "network.followup_after_accept", account.id);

      const preparedFollowup =
        await runtime.followups.prepareFollowupForAcceptedConnection({
          profileName: account.profileName,
          profileUrlKey: target.profileUrlKey,
          refreshState: true,
          operatorNote: WRITE_VALIDATION_OPERATOR_NOTE
        });

      if (!preparedFollowup) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          `No accepted connection follow-up could be prepared for ${target.profileUrlKey}.`,
          {
            account_id: account.id,
            profile_name: account.profileName,
            profile_url_key: target.profileUrlKey
          }
        );
      }

      return {
        prepared: {
          preparedActionId: preparedFollowup.preparedActionId,
          confirmToken: preparedFollowup.confirmToken,
          expiresAtMs: preparedFollowup.expiresAtMs,
          preview: preparedFollowup.preview
        },
        beforeScreenshotUrl: resolveProfileUrl(target.profileUrlKey),
        cleanupGuidance: [],
        verificationContext: {
          profile_url_key: target.profileUrlKey
        }
      } satisfies ScenarioPrepareResult;
    },
    resolveAfterScreenshotUrl(_account, prepared, confirmed) {
      const profileUrl = confirmed.result.profile_url;
      if (typeof profileUrl === "string") {
        return resolveProfileUrl(profileUrl);
      }

      const profileUrlKey = prepared.verificationContext.profile_url_key;
      return typeof profileUrlKey === "string"
        ? resolveProfileUrl(profileUrlKey)
        : null;
    },
    async verify(runtime, account, prepared, confirmed) {
      const profileUrlKey = prepared.verificationContext.profile_url_key;
      if (typeof profileUrlKey !== "string") {
        return {
          verified: false,
          state_synced: false,
          source: "followups.confirm_result",
          message: "Follow-up verification context was incomplete.",
          details: {}
        };
      }

      const stateRow = runtime.db.getSentInvitationState({
        profileName: account.profileName,
        profileUrlKey
      });

      return {
        verified: confirmed.result.sent === true,
        state_synced: stateRow?.followup_confirmed_at != null,
        source: "followups.confirm_result",
        message:
          confirmed.result.sent === true
            ? "Follow-up send returned a positive message-echo confirmation."
            : "Follow-up send did not report a positive message-echo confirmation.",
        details: {
          profile_url_key: profileUrlKey,
          followup_confirmed_at: stateRow?.followup_confirmed_at ?? null,
          confirm_result: confirmed.result
        }
      };
    }
  },
  {
    actionType: LIKE_POST_ACTION_TYPE,
    summary:
      "React to the approved post and verify the reaction is registered.",
    expectedOutcome: "The approved reaction is active on the approved post.",
    riskClass: "public",
    validateConfig(account) {
      const target = getRequiredTarget<{
        postUrl: string;
        reaction?: LinkedInFeedReaction;
      }>(account.targets, "feed.like_post", account.id);
      void normalizeLinkedInFeedReaction(target.reaction, "like");
    },
    async prepare(runtime, account) {
      const target = getRequiredTarget<{
        postUrl: string;
        reaction?: LinkedInFeedReaction;
      }>(account.targets, "feed.like_post", account.id);
      const reaction = normalizeLinkedInFeedReaction(target.reaction, "like");

      const prepared = runtime.feed.prepareLikePost({
        profileName: account.profileName,
        postUrl: target.postUrl,
        reaction,
        operatorNote: WRITE_VALIDATION_OPERATOR_NOTE
      });

      return {
        prepared,
        beforeScreenshotUrl: target.postUrl,
        cleanupGuidance: [
          "Remove the validation reaction manually after review if you do not want it to remain on the post."
        ],
        verificationContext: {
          post_url: target.postUrl,
          reaction
        }
      } satisfies ScenarioPrepareResult;
    },
    resolveAfterScreenshotUrl(_account, prepared) {
      const postUrl = prepared.verificationContext.post_url;
      return typeof postUrl === "string" ? postUrl : null;
    },
    async verify(_runtime, _account, _prepared, confirmed) {
      const reaction = confirmed.result.reaction;
      const verified = confirmed.result.reacted === true;

      return {
        verified,
        state_synced: null,
        source: "feed.like_post.confirm_result",
        message: verified
          ? "Reaction executor reported the target reaction as active after confirmation."
          : "Reaction executor did not report the target reaction as active after confirmation.",
        details: {
          confirm_result: confirmed.result,
          reaction
        }
      };
    }
  }
] satisfies readonly WriteValidationScenarioDefinition[];

/** Public metadata projection derived from the full scenario implementations. */
export const LINKEDIN_WRITE_VALIDATION_ACTIONS: readonly LinkedInWriteValidationActionDefinition[] =
  WRITE_VALIDATION_SCENARIOS.map(
    ({ actionType, expectedOutcome, riskClass, summary }) => ({
      actionType,
      expectedOutcome,
      riskClass,
      summary
    })
  );
