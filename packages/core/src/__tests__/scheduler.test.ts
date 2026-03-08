import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchedulerConfig } from "../config.js";
import { AssistantDatabase } from "../db/database.js";
import { LinkedInAssistantError } from "../errors.js";
import {
  FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
  type LinkedInAcceptedConnection,
  type PreparedAcceptedConnectionFollowup
} from "../linkedinFollowups.js";
import {
  LinkedInSchedulerService,
  alignToBusinessHours,
  calculateSchedulerBackoffMs,
  isWithinBusinessHours,
  type LinkedInSchedulerRuntime
} from "../scheduler.js";
import { TwoPhaseCommitService } from "../twoPhaseCommit.js";

const FIXED_NOW = new Date("2026-03-08T10:00:00Z").getTime();

afterEach(() => {
  vi.restoreAllMocks();
});

function createSchedulerConfig(
  overrides: Partial<SchedulerConfig> = {}
): SchedulerConfig {
  const businessHours = {
    timeZone: "UTC",
    startTime: "09:00",
    endTime: "17:00",
    ...overrides.businessHours
  };
  const retry = {
    maxAttempts: 5,
    initialBackoffMs: 5 * 60 * 1000,
    maxBackoffMs: 60 * 60 * 1000,
    ...overrides.retry
  };

  const base: SchedulerConfig = {
    enabled: true,
    pollIntervalMs: 5 * 60 * 1000,
    maxJobsPerTick: 2,
    leaseTtlMs: 60 * 1000,
    enabledLanes: ["followup_preparation"],
    businessHours,
    followupDelayMs: 15 * 60 * 1000,
    followupLookbackMs: 30 * 24 * 60 * 60 * 1000,
    retry
  };

  return {
    ...base,
    ...overrides,
    businessHours,
    retry
  };
}

function createAcceptedConnection(
  overrides: Partial<LinkedInAcceptedConnection> = {}
): LinkedInAcceptedConnection {
  return {
    profile_url_key: "https://www.linkedin.com/in/jane-doe/",
    profile_url: "https://www.linkedin.com/in/jane-doe/",
    vanity_name: "jane-doe",
    full_name: "Jane Doe",
    headline: "Product Manager",
    first_seen_sent_at_ms: FIXED_NOW - 3 * 24 * 60 * 60 * 1000,
    last_seen_sent_at_ms: FIXED_NOW - 2 * 24 * 60 * 60 * 1000,
    accepted_at_ms: FIXED_NOW - 2 * 60 * 60 * 1000,
    accepted_detection: "topcard-message-role",
    followup_status: "not_prepared",
    followup_prepared_action_id: null,
    followup_prepared_at_ms: null,
    followup_confirmed_at_ms: null,
    followup_expires_at_ms: null,
    ...overrides
  };
}

function seedAcceptedInvitation(input: {
  db: AssistantDatabase;
  profileName: string;
  connection: LinkedInAcceptedConnection;
}): void {
  input.db.upsertSentInvitationState({
    profileName: input.profileName,
    profileUrlKey: input.connection.profile_url_key,
    vanityName: input.connection.vanity_name,
    fullName: input.connection.full_name,
    headline: input.connection.headline,
    profileUrl: input.connection.profile_url,
    firstSeenSentAtMs: input.connection.first_seen_sent_at_ms,
    lastSeenSentAtMs: input.connection.last_seen_sent_at_ms,
    createdAtMs: input.connection.first_seen_sent_at_ms,
    updatedAtMs: input.connection.last_seen_sent_at_ms
  });

  const updated = input.db.markSentInvitationAccepted({
    profileName: input.profileName,
    profileUrlKey: input.connection.profile_url_key,
    vanityName: input.connection.vanity_name,
    fullName: input.connection.full_name,
    headline: input.connection.headline,
    profileUrl: input.connection.profile_url,
    acceptedAtMs: input.connection.accepted_at_ms,
    acceptedDetection: input.connection.accepted_detection,
    updatedAtMs: input.connection.accepted_at_ms
  });

  expect(updated).toBe(true);
}

