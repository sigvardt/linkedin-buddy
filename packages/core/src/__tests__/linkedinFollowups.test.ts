import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantDatabase } from "../db/database.js";
import {
  DEFAULT_FOLLOWUP_LOOKBACK_MS,
  FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
  LinkedInFollowupsService,
  buildDefaultFollowupText,
  createFollowupActionExecutors,
  resolveFollowupSinceWindow,
  type LinkedInAcceptedConnection,
  type LinkedInFollowupsRuntime,
  type PreparedAcceptedConnectionFollowup
} from "../linkedinFollowups.js";
import { RateLimiter } from "../rateLimiter.js";
import { TwoPhaseCommitService } from "../twoPhaseCommit.js";

const FIXED_NOW = new Date("2026-03-08T12:00:00Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createTestRuntime(db: AssistantDatabase): LinkedInFollowupsRuntime {
  return {
    db,
    auth: {
      ensureAuthenticated: vi.fn(async () => undefined)
    },
    cdpUrl: undefined,
    profileManager: {
      runWithContext: vi.fn()
    },
    artifacts: {
      resolve: vi.fn((relativePath: string) => relativePath),
      registerArtifact: vi.fn()
    },
    rateLimiter: new RateLimiter(db),
    logger: {
      log: vi.fn()
    },
    connections: {
      listPendingInvitations: vi.fn(async () => [])
    },
    twoPhaseCommit: new TwoPhaseCommitService(db)
  } as unknown as LinkedInFollowupsRuntime;
}

function seedAcceptedInvitation(input: {
  db: AssistantDatabase;
  profileName: string;
  profileUrl: string;
  vanityName: string | null;
  fullName: string;
  headline: string;
  firstSeenSentAtMs: number;
  lastSeenSentAtMs: number;
  acceptedAtMs: number;
  acceptedDetection?: string;
}): void {
  input.db.upsertSentInvitationState({
    profileName: input.profileName,
    profileUrlKey: input.profileUrl,
    vanityName: input.vanityName,
    fullName: input.fullName,
    headline: input.headline,
    profileUrl: input.profileUrl,
    firstSeenSentAtMs: input.firstSeenSentAtMs,
    lastSeenSentAtMs: input.lastSeenSentAtMs,
    createdAtMs: input.firstSeenSentAtMs,
    updatedAtMs: input.lastSeenSentAtMs
  });

  const updated = input.db.markSentInvitationAccepted({
    profileName: input.profileName,
    profileUrlKey: input.profileUrl,
    vanityName: input.vanityName,
    fullName: input.fullName,
    headline: input.headline,
    profileUrl: input.profileUrl,
    acceptedAtMs: input.acceptedAtMs,
    acceptedDetection: input.acceptedDetection ?? "topcard-message-role",
    updatedAtMs: input.acceptedAtMs
  });

  expect(updated).toBe(true);
}

function seedPreparedFollowup(input: {
  db: AssistantDatabase;
  profileName: string;
  profileUrl: string;
  fullName: string;
  preparedAtMs: number;
  confirmAtMs?: number;
}): { preparedActionId: string; expiresAtMs: number } {
  const twoPhaseCommit = new TwoPhaseCommitService(input.db);
  const prepared = twoPhaseCommit.prepare({
    actionType: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
    target: {
      profile_name: input.profileName,
      profile_url_key: input.profileUrl,
      target_profile_url: input.profileUrl,
      full_name: input.fullName
    },
    payload: {
      text: `Hi ${input.fullName}`
    },
    preview: {
      summary: `Follow up with ${input.fullName}`
    },
    nowMs: input.preparedAtMs
  });

  const markedPrepared = input.db.markSentInvitationFollowupPrepared({
    profileName: input.profileName,
    profileUrlKey: input.profileUrl,
    preparedAtMs: input.preparedAtMs,
    preparedActionId: prepared.preparedActionId,
    updatedAtMs: input.preparedAtMs
  });
  expect(markedPrepared).toBe(true);

  if (input.confirmAtMs !== undefined) {
    const markedConfirmed = input.db.markSentInvitationFollowupConfirmed({
      profileName: input.profileName,
      profileUrlKey: input.profileUrl,
      confirmedAtMs: input.confirmAtMs,
      preparedActionId: prepared.preparedActionId,
      updatedAtMs: input.confirmAtMs
    });
    expect(markedConfirmed).toBe(true);
  }

  return {
    preparedActionId: prepared.preparedActionId,
    expiresAtMs: prepared.expiresAtMs
  };
}

