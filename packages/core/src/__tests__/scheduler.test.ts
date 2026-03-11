import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchedulerConfig } from "../config.js";
import {
  AssistantDatabase,
  type SchedulerJobInsert
} from "../db/database.js";
import { LinkedInBuddyError } from "../errors.js";
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
  scheduleAcceptedConnectionFollowupAtMs,
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
    maxActiveJobsPerProfile: 100,
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

function createLogger(): LinkedInSchedulerRuntime["logger"] {
  return {
    log: vi.fn()
  } as LinkedInSchedulerRuntime["logger"];
}

function createRuntime(input: {
  db: AssistantDatabase;
  followups: LinkedInSchedulerRuntime["followups"];
  logger?: LinkedInSchedulerRuntime["logger"];
  schedulerConfig?: SchedulerConfig;
}): LinkedInSchedulerRuntime {
  return {
    db: input.db,
    logger: input.logger ?? createLogger(),
    followups: input.followups,
    schedulerConfig: input.schedulerConfig ?? createSchedulerConfig()
  };
}

function insertSchedulerJob(
  db: AssistantDatabase,
  overrides: Partial<SchedulerJobInsert> & Pick<SchedulerJobInsert, "id">
): void {
  const profileName = overrides.profileName ?? "default";
  const lane = overrides.lane ?? "followup_preparation";
  const profileUrlKey = overrides.id;

  db.insertSchedulerJob({
    id: overrides.id,
    profileName,
    lane,
    actionType: overrides.actionType ?? FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
    targetJson:
      overrides.targetJson ??
      JSON.stringify({
        profile_name: profileName,
        profile_url_key: profileUrlKey
      }),
    dedupeKey:
      overrides.dedupeKey ?? `${lane}:${profileName}:${profileUrlKey}`,
    scheduledAtMs: overrides.scheduledAtMs ?? FIXED_NOW,
    status: overrides.status,
    attemptCount: overrides.attemptCount,
    maxAttempts: overrides.maxAttempts ?? 5,
    leaseOwner: overrides.leaseOwner,
    leasedAtMs: overrides.leasedAtMs,
    leaseExpiresAtMs: overrides.leaseExpiresAtMs,
    preparedActionId: overrides.preparedActionId,
    lastErrorCode: overrides.lastErrorCode,
    lastErrorMessage: overrides.lastErrorMessage,
    lastAttemptAtMs: overrides.lastAttemptAtMs,
    completedAtMs: overrides.completedAtMs,
    createdAtMs: overrides.createdAtMs ?? FIXED_NOW,
    updatedAtMs: overrides.updatedAtMs ?? FIXED_NOW
  });
}

function claimDueSchedulerJobs(
  db: AssistantDatabase,
  overrides: Partial<{
    profileName: string;
    nowMs: number;
    limit: number;
    leaseOwner: string;
    leaseTtlMs: number;
  }> = {}
) {
  return db.claimDueSchedulerJobs({
    profileName: "default",
    nowMs: FIXED_NOW,
    limit: 10,
    leaseOwner: "worker",
    leaseTtlMs: 60_000,
    ...overrides
  });
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

  it("delays newly accepted follow-ups but retries failed ones immediately", () => {
    const config = createSchedulerConfig();

    expect(
      scheduleAcceptedConnectionFollowupAtMs({
        connection: createAcceptedConnection({
          accepted_at_ms: FIXED_NOW - 5 * 60 * 1000,
          followup_status: "not_prepared"
        }),
        nowMs: FIXED_NOW,
        config
      })
    ).toBe(FIXED_NOW + 10 * 60 * 1000);

    expect(
      scheduleAcceptedConnectionFollowupAtMs({
        connection: createAcceptedConnection({
          accepted_at_ms: FIXED_NOW - 5 * 60 * 1000,
          followup_status: "failed"
        }),
        nowMs: FIXED_NOW,
        config
      })
    ).toBe(FIXED_NOW);
  });
});