function createPreparedFollowupResult(input: {
  db: AssistantDatabase;
  profileName: string;
  connection: LinkedInAcceptedConnection;
  preparedAtMs: number;
}): PreparedAcceptedConnectionFollowup {
  const twoPhaseCommit = new TwoPhaseCommitService(input.db);
  const prepared = twoPhaseCommit.prepare({
    actionType: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
    target: {
      profile_name: input.profileName,
      profile_url_key: input.connection.profile_url_key,
      target_profile_url: input.connection.profile_url,
      vanity_name: input.connection.vanity_name,
      full_name: input.connection.full_name,
      headline: input.connection.headline
    },
    payload: {
      text: `Hi ${input.connection.full_name}`
    },
    preview: {
      summary: `Send accepted-connection follow-up to ${input.connection.full_name}`
    },
    nowMs: input.preparedAtMs
  });

  const updated = input.db.markSentInvitationFollowupPrepared({
    profileName: input.profileName,
    profileUrlKey: input.connection.profile_url_key,
    preparedAtMs: input.preparedAtMs,
    preparedActionId: prepared.preparedActionId,
    updatedAtMs: input.preparedAtMs
  });
  expect(updated).toBe(true);

  return {
    connection: {
      ...input.connection,
      followup_status: "prepared",
      followup_prepared_action_id: prepared.preparedActionId,
      followup_prepared_at_ms: input.preparedAtMs,
      followup_expires_at_ms: prepared.expiresAtMs
    },
    preparedActionId: prepared.preparedActionId,
    confirmToken: prepared.confirmToken,
    expiresAtMs: prepared.expiresAtMs,
    preview: prepared.preview
  };
}

describe("scheduler helpers", () => {
  it("aligns due work to the next business window", () => {
    const businessHours = {
      timeZone: "Europe/Copenhagen",
      startTime: "09:00",
      endTime: "17:00"
    };

    expect(
      isWithinBusinessHours(
        Date.parse("2026-03-08T09:30:00Z"),
        businessHours
      )
    ).toBe(true);
    expect(
      alignToBusinessHours(
        Date.parse("2026-03-08T06:30:00Z"),
        businessHours
      )
    ).toBe(Date.parse("2026-03-08T08:00:00Z"));
    expect(
      alignToBusinessHours(
        Date.parse("2026-03-08T18:30:00Z"),
        businessHours
      )
    ).toBe(Date.parse("2026-03-09T08:00:00Z"));
  });

  it("uses exponential retry backoff with a cap", () => {
    const backoff = calculateSchedulerBackoffMs(4, {
      maxAttempts: 5,
      initialBackoffMs: 60_000,
      maxBackoffMs: 5 * 60_000
    });

    expect(backoff).toBe(5 * 60_000);
  });
});

describe("scheduler DB helpers", () => {
  it("claims due jobs in lane priority order", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      for (const [lane, id] of [
        ["feed_engagement", "job_feed"],
        ["followup_preparation", "job_followup"],
        ["pending_invite_checks", "job_pending"],
        ["inbox_triage", "job_inbox"]
      ] as const) {
        db.insertSchedulerJob({
          id,
          profileName: "default",
          lane,
          actionType: "scheduler.test",
          targetJson: "{}",
          dedupeKey: `${lane}:default`,
          scheduledAtMs: FIXED_NOW,
          maxAttempts: 5,
          createdAtMs: FIXED_NOW,
          updatedAtMs: FIXED_NOW
        });
      }

      const claimed = db.claimDueSchedulerJobs({
        profileName: "default",
        nowMs: FIXED_NOW,
        limit: 4,
        leaseOwner: "worker",
        leaseTtlMs: 60_000
      });

      expect(claimed.map((job) => job.lane)).toEqual([
        "inbox_triage",
        "pending_invite_checks",
        "followup_preparation",
        "feed_engagement"
      ]);
    } finally {
      db.close();
    }
  });
});