describe("follow-up helpers", () => {
  it("builds a short default follow-up message", () => {
    expect(buildDefaultFollowupText("Jane Doe")).toBe(
      "Hi Jane, thanks for accepting my invitation. Great to connect."
    );
    expect(buildDefaultFollowupText("")).toBe(
      "Hi, thanks for accepting my invitation. Great to connect."
    );
  });

  it("parses relative since windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const resolved = resolveFollowupSinceWindow("48h");

    expect(resolved.since).toBe("48h");
    expect(resolved.sinceMs).toBe(FIXED_NOW.getTime() - 48 * 60 * 60 * 1000);
  });

  it("uses a one-week default lookback", () => {
    expect(DEFAULT_FOLLOWUP_LOOKBACK_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("createFollowupActionExecutors", () => {
  it("registers the accepted-followup executor", () => {
    const executors = createFollowupActionExecutors();

    expect(Object.keys(executors)).toEqual([FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE]);
    expect(typeof executors[FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE]?.execute).toBe(
      "function"
    );
  });
});

describe("LinkedInFollowupsService", () => {
  it("lists accepted connections with follow-up status metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const db = new AssistantDatabase(":memory:");

    try {
      seedAcceptedInvitation({
        db,
        profileName: "default",
        profileUrl: "https://www.linkedin.com/in/jane-doe/",
        vanityName: "jane-doe",
        fullName: "Jane Doe",
        headline: "Product Manager",
        firstSeenSentAtMs: FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
        lastSeenSentAtMs: FIXED_NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
        acceptedAtMs: FIXED_NOW.getTime() - 12 * 60 * 60 * 1000
      });

      const prepared = seedPreparedFollowup({
        db,
        profileName: "default",
        profileUrl: "https://www.linkedin.com/in/jane-doe/",
        fullName: "Jane Doe",
        preparedAtMs: FIXED_NOW.getTime() - 10 * 60 * 1000
      });

      const runtime = createTestRuntime(db);
      const service = new LinkedInFollowupsService(runtime);
      vi.spyOn(
        service as unknown as { refreshAcceptanceState: () => Promise<void> },
        "refreshAcceptanceState"
      ).mockResolvedValue(undefined);

      const acceptedConnections = await service.listAcceptedConnections({
        profileName: "default",
        since: "7d"
      });

      expect(acceptedConnections).toHaveLength(1);
      expect(acceptedConnections[0]).toMatchObject({
        profile_url: "https://www.linkedin.com/in/jane-doe/",
        vanity_name: "jane-doe",
        full_name: "Jane Doe",
        accepted_detection: "topcard-message-role",
        followup_status: "prepared",
        followup_prepared_action_id: prepared.preparedActionId,
        followup_expires_at_ms: prepared.expiresAtMs
      });
    } finally {
      db.close();
    }
  });

  it("prepares follow-ups only for accepted connections that still need one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const db = new AssistantDatabase(":memory:");

    try {
      seedAcceptedInvitation({
        db,
        profileName: "default",
        profileUrl: "https://www.linkedin.com/in/jane-doe/",
        vanityName: "jane-doe",
        fullName: "Jane Doe",
        headline: "Product Manager",
        firstSeenSentAtMs: FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
        lastSeenSentAtMs: FIXED_NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
        acceptedAtMs: FIXED_NOW.getTime() - 12 * 60 * 60 * 1000
      });

      seedAcceptedInvitation({
        db,
        profileName: "default",
        profileUrl: "https://www.linkedin.com/in/bob-smith/",
        vanityName: "bob-smith",
        fullName: "Bob Smith",
        headline: "Engineer",
        firstSeenSentAtMs: FIXED_NOW.getTime() - 4 * 24 * 60 * 60 * 1000,
        lastSeenSentAtMs: FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
        acceptedAtMs: FIXED_NOW.getTime() - 24 * 60 * 60 * 1000
      });

      seedPreparedFollowup({
        db,
        profileName: "default",
        profileUrl: "https://www.linkedin.com/in/bob-smith/",
        fullName: "Bob Smith",
        preparedAtMs: FIXED_NOW.getTime() - 23 * 60 * 60 * 1000,
        confirmAtMs: FIXED_NOW.getTime() - 22 * 60 * 60 * 1000
      });

      const runtime = createTestRuntime(db);
      const service = new LinkedInFollowupsService(runtime);
      vi.spyOn(
        service as unknown as { refreshAcceptanceState: () => Promise<void> },
        "refreshAcceptanceState"
      ).mockResolvedValue(undefined);

      const preparedFollowup: PreparedAcceptedConnectionFollowup = {
        connection: {
          profile_url_key: "https://www.linkedin.com/in/jane-doe/",
          profile_url: "https://www.linkedin.com/in/jane-doe/",
          vanity_name: "jane-doe",
          full_name: "Jane Doe",
          headline: "Product Manager",
          first_seen_sent_at_ms: FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
          last_seen_sent_at_ms: FIXED_NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
          accepted_at_ms: FIXED_NOW.getTime() - 12 * 60 * 60 * 1000,
          accepted_detection: "topcard-message-role",
          followup_status: "prepared",
          followup_prepared_action_id: "pa_followup_jane",
          followup_prepared_at_ms: FIXED_NOW.getTime(),
          followup_confirmed_at_ms: null,
          followup_expires_at_ms: FIXED_NOW.getTime() + 30 * 60 * 1000
        },
        preparedActionId: "pa_followup_jane",
        confirmToken: "ct_followup_jane",
        expiresAtMs: FIXED_NOW.getTime() + 30 * 60 * 1000,
        preview: {
          summary: "Send accepted-connection follow-up to Jane Doe"
        }
      };

      const prepareSpy = vi.spyOn(
        service as unknown as {
          prepareAcceptedConnections: (
            profileName: string,
            connections: LinkedInAcceptedConnection[]
          ) => Promise<PreparedAcceptedConnectionFollowup[]>;
        },
        "prepareAcceptedConnections"
      ).mockResolvedValue([preparedFollowup]);

      const result = await service.prepareFollowupsAfterAccept({
        profileName: "default",
        sinceMs: DEFAULT_FOLLOWUP_LOOKBACK_MS
      });

      expect(prepareSpy).toHaveBeenCalledTimes(1);
      const prepareCandidates = prepareSpy.mock.calls[0]?.[1] as
        | LinkedInAcceptedConnection[]
        | undefined;
      expect(prepareCandidates?.map((candidate) => candidate.full_name)).toEqual([
        "Jane Doe"
      ]);

      expect(result.preparedFollowups).toEqual([preparedFollowup]);
      expect(result.acceptedConnections).toHaveLength(2);
      expect(
        result.acceptedConnections.find(
          (connection) => connection.full_name === "Jane Doe"
        )?.followup_status
      ).toBe("prepared");
      expect(
        result.acceptedConnections.find(
          (connection) => connection.full_name === "Bob Smith"
        )?.followup_status
      ).toBe("executed");
    } finally {
      db.close();
    }
  });

  it("prepares a single accepted-connection follow-up by profile key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const db = new AssistantDatabase(":memory:");

    try {
      seedAcceptedInvitation({
        db,
        profileName: "default",
        profileUrl: "https://www.linkedin.com/in/jane-doe/",
        vanityName: "jane-doe",
        fullName: "Jane Doe",
        headline: "Product Manager",
        firstSeenSentAtMs: FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
        lastSeenSentAtMs: FIXED_NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
        acceptedAtMs: FIXED_NOW.getTime() - 12 * 60 * 60 * 1000
      });

      const runtime = createTestRuntime(db);
      const service = new LinkedInFollowupsService(runtime);
      const refreshSpy = vi.spyOn(
        service as unknown as { refreshAcceptanceState: () => Promise<void> },
        "refreshAcceptanceState"
      ).mockResolvedValue(undefined);

      const preparedFollowup: PreparedAcceptedConnectionFollowup = {
        connection: {
          profile_url_key: "https://www.linkedin.com/in/jane-doe/",
          profile_url: "https://www.linkedin.com/in/jane-doe/",
          vanity_name: "jane-doe",
          full_name: "Jane Doe",
          headline: "Product Manager",
          first_seen_sent_at_ms: FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
          last_seen_sent_at_ms: FIXED_NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
          accepted_at_ms: FIXED_NOW.getTime() - 12 * 60 * 60 * 1000,
          accepted_detection: "topcard-message-role",
          followup_status: "prepared",
          followup_prepared_action_id: "pa_followup_jane",
          followup_prepared_at_ms: FIXED_NOW.getTime(),
          followup_confirmed_at_ms: null,
          followup_expires_at_ms: FIXED_NOW.getTime() + 30 * 60 * 1000
        },
        preparedActionId: "pa_followup_jane",
        confirmToken: "ct_followup_jane",
        expiresAtMs: FIXED_NOW.getTime() + 30 * 60 * 1000,
        preview: {
          summary: "Send accepted-connection follow-up to Jane Doe"
        }
      };

      const prepareSpy = vi.spyOn(
        service as unknown as {
          prepareAcceptedConnections: (
            profileName: string,
            connections: LinkedInAcceptedConnection[]
          ) => Promise<PreparedAcceptedConnectionFollowup[]>;
        },
        "prepareAcceptedConnections"
      ).mockResolvedValue([preparedFollowup]);

      const result = await service.prepareFollowupForAcceptedConnection({
        profileName: "default",
        profileUrlKey: "https://www.linkedin.com/in/jane-doe/"
      });

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      expect(prepareSpy.mock.calls[0]?.[1]).toHaveLength(1);
      expect(prepareSpy.mock.calls[0]?.[1]?.[0]?.full_name).toBe("Jane Doe");
      expect(result).toEqual(preparedFollowup);
    } finally {
      db.close();
    }
  });

  it("returns null when a single accepted connection no longer needs preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const db = new AssistantDatabase(":memory:");

    try {
      seedAcceptedInvitation({
        db,
        profileName: "default",
        profileUrl: "https://www.linkedin.com/in/jane-doe/",
        vanityName: "jane-doe",
        fullName: "Jane Doe",
        headline: "Product Manager",
        firstSeenSentAtMs: FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
        lastSeenSentAtMs: FIXED_NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
        acceptedAtMs: FIXED_NOW.getTime() - 12 * 60 * 60 * 1000
      });

      seedPreparedFollowup({
        db,
        profileName: "default",
        profileUrl: "https://www.linkedin.com/in/jane-doe/",
        fullName: "Jane Doe",
        preparedAtMs: FIXED_NOW.getTime() - 10 * 60 * 1000
      });

      const runtime = createTestRuntime(db);
      const service = new LinkedInFollowupsService(runtime);
      const prepareSpy = vi.spyOn(
        service as unknown as {
          prepareAcceptedConnections: (
            profileName: string,
            connections: LinkedInAcceptedConnection[]
          ) => Promise<PreparedAcceptedConnectionFollowup[]>;
        },
        "prepareAcceptedConnections"
      );

      const result = await service.prepareFollowupForAcceptedConnection({
        profileName: "default",
        profileUrlKey: "https://www.linkedin.com/in/jane-doe/"
      });

      expect(prepareSpy).not.toHaveBeenCalled();
      expect(result).toBeNull();
    } finally {
      db.close();
    }
  });
});