describe("scheduler DB helpers", () => {
  it("stores inserted jobs with defaults", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      insertSchedulerJob(db, {
        id: "job_default"
      });

      expect(db.getSchedulerJobById("job_default")).toMatchObject({
        id: "job_default",
        profile_name: "default",
        lane: "followup_preparation",
        action_type: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
        target_json: JSON.stringify({
          profile_name: "default",
          profile_url_key: "job_default"
        }),
        dedupe_key: "followup_preparation:default:job_default",
        scheduled_at: FIXED_NOW,
        status: "pending",
        attempt_count: 0,
        max_attempts: 5,
        lease_owner: null,
        leased_at: null,
        lease_expires_at: null,
        prepared_action_id: null,
        last_error_code: null,
        last_error_message: null,
        last_attempt_at: null,
        completed_at: null,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW
      });
    } finally {
      db.close();
    }
  });

  it("rejects duplicate dedupe keys", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      insertSchedulerJob(db, {
        id: "job_one",
        dedupeKey: "followup_preparation:default:dup"
      });

      expect(() => {
        insertSchedulerJob(db, {
          id: "job_two",
          dedupeKey: "followup_preparation:default:dup"
        });
      }).toThrowError(/dedupe_key/i);
    } finally {
      db.close();
    }
  });

  it("claims due jobs in lane priority order", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      for (const [lane, id] of [
        ["feed_engagement", "job_feed"],
        ["followup_preparation", "job_followup"],
        ["pending_invite_checks", "job_pending"],
        ["inbox_triage", "job_inbox"]
      ] as const) {
        insertSchedulerJob(db, {
          id,
          lane,
          dedupeKey: `${lane}:default:${id}`
        });
      }

      const claimed = claimDueSchedulerJobs(db, {
        limit: 4,
        leaseOwner: "worker"
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

  it("reclaims expired leases but leaves future and unexpired jobs alone", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      insertSchedulerJob(db, {
        id: "job_due_pending",
        scheduledAtMs: FIXED_NOW - 5_000,
        createdAtMs: FIXED_NOW - 5_000,
        updatedAtMs: FIXED_NOW - 5_000
      });
      insertSchedulerJob(db, {
        id: "job_expired_lease",
        status: "leased",
        leaseOwner: "worker-old",
        leasedAtMs: FIXED_NOW - 61_000,
        leaseExpiresAtMs: FIXED_NOW - 1,
        scheduledAtMs: FIXED_NOW,
        createdAtMs: FIXED_NOW - 4_000,
        updatedAtMs: FIXED_NOW - 4_000
      });
      insertSchedulerJob(db, {
        id: "job_boundary_lease",
        status: "leased",
        leaseOwner: "worker-old",
        leasedAtMs: FIXED_NOW - 60_000,
        leaseExpiresAtMs: FIXED_NOW,
        scheduledAtMs: FIXED_NOW,
        createdAtMs: FIXED_NOW - 3_000,
        updatedAtMs: FIXED_NOW - 3_000
      });
      insertSchedulerJob(db, {
        id: "job_future_pending",
        scheduledAtMs: FIXED_NOW + 1,
        createdAtMs: FIXED_NOW - 2_000,
        updatedAtMs: FIXED_NOW - 2_000
      });
      insertSchedulerJob(db, {
        id: "job_prepared",
        status: "prepared",
        preparedActionId: "prepared_action",
        completedAtMs: FIXED_NOW - 1_000,
        createdAtMs: FIXED_NOW - 1_000,
        updatedAtMs: FIXED_NOW - 1_000
      });
      insertSchedulerJob(db, {
        id: "job_failed",
        status: "failed",
        completedAtMs: FIXED_NOW - 1_000,
        createdAtMs: FIXED_NOW - 500,
        updatedAtMs: FIXED_NOW - 500
      });

      const claimed = claimDueSchedulerJobs(db, {
        leaseOwner: "worker-new",
        leaseTtlMs: 30_000
      });

      expect(claimed.map((job) => job.id)).toEqual([
        "job_due_pending",
        "job_expired_lease"
      ]);
      expect(db.getSchedulerJobById("job_due_pending")).toMatchObject({
        status: "leased",
        lease_owner: "worker-new",
        leased_at: FIXED_NOW,
        lease_expires_at: FIXED_NOW + 30_000
      });
      expect(db.getSchedulerJobById("job_expired_lease")).toMatchObject({
        status: "leased",
        lease_owner: "worker-new",
        leased_at: FIXED_NOW,
        lease_expires_at: FIXED_NOW + 30_000
      });
      expect(db.getSchedulerJobById("job_boundary_lease")?.lease_owner).toBe(
        "worker-old"
      );
      expect(db.getSchedulerJobById("job_future_pending")?.status).toBe(
        "pending"
      );
    } finally {
      db.close();
    }
  });

  it("does not let competing workers double-claim unexpired leases", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      insertSchedulerJob(db, {
        id: "job_claim_once"
      });

      const firstClaim = claimDueSchedulerJobs(db, {
        leaseOwner: "worker-1"
      });
      const secondClaim = claimDueSchedulerJobs(db, {
        leaseOwner: "worker-2"
      });

      expect(firstClaim).toHaveLength(1);
      expect(secondClaim).toHaveLength(0);
      expect(db.getSchedulerJobById("job_claim_once")).toMatchObject({
        status: "leased",
        lease_owner: "worker-1"
      });
    } finally {
      db.close();
    }
  });

  it("only lets the active lease owner finalize leased jobs", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      for (const id of [
        "job_prepare",
        "job_reschedule",
        "job_fail",
        "job_cancel"
      ]) {
        insertSchedulerJob(db, {
          id
        });
      }

      const firstClaimed = claimDueSchedulerJobs(db, {
        limit: 4,
        leaseOwner: "worker-1"
      });
      expect(firstClaimed).toHaveLength(4);

      const reclaimAtMs = FIXED_NOW + 61_000;
      const reclaimed = claimDueSchedulerJobs(db, {
        nowMs: reclaimAtMs,
        limit: 4,
        leaseOwner: "worker-2"
      });
      expect(reclaimed).toHaveLength(4);

      expect(
        db.markSchedulerJobPrepared({
          id: "job_prepare",
          nowMs: reclaimAtMs,
          preparedActionId: "prepared_action",
          leaseOwner: "worker-1"
        })
      ).toBe(false);
      expect(
        db.markSchedulerJobPrepared({
          id: "job_prepare",
          nowMs: reclaimAtMs,
          preparedActionId: "prepared_action",
          leaseOwner: "worker-2"
        })
      ).toBe(true);

      expect(
        db.rescheduleSchedulerJob({
          id: "job_reschedule",
          scheduledAtMs: reclaimAtMs + 60_000,
          nowMs: reclaimAtMs,
          leaseOwner: "worker-1",
          errorMessage: "retry later"
        })
      ).toBe(false);
      expect(
        db.rescheduleSchedulerJob({
          id: "job_reschedule",
          scheduledAtMs: reclaimAtMs + 60_000,
          nowMs: reclaimAtMs,
          leaseOwner: "worker-2",
          errorMessage: "retry later"
        })
      ).toBe(true);

      expect(
        db.failSchedulerJob({
          id: "job_fail",
          nowMs: reclaimAtMs,
          leaseOwner: "worker-1",
          errorMessage: "give up"
        })
      ).toBe(false);
      expect(
        db.failSchedulerJob({
          id: "job_fail",
          nowMs: reclaimAtMs,
          leaseOwner: "worker-2",
          errorMessage: "give up"
        })
      ).toBe(true);

      expect(
        db.cancelSchedulerJob({
          id: "job_cancel",
          nowMs: reclaimAtMs,
          reason: "not needed",
          leaseOwner: "worker-1"
        })
      ).toBe(false);
      expect(
        db.cancelSchedulerJob({
          id: "job_cancel",
          nowMs: reclaimAtMs,
          reason: "not needed",
          leaseOwner: "worker-2"
        })
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("marks prepared jobs and clears transient lease and error fields", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      insertSchedulerJob(db, {
        id: "job_prepared_fields",
        status: "leased",
        leaseOwner: "worker",
        leasedAtMs: FIXED_NOW - 10_000,
        leaseExpiresAtMs: FIXED_NOW + 10_000,
        lastErrorCode: "NETWORK_ERROR",
        lastErrorMessage: "stale error",
        attemptCount: 2
      });

      expect(
        db.markSchedulerJobPrepared({
          id: "job_prepared_fields",
          nowMs: FIXED_NOW,
          preparedActionId: "prepared_action_123",
          leaseOwner: "worker"
        })
      ).toBe(true);

      expect(db.getSchedulerJobById("job_prepared_fields")).toMatchObject({
        status: "prepared",
        prepared_action_id: "prepared_action_123",
        attempt_count: 2,
        lease_owner: null,
        leased_at: null,
        lease_expires_at: null,
        last_error_code: null,
        last_error_message: null,
        last_attempt_at: FIXED_NOW,
        completed_at: FIXED_NOW,
        updated_at: FIXED_NOW
      });
    } finally {
      db.close();
    }
  });

  it("reschedules leased jobs and increments attempt counters", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      insertSchedulerJob(db, {
        id: "job_reschedule_fields",
        status: "leased",
        leaseOwner: "worker",
        leasedAtMs: FIXED_NOW - 10_000,
        leaseExpiresAtMs: FIXED_NOW + 10_000,
        attemptCount: 4,
        maxAttempts: 5
      });

      const nextRunAtMs = FIXED_NOW + 15 * 60 * 1000;

      expect(
        db.rescheduleSchedulerJob({
          id: "job_reschedule_fields",
          scheduledAtMs: nextRunAtMs,
          nowMs: FIXED_NOW,
          leaseOwner: "worker",
          errorCode: "TIMEOUT",
          errorMessage: "Retry later."
        })
      ).toBe(true);

      expect(db.getSchedulerJobById("job_reschedule_fields")).toMatchObject({
        status: "pending",
        attempt_count: 5,
        max_attempts: 5,
        scheduled_at: nextRunAtMs,
        lease_owner: null,
        leased_at: null,
        lease_expires_at: null,
        last_error_code: "TIMEOUT",
        last_error_message: "Retry later.",
        last_attempt_at: FIXED_NOW,
        completed_at: null,
        updated_at: FIXED_NOW
      });
    } finally {
      db.close();
    }
  });

  it("fails leased jobs and records terminal error state", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      insertSchedulerJob(db, {
        id: "job_fail_fields",
        status: "leased",
        leaseOwner: "worker",
        leasedAtMs: FIXED_NOW - 10_000,
        leaseExpiresAtMs: FIXED_NOW + 10_000,
        attemptCount: 4,
        maxAttempts: 5
      });

      expect(
        db.failSchedulerJob({
          id: "job_fail_fields",
          nowMs: FIXED_NOW,
          leaseOwner: "worker",
          errorCode: "TARGET_NOT_FOUND",
          errorMessage: "Profile not found."
        })
      ).toBe(true);

      expect(db.getSchedulerJobById("job_fail_fields")).toMatchObject({
        status: "failed",
        attempt_count: 5,
        max_attempts: 5,
        lease_owner: null,
        leased_at: null,
        lease_expires_at: null,
        last_error_code: "TARGET_NOT_FOUND",
        last_error_message: "Profile not found.",
        last_attempt_at: FIXED_NOW,
        completed_at: FIXED_NOW,
        updated_at: FIXED_NOW
      });
    } finally {
      db.close();
    }
  });

  it("requires matching cancellation mode for pending and leased jobs", () => {
    const db = new AssistantDatabase(":memory:");

    try {
      insertSchedulerJob(db, {
        id: "job_pending_cancel"
      });
      insertSchedulerJob(db, {
        id: "job_leased_cancel",
        status: "leased",
        leaseOwner: "worker",
        leasedAtMs: FIXED_NOW - 10_000,
        leaseExpiresAtMs: FIXED_NOW + 10_000
      });

      expect(
        db.cancelSchedulerJob({
          id: "job_pending_cancel",
          nowMs: FIXED_NOW,
          reason: "wrong cancellation mode",
          leaseOwner: "worker"
        })
      ).toBe(false);
      expect(
        db.cancelSchedulerJob({
          id: "job_pending_cancel",
          nowMs: FIXED_NOW,
          reason: "obsolete"
        })
      ).toBe(true);

      expect(
        db.cancelSchedulerJob({
          id: "job_leased_cancel",
          nowMs: FIXED_NOW,
          reason: "missing lease owner"
        })
      ).toBe(false);
      expect(
        db.cancelSchedulerJob({
          id: "job_leased_cancel",
          nowMs: FIXED_NOW,
          reason: "wrong owner",
          leaseOwner: "worker-other"
        })
      ).toBe(false);
      expect(
        db.cancelSchedulerJob({
          id: "job_leased_cancel",
          nowMs: FIXED_NOW,
          reason: "not needed",
          leaseOwner: "worker"
        })
      ).toBe(true);

      expect(db.getSchedulerJobById("job_pending_cancel")).toMatchObject({
        status: "cancelled",
        last_error_message: "obsolete",
        last_attempt_at: FIXED_NOW,
        completed_at: FIXED_NOW
      });
      expect(db.getSchedulerJobById("job_leased_cancel")).toMatchObject({
        status: "cancelled",
        lease_owner: null,
        leased_at: null,
        lease_expires_at: null,
        last_error_message: "not needed",
        last_attempt_at: FIXED_NOW,
        completed_at: FIXED_NOW
      });
    } finally {
      db.close();
    }
  });
});

