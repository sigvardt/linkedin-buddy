import { describe, expect, it } from "vitest";
import { AssistantDatabase } from "../src/index.js";

describe("sent invitation state", () => {
  it("tracks acceptance and follow-up lifecycle", () => {
    const db = new AssistantDatabase(":memory:");

    db.upsertSentInvitationState({
      profileName: "default",
      profileUrlKey: "https://www.linkedin.com/in/jane-doe/",
      vanityName: "jane-doe",
      fullName: "Jane Doe",
      headline: "Engineer",
      profileUrl: "https://www.linkedin.com/in/jane-doe/",
      firstSeenSentAtMs: 1_000,
      lastSeenSentAtMs: 1_000,
      createdAtMs: 1_000,
      updatedAtMs: 1_000
    });

    db.upsertSentInvitationState({
      profileName: "default",
      profileUrlKey: "https://www.linkedin.com/in/jane-doe/",
      vanityName: "jane-doe",
      fullName: "Jane Doe",
      headline: "Principal Engineer",
      profileUrl: "https://www.linkedin.com/in/jane-doe/",
      firstSeenSentAtMs: 2_000,
      lastSeenSentAtMs: 2_000,
      createdAtMs: 2_000,
      updatedAtMs: 2_000
    });

    const candidates = db.listSentInvitationAcceptanceCandidates({
      profileName: "default",
      lastSeenBeforeMs: 2_500
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.first_seen_sent_at).toBe(1_000);
    expect(candidates[0]?.last_seen_sent_at).toBe(2_000);
    expect(candidates[0]?.headline).toBe("Principal Engineer");

    db.markSentInvitationAccepted({
      profileName: "default",
      profileUrlKey: "https://www.linkedin.com/in/jane-doe/",
      vanityName: "jane-doe",
      fullName: "Jane Doe",
      headline: "Principal Engineer",
      profileUrl: "https://www.linkedin.com/in/jane-doe/",
      acceptedAtMs: 3_000,
      acceptedDetection: "profile_message_button",
      updatedAtMs: 3_000
    });

    db.markSentInvitationFollowupPrepared({
      profileName: "default",
      profileUrlKey: "https://www.linkedin.com/in/jane-doe/",
      preparedAtMs: 4_000,
      preparedActionId: "pa_123",
      updatedAtMs: 4_000
    });

    db.markSentInvitationFollowupConfirmed({
      profileName: "default",
      profileUrlKey: "https://www.linkedin.com/in/jane-doe/",
      preparedActionId: "pa_123",
      confirmedAtMs: 5_000,
      updatedAtMs: 5_000
    });

    const acceptedRows = db.listAcceptedSentInvitations({
      profileName: "default",
      sinceMs: 0
    });

    expect(acceptedRows).toHaveLength(1);
    expect(acceptedRows[0]?.accepted_at).toBe(3_000);
    expect(acceptedRows[0]?.accepted_detection).toBe("profile_message_button");
    expect(acceptedRows[0]?.followup_prepared_action_id).toBe("pa_123");
    expect(acceptedRows[0]?.followup_confirmed_at).toBe(5_000);

    db.close();
  });

  it("closes non-accepted invitations so they stop reappearing", () => {
    const db = new AssistantDatabase(":memory:");

    db.upsertSentInvitationState({
      profileName: "default",
      profileUrlKey: "https://www.linkedin.com/in/john-smith/",
      vanityName: "john-smith",
      fullName: "John Smith",
      headline: "Designer",
      profileUrl: "https://www.linkedin.com/in/john-smith/",
      firstSeenSentAtMs: 1_000,
      lastSeenSentAtMs: 1_000,
      createdAtMs: 1_000,
      updatedAtMs: 1_000
    });

    db.markSentInvitationClosed({
      profileName: "default",
      profileUrlKey: "https://www.linkedin.com/in/john-smith/",
      closedAtMs: 2_000,
      closedReason: "not_accepted",
      updatedAtMs: 2_000
    });

    const candidates = db.listSentInvitationAcceptanceCandidates({
      profileName: "default",
      lastSeenBeforeMs: 3_000
    });
    const acceptedRows = db.listAcceptedSentInvitations({
      profileName: "default",
      sinceMs: 0
    });

    expect(candidates).toHaveLength(0);
    expect(acceptedRows).toHaveLength(0);

    db.close();
  });
});