describe("LinkedInSchedulerService", () => {
  it("queues and prepares due follow-up jobs during business hours", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });

    const followups = {
      listAcceptedConnections: vi.fn(async () => [connection]),
      prepareFollowupForAcceptedConnection: vi.fn(
        async () =>
          createPreparedFollowupResult({
            db,
            profileName: "default",
            connection,
            preparedAtMs: FIXED_NOW
          })
      )
    };
    const runtime: LinkedInSchedulerRuntime = {
      db,
      logger: {
        log: vi.fn()
      } as LinkedInSchedulerRuntime["logger"],
      followups,
      schedulerConfig: createSchedulerConfig()
    };

    try {
      const service = new LinkedInSchedulerService(runtime);
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.skippedReason).toBeNull();
      expect(result.queuedJobs).toBe(1);
      expect(result.claimedJobs).toBe(1);
      expect(result.preparedJobs).toBe(1);
      expect(followups.prepareFollowupForAcceptedConnection).toHaveBeenCalledWith({
        profileName: "default",
        profileUrlKey: connection.profile_url_key,
        operatorNote: "Prepared by local scheduler.",
        refreshState: false
      });

      const jobs = db.listSchedulerJobs({ profileName: "default" });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("prepared");
      expect(jobs[0]?.prepared_action_id).toBeTruthy();

      const preparedActionId = jobs[0]?.prepared_action_id;
      expect(preparedActionId).toBeTruthy();
      expect(db.getPreparedActionById(preparedActionId ?? "")?.status).toBe(
        "prepared"
      );

      const state = db.getSentInvitationState({
        profileName: "default",
        profileUrlKey: connection.profile_url_key
      });
      expect(state?.followup_prepared_action_id).toBe(preparedActionId);
      expect(state?.followup_confirmed_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("skips scheduler work outside business hours", async () => {
    const db = new AssistantDatabase(":memory:");
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn()
    };

    try {
      const service = new LinkedInSchedulerService({
        db,
        logger: {
          log: vi.fn()
        } as LinkedInSchedulerRuntime["logger"],
        followups,
        schedulerConfig: createSchedulerConfig({
          businessHours: {
            timeZone: "UTC",
            startTime: "09:00",
            endTime: "17:00"
          }
        })
      });
      const result = await service.runTick({
        profileName: "default",
        nowMs: Date.parse("2026-03-08T08:30:00Z")
      });

      expect(result.skippedReason).toBe("outside_business_hours");
      expect(followups.listAcceptedConnections).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("backs off transient job failures", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });
    const config = createSchedulerConfig();
    const followups = {
      listAcceptedConnections: vi.fn(async () => [connection]),
      prepareFollowupForAcceptedConnection: vi.fn(async () => {
        throw new LinkedInAssistantError("NETWORK_ERROR", "Temporary network issue.");
      })
    };

    try {
      const service = new LinkedInSchedulerService({
        db,
        logger: {
          log: vi.fn()
        } as LinkedInSchedulerRuntime["logger"],
        followups,
        schedulerConfig: config
      });
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.rescheduledJobs).toBe(1);

      const jobs = db.listSchedulerJobs({ profileName: "default" });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("pending");
      expect(jobs[0]?.attempt_count).toBe(1);
      expect(jobs[0]?.last_error_code).toBe("NETWORK_ERROR");
      expect(jobs[0]?.scheduled_at).toBe(
        FIXED_NOW + config.retry.initialBackoffMs
      );
    } finally {
      db.close();
    }
  });

  it("marks jobs failed after the final retry", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });
    const config = createSchedulerConfig({
      retry: {
        maxAttempts: 2,
        initialBackoffMs: 5 * 60 * 1000,
        maxBackoffMs: 30 * 60 * 1000
      }
    });
    db.insertSchedulerJob({
      id: "job_followup_retry",
      profileName: "default",
      lane: "followup_preparation",
      actionType: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
      targetJson: JSON.stringify({
        profile_name: "default",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`,
      scheduledAtMs: FIXED_NOW,
      attemptCount: 1,
      maxAttempts: 2,
      createdAtMs: FIXED_NOW - 60_000,
      updatedAtMs: FIXED_NOW - 60_000
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => [connection]),
      prepareFollowupForAcceptedConnection: vi.fn(async () => {
        throw new LinkedInAssistantError("NETWORK_ERROR", "Still failing.");
      })
    };

    try {
      const service = new LinkedInSchedulerService({
        db,
        logger: {
          log: vi.fn()
        } as LinkedInSchedulerRuntime["logger"],
        followups,
        schedulerConfig: config
      });
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.failedJobs).toBe(1);

      const jobs = db.listSchedulerJobs({ profileName: "default" });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("failed");
      expect(jobs[0]?.attempt_count).toBe(2);
      expect(jobs[0]?.last_error_code).toBe("NETWORK_ERROR");
    } finally {
      db.close();
    }
  });
});