describe("LinkedInSchedulerService", () => {
  it("skips scheduler work when the follow-up lane is disabled", async () => {
    const db = new AssistantDatabase(":memory:");
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups,
          schedulerConfig: createSchedulerConfig({
            enabledLanes: []
          })
        })
      );

      await expect(
        service.runTick({
          profileName: "default",
          nowMs: FIXED_NOW,
          workerId: "test-worker"
        })
      ).resolves.toMatchObject({
        skippedReason: "disabled",
        claimedJobs: 0,
        processedJobs: []
      });
      expect(followups.listAcceptedConnections).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

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
      prepareFollowupForAcceptedConnection: vi.fn(async () =>
        createPreparedFollowupResult({
          db,
          profileName: "default",
          connection,
          preparedAtMs: FIXED_NOW
        })
      )
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
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
      expect(jobs[0]).toMatchObject({
        status: "prepared"
      });
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

  it("returns an empty summary when nothing is queued or due", async () => {
    const db = new AssistantDatabase(":memory:");
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result).toMatchObject({
        skippedReason: null,
        discoveredAcceptedConnections: 0,
        queuedJobs: 0,
        updatedJobs: 0,
        reopenedJobs: 0,
        cancelledJobs: 0,
        claimedJobs: 0,
        preparedJobs: 0,
        rescheduledJobs: 0,
        failedJobs: 0,
        processedJobs: []
      });
      expect(followups.prepareFollowupForAcceptedConnection).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("queues jobs that are not due yet without preparing them", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection({
      accepted_at_ms: FIXED_NOW - 5 * 60 * 1000
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => [connection]),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const config = createSchedulerConfig({
        followupDelayMs: 15 * 60 * 1000
      });
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups,
          schedulerConfig: config
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.queuedJobs).toBe(1);
      expect(result.claimedJobs).toBe(0);
      expect(result.preparedJobs).toBe(0);
      expect(result.processedJobs).toEqual([]);
      expect(followups.prepareFollowupForAcceptedConnection).not.toHaveBeenCalled();

      expect(db.listSchedulerJobs({ profileName: "default" })).toMatchObject([
        {
          status: "pending",
          scheduled_at: FIXED_NOW + 10 * 60 * 1000
        }
      ]);
    } finally {
      db.close();
    }
  });

  it("dedupes duplicate accepted connections to one scheduler job", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    const duplicateConnection = createAcceptedConnection({
      accepted_at_ms: connection.accepted_at_ms + 60_000,
      last_seen_sent_at_ms: connection.last_seen_sent_at_ms + 60_000
    });
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });

    const followups = {
      listAcceptedConnections: vi.fn(async () => [connection, duplicateConnection]),
      prepareFollowupForAcceptedConnection: vi.fn(async () =>
        createPreparedFollowupResult({
          db,
          profileName: "default",
          connection,
          preparedAtMs: FIXED_NOW
        })
      )
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.discoveredAcceptedConnections).toBe(2);
      expect(result.queuedJobs).toBe(1);
      expect(result.claimedJobs).toBe(1);
      expect(result.preparedJobs).toBe(1);
      expect(followups.prepareFollowupForAcceptedConnection).toHaveBeenCalledTimes(1);
      expect(db.listSchedulerJobs({ profileName: "default" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("reopens prepared jobs when follow-ups expire and need re-preparation", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    let currentConnection = connection;
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });

    const followups = {
      listAcceptedConnections: vi.fn(async () => [currentConnection]),
      prepareFollowupForAcceptedConnection: vi.fn(async () =>
        createPreparedFollowupResult({
          db,
          profileName: "default",
          connection: currentConnection,
          preparedAtMs: FIXED_NOW
        })
      )
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );

      await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "worker-1"
      });
      const firstPreparedActionId = db.listSchedulerJobs({
        profileName: "default"
      })[0]?.prepared_action_id;

      currentConnection = {
        ...connection,
        followup_status: "expired"
      };
      const secondResult = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW + 60_000,
        workerId: "worker-2"
      });

      const job = db.listSchedulerJobs({ profileName: "default" })[0];
      expect(secondResult.reopenedJobs).toBe(1);
      expect(secondResult.claimedJobs).toBe(1);
      expect(secondResult.preparedJobs).toBe(1);
      expect(job?.status).toBe("prepared");
      expect(job?.prepared_action_id).toBeTruthy();
      expect(job?.prepared_action_id).not.toBe(firstPreparedActionId);
    } finally {
      db.close();
    }
  });

  it("cancels pending jobs once a follow-up has already executed", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection({
      followup_status: "executed"
    });
    insertSchedulerJob(db, {
      id: "job_execute_cancel",
      targetJson: JSON.stringify({
        profile_name: "default",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => [connection]),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.cancelledJobs).toBe(1);
      expect(result.claimedJobs).toBe(0);
      expect(followups.prepareFollowupForAcceptedConnection).not.toHaveBeenCalled();
      expect(db.getSchedulerJobById("job_execute_cancel")).toMatchObject({
        status: "cancelled",
        last_error_message: "Follow-up already executed."
      });
    } finally {
      db.close();
    }
  });

  it("skips scheduler work outside business hours", async () => {
    const db = new AssistantDatabase(":memory:");
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups,
          schedulerConfig: createSchedulerConfig({
            businessHours: {
              timeZone: "UTC",
              startTime: "09:00",
              endTime: "17:00"
            }
          })
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: Date.parse("2026-03-08T08:30:00Z")
      });

      expect(result.skippedReason).toBe("outside_business_hours");
      expect(result.nextWindowStartAt).toBe("2026-03-08T09:00:00.000Z");
      expect(followups.listAcceptedConnections).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("treats profile lock contention as a skipped tick", async () => {
    const db = new AssistantDatabase(":memory:");
    const followups = {
      listAcceptedConnections: vi.fn(async () => {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "Profile is busy; lock file is already being held."
        );
      }),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.skippedReason).toBe("profile_busy");
      expect(result.claimedJobs).toBe(0);
      expect(followups.prepareFollowupForAcceptedConnection).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("cancels unsupported lane jobs after they are claimed", async () => {
    const db = new AssistantDatabase(":memory:");
    insertSchedulerJob(db, {
      id: "job_unsupported_lane",
      lane: "inbox_triage",
      actionType: "scheduler.unsupported",
      targetJson: "{}",
      dedupeKey: "inbox_triage:default:job_unsupported_lane"
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.claimedJobs).toBe(1);
      expect(result.cancelledJobs).toBe(1);
      expect(result.processedJobs).toEqual([
        {
          jobId: "job_unsupported_lane",
          lane: "inbox_triage",
          outcome: "cancelled"
        }
      ]);
      expect(db.getSchedulerJobById("job_unsupported_lane")).toMatchObject({
        status: "cancelled",
        last_error_message:
          "Lane inbox_triage is not executable in this scheduler build."
      });
    } finally {
      db.close();
    }
  });

  it("cancels jobs when follow-up preparation is no longer needed", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    insertSchedulerJob(db, {
      id: "job_cancel_no_longer_needed",
      targetJson: JSON.stringify({
        profile_name: "default",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.cancelledJobs).toBe(1);
      expect(result.preparedJobs).toBe(0);
      expect(db.getSchedulerJobById("job_cancel_no_longer_needed")).toMatchObject(
        {
          status: "cancelled",
          last_error_message: "Follow-up no longer needs preparation."
        }
      );
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
        throw new LinkedInBuddyError(
          "NETWORK_ERROR",
          "Temporary network issue."
        );
      })
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups,
          schedulerConfig: config
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.rescheduledJobs).toBe(1);

      const jobs = db.listSchedulerJobs({ profileName: "default" });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        status: "pending",
        attempt_count: 1,
        last_error_code: "NETWORK_ERROR",
        scheduled_at: FIXED_NOW + config.retry.initialBackoffMs
      });
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
    insertSchedulerJob(db, {
      id: "job_followup_retry",
      targetJson: JSON.stringify({
        profile_name: "default",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`,
      attemptCount: 1,
      maxAttempts: 2,
      createdAtMs: FIXED_NOW - 60_000,
      updatedAtMs: FIXED_NOW - 60_000
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => [connection]),
      prepareFollowupForAcceptedConnection: vi.fn(async () => {
        throw new LinkedInBuddyError("NETWORK_ERROR", "Still failing.");
      })
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups,
          schedulerConfig: config
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.failedJobs).toBe(1);

      const jobs = db.listSchedulerJobs({ profileName: "default" });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        status: "failed",
        attempt_count: 2,
        last_error_code: "NETWORK_ERROR"
      });
    } finally {
      db.close();
    }
  });

  it("fails missing-profile errors without retrying", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    insertSchedulerJob(db, {
      id: "job_missing_profile",
      targetJson: JSON.stringify({
        profile_name: "default",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => {
        throw new LinkedInBuddyError(
          "TARGET_NOT_FOUND",
          "Profile default not found."
        );
      })
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.failedJobs).toBe(1);
      expect(result.rescheduledJobs).toBe(0);
      expect(db.getSchedulerJobById("job_missing_profile")).toMatchObject({
        status: "failed",
        attempt_count: 1,
        last_error_code: "TARGET_NOT_FOUND",
        last_error_message: "Profile default not found."
      });
    } finally {
      db.close();
    }
  });

  it("fails malformed target JSON jobs", async () => {
    const db = new AssistantDatabase(":memory:");
    insertSchedulerJob(db, {
      id: "job_bad_target_json",
      targetJson: "{not-valid-json",
      dedupeKey: "followup_preparation:default:job_bad_target_json"
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.failedJobs).toBe(1);
      expect(followups.prepareFollowupForAcceptedConnection).not.toHaveBeenCalled();
      expect(db.getSchedulerJobById("job_bad_target_json")).toMatchObject({
        status: "failed",
        attempt_count: 1,
        last_error_code: "ACTION_PRECONDITION_FAILED"
      });
      expect(
        db.getSchedulerJobById("job_bad_target_json")?.last_error_message
      ).toContain("target_json is not valid JSON");
    } finally {
      db.close();
    }
  });

  it("fails jobs that are missing required scheduler target fields", async () => {
    const db = new AssistantDatabase(":memory:");
    insertSchedulerJob(db, {
      id: "job_missing_target_field",
      targetJson: JSON.stringify({
        profile_name: "default"
      }),
      dedupeKey: "followup_preparation:default:job_missing_target_field"
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.failedJobs).toBe(1);
      expect(followups.prepareFollowupForAcceptedConnection).not.toHaveBeenCalled();
      expect(db.getSchedulerJobById("job_missing_target_field")).toMatchObject({
        status: "failed",
        attempt_count: 1,
        last_error_code: "ACTION_PRECONDITION_FAILED"
      });
      expect(
        db.getSchedulerJobById("job_missing_target_field")?.last_error_message
      ).toContain("missing target.profile_url_key");
    } finally {
      db.close();
    }
  });

  it("downgrades lease-expiry prepare races to cancelled outcomes", async () => {
    const db = new AssistantDatabase(":memory:");
    const config = createSchedulerConfig({
      leaseTtlMs: 1_000,
      maxJobsPerTick: 1
    });
    const connection = createAcceptedConnection();
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });
    insertSchedulerJob(db, {
      id: "job_lease_race",
      targetJson: JSON.stringify({
        profile_name: "default",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`
    });

    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => {
        const reclaimed = claimDueSchedulerJobs(db, {
          nowMs: FIXED_NOW + config.leaseTtlMs + 1,
          limit: 1,
          leaseOwner: "worker-2",
          leaseTtlMs: config.leaseTtlMs
        });

        expect(reclaimed).toHaveLength(1);

        return createPreparedFollowupResult({
          db,
          profileName: "default",
          connection,
          preparedAtMs: FIXED_NOW
        });
      })
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups,
          schedulerConfig: config
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "worker-1"
      });

      expect(result.claimedJobs).toBe(1);
      expect(result.cancelledJobs).toBe(1);
      expect(result.preparedJobs).toBe(0);
      expect(result.processedJobs).toEqual([
        {
          jobId: "job_lease_race",
          lane: "followup_preparation",
          outcome: "cancelled"
        }
      ]);
      expect(db.getSchedulerJobById("job_lease_race")).toMatchObject({
        status: "leased",
        lease_owner: "worker-2"
      });
    } finally {
      db.close();
    }
  });

  it("converts scheduler DB write errors into terminal job failures", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });
    insertSchedulerJob(db, {
      id: "job_db_error",
      targetJson: JSON.stringify({
        profile_name: "default",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`
    });

    vi.spyOn(db, "markSchedulerJobPrepared").mockImplementation(() => {
      throw new Error("scheduler row write failed");
    });

    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () =>
        createPreparedFollowupResult({
          db,
          profileName: "default",
          connection,
          preparedAtMs: FIXED_NOW
        })
      )
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );
      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.failedJobs).toBe(1);
      expect(result.processedJobs).toEqual([
        {
          jobId: "job_db_error",
          lane: "followup_preparation",
          outcome: "failed",
          errorCode: "UNKNOWN",
          errorMessage: "scheduler row write failed"
        }
      ]);
      expect(db.getSchedulerJobById("job_db_error")).toMatchObject({
        status: "failed",
        attempt_count: 1,
        last_error_code: "UNKNOWN",
        last_error_message: "scheduler row write failed"
      });
    } finally {
      db.close();
    }
  });

  it("fails tampered jobs whose target profile does not match the claimed profile", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    insertSchedulerJob(db, {
      id: "job_cross_profile_target",
      targetJson: JSON.stringify({
        profile_name: "other-profile",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`
    });

    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );

      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.failedJobs).toBe(1);
      expect(followups.prepareFollowupForAcceptedConnection).not.toHaveBeenCalled();
      expect(result.processedJobs).toEqual([
        {
          jobId: "job_cross_profile_target",
          lane: "followup_preparation",
          outcome: "failed",
          errorCode: "ACTION_PRECONDITION_FAILED",
          errorMessage:
            "Scheduler job job_cross_profile_target target.profile_name does not match the claimed profile."
        }
      ]);
      expect(db.getSchedulerJobById("job_cross_profile_target")).toMatchObject({
        status: "failed",
        attempt_count: 1,
        last_error_code: "ACTION_PRECONDITION_FAILED"
      });
    } finally {
      db.close();
    }
  });

  it("tolerates duplicate enqueue races without rejecting the tick", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection({
      accepted_at_ms: FIXED_NOW,
      first_seen_sent_at_ms: FIXED_NOW - 60_000,
      last_seen_sent_at_ms: FIXED_NOW - 30_000
    });

    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });

    const originalInsertSchedulerJob = db.insertSchedulerJob.bind(db);
    vi.spyOn(db, "insertSchedulerJob").mockImplementation((input) => {
      originalInsertSchedulerJob(input);
      throw new Error("UNIQUE constraint failed: scheduler_job.dedupe_key");
    });

    const followups = {
      listAcceptedConnections: vi.fn(async () => [connection]),
      prepareFollowupForAcceptedConnection: vi.fn(async () => null)
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );

      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.claimedJobs).toBe(0);
      expect(result.queuedJobs).toBe(0);
      expect(result.failedJobs).toBe(0);
      expect(db.listSchedulerJobs({ profileName: "default" })).toHaveLength(1);
      expect(db.getSchedulerJobByDedupeKey({
        profileName: "default",
        dedupeKey: `followup_preparation:default:${connection.profile_url_key}`
      })).toMatchObject({
        status: "pending",
        dedupe_key: `followup_preparation:default:${connection.profile_url_key}`
      });
    } finally {
      db.close();
    }
  });

  it("keeps the tick running when terminal failure persistence throws", async () => {
    const db = new AssistantDatabase(":memory:");
    const connection = createAcceptedConnection();
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection
    });
    insertSchedulerJob(db, {
      id: "job_failure_transition_write",
      targetJson: JSON.stringify({
        profile_name: "default",
        profile_url_key: connection.profile_url_key
      }),
      dedupeKey: `followup_preparation:default:${connection.profile_url_key}`
    });

    vi.spyOn(db, "failSchedulerJob").mockImplementation(() => {
      throw new Error("scheduler final write failed");
    });

    const followups = {
      listAcceptedConnections: vi.fn(async () => []),
      prepareFollowupForAcceptedConnection: vi.fn(async () => {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "synthetic scheduler target failure"
        );
      })
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups
        })
      );

      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.failedJobs).toBe(1);
      expect(result.processedJobs).toEqual([
        {
          jobId: "job_failure_transition_write",
          lane: "followup_preparation",
          outcome: "failed",
          errorCode: "UNKNOWN",
          errorMessage: "scheduler final write failed"
        }
      ]);
      expect(db.getSchedulerJobById("job_failure_transition_write")).toMatchObject({
        status: "leased",
        lease_owner: "test-worker"
      });
    } finally {
      db.close();
    }
  });

  it("caps the number of active jobs queued for a profile", async () => {
    const db = new AssistantDatabase(":memory:");
    const olderConnection = createAcceptedConnection({
      profile_url_key: "https://www.linkedin.com/in/alice-smith/",
      profile_url: "https://www.linkedin.com/in/alice-smith/",
      vanity_name: "alice-smith",
      full_name: "Alice Smith",
      accepted_at_ms: FIXED_NOW - 3 * 60 * 60 * 1000,
      first_seen_sent_at_ms: FIXED_NOW - 4 * 24 * 60 * 60 * 1000,
      last_seen_sent_at_ms: FIXED_NOW - 3 * 24 * 60 * 60 * 1000
    });
    const newerConnection = createAcceptedConnection({
      profile_url_key: "https://www.linkedin.com/in/bob-smith/",
      profile_url: "https://www.linkedin.com/in/bob-smith/",
      vanity_name: "bob-smith",
      full_name: "Bob Smith",
      accepted_at_ms: FIXED_NOW - 2 * 60 * 60 * 1000,
      first_seen_sent_at_ms: FIXED_NOW - 3 * 24 * 60 * 60 * 1000,
      last_seen_sent_at_ms: FIXED_NOW - 2 * 24 * 60 * 60 * 1000
    });

    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection: olderConnection
    });
    seedAcceptedInvitation({
      db,
      profileName: "default",
      connection: newerConnection
    });

    const config = createSchedulerConfig({
      maxJobsPerTick: 5,
      maxActiveJobsPerProfile: 1
    });
    const followups = {
      listAcceptedConnections: vi.fn(async () => [olderConnection, newerConnection]),
      prepareFollowupForAcceptedConnection: vi.fn(async ({ profileUrlKey }) =>
        createPreparedFollowupResult({
          db,
          profileName: "default",
          connection:
            profileUrlKey === olderConnection.profile_url_key
              ? olderConnection
              : newerConnection,
          preparedAtMs: FIXED_NOW
        })
      )
    };

    try {
      const service = new LinkedInSchedulerService(
        createRuntime({
          db,
          followups,
          schedulerConfig: config
        })
      );

      const result = await service.runTick({
        profileName: "default",
        nowMs: FIXED_NOW,
        workerId: "test-worker"
      });

      expect(result.preparedJobs).toBe(1);
      expect(result.claimedJobs).toBe(1);
      expect(db.listSchedulerJobs({ profileName: "default" })).toHaveLength(1);
      expect(followups.prepareFollowupForAcceptedConnection).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
