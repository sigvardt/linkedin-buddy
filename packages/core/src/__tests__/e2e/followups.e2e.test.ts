import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
  buildDefaultFollowupText,
  resolveFollowupSinceWindow,
  type LinkedInAcceptedConnection,
  type PreparedAcceptedConnectionFollowup
} from "../../linkedinFollowups.js";
import { LinkedInBuddyError } from "../../errors.js";
import {
  callMcpTool,
  expectRateLimitPreview,
  getDefaultProfileName,
  getLastJsonObject,
  isOptInEnabled,
  MCP_TOOL_NAMES,
  runCliCommand
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const confirmEnabled = isOptInEnabled("LINKEDIN_E2E_ENABLE_FOLLOWUP_CONFIRM");
const confirmTest = confirmEnabled ? it : it.skip;

function expectAcceptedConnectionDataQuality(
  conn: LinkedInAcceptedConnection
): void {
  expect(typeof conn.profile_url_key).toBe("string");
  expect(conn.profile_url_key.length).toBeGreaterThan(0);
  expect(typeof conn.profile_url).toBe("string");
  expect(conn.profile_url).toContain("/in/");
  expect(typeof conn.full_name).toBe("string");
  expect(conn.full_name.trim().length).toBeGreaterThan(0);
  expect(typeof conn.headline).toBe("string");
  expect(
    typeof conn.vanity_name === "string" || conn.vanity_name === null
  ).toBe(true);
  expect(typeof conn.accepted_at_ms).toBe("number");
  expect(conn.accepted_at_ms).toBeGreaterThan(0);
  expect(typeof conn.first_seen_sent_at_ms).toBe("number");
  expect(typeof conn.last_seen_sent_at_ms).toBe("number");
  expect(typeof conn.accepted_detection).toBe("string");
  expect([
    "not_prepared",
    "prepared",
    "executed",
    "failed",
    "expired"
  ]).toContain(conn.followup_status);
}

function expectPreparedFollowupContract(
  prepared: PreparedAcceptedConnectionFollowup
): void {
  expect(prepared.preparedActionId).toMatch(/^pa_/);
  expect(prepared.confirmToken).toMatch(/^ct_/);
  expect(typeof prepared.expiresAtMs).toBe("number");
  expect(prepared.expiresAtMs).toBeGreaterThan(Date.now());
  expect(prepared.preview).toHaveProperty("summary");
  expect(prepared.preview).toHaveProperty("target");
  expect(prepared.preview).toHaveProperty("outbound");

  const outbound = prepared.preview.outbound as Record<string, unknown>;
  expect(typeof outbound.text).toBe("string");
  expect((outbound.text as string).length).toBeGreaterThan(0);

  expectAcceptedConnectionDataQuality(prepared.connection);
  expect(prepared.connection.followup_status).toBe("prepared");
  expect(prepared.connection.followup_prepared_action_id).toBe(
    prepared.preparedActionId
  );
}

describe("Followups E2E — list accepted connections", () => {
  const e2e = setupE2ESuite();

  it("listAcceptedConnections returns an array", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const accepted = await runtime.followups.listAcceptedConnections({
      since: "30d"
    });

    expect(Array.isArray(accepted)).toBe(true);

    for (const conn of accepted) {
      expectAcceptedConnectionDataQuality(conn);
    }
  }, 120_000);

  it("accepted connections are sorted by recency (most recent first)", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const accepted = await runtime.followups.listAcceptedConnections({
      since: "30d"
    });

    if (accepted.length >= 2) {
      for (let i = 1; i < accepted.length; i++) {
        const prev = accepted[i - 1]!;
        const curr = accepted[i]!;
        expect(prev.accepted_at_ms).toBeGreaterThanOrEqual(curr.accepted_at_ms);
      }
    }
  }, 120_000);

  it("narrow lookback window returns empty or subset", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const narrow = await runtime.followups.listAcceptedConnections({
      since: "1m"
    });

    expect(Array.isArray(narrow)).toBe(true);

    const wide = await runtime.followups.listAcceptedConnections({
      since: "30d"
    });

    expect(narrow.length).toBeLessThanOrEqual(wide.length);
  }, 120_000);

  it("vanity_name matches profile_url slug when present", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const accepted = await runtime.followups.listAcceptedConnections({
      since: "30d"
    });

    for (const conn of accepted) {
      if (conn.vanity_name) {
        expect(conn.profile_url).toContain(`/in/${conn.vanity_name}`);
      }
    }
  }, 120_000);
});

describe("Followups E2E — prepare follow-ups (2PC)", () => {
  const e2e = setupE2ESuite();

  it("prepareFollowupsAfterAccept returns valid result structure", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const result = await runtime.followups.prepareFollowupsAfterAccept({
      since: "30d"
    });

    expect(typeof result.since).toBe("string");
    expect(result.since.length).toBeGreaterThan(0);
    expect(Array.isArray(result.acceptedConnections)).toBe(true);
    expect(Array.isArray(result.preparedFollowups)).toBe(true);

    for (const conn of result.acceptedConnections) {
      expectAcceptedConnectionDataQuality(conn);
    }

    for (const prepared of result.preparedFollowups) {
      expectPreparedFollowupContract(prepared);
    }
  }, 180_000);

  it("prepared follow-up preview contains rate limit metadata", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const result = await runtime.followups.prepareFollowupsAfterAccept({
      since: "30d"
    });

    for (const prepared of result.preparedFollowups) {
      expectRateLimitPreview(
        prepared.preview,
        "linkedin.messaging.send_message"
      );
    }
  }, 180_000);

  it("prepared follow-up message text matches buildDefaultFollowupText", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const result = await runtime.followups.prepareFollowupsAfterAccept({
      since: "30d"
    });

    for (const prepared of result.preparedFollowups) {
      const outbound = prepared.preview.outbound as Record<string, unknown>;
      const expectedText = buildDefaultFollowupText(
        prepared.connection.full_name
      );
      expect(outbound.text).toBe(expectedText);
    }
  }, 180_000);

  it("already-prepared connections are not re-prepared on second call", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const first = await runtime.followups.prepareFollowupsAfterAccept({
      since: "30d"
    });

    const second = await runtime.followups.prepareFollowupsAfterAccept({
      since: "30d"
    });

    const firstPreparedKeys = new Set(
      first.preparedFollowups.map((p) => p.connection.profile_url_key)
    );
    const secondPreparedKeys = new Set(
      second.preparedFollowups.map((p) => p.connection.profile_url_key)
    );

    for (const key of firstPreparedKeys) {
      expect(secondPreparedKeys.has(key)).toBe(false);
    }
  }, 180_000);

  it("prepareFollowupForAcceptedConnection returns null for unknown profile key", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const result =
      await runtime.followups.prepareFollowupForAcceptedConnection({
        profileUrlKey: "https://www.linkedin.com/in/nonexistent-user-key/"
      });

    expect(result).toBeNull();
  }, 60_000);
});

describe("Followups E2E — confirm flow (2PC)", () => {
  const e2e = setupE2ESuite();

  confirmTest(
    "confirm sends follow-up message via prepare → confirmByToken",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const result = await runtime.followups.prepareFollowupsAfterAccept({
        since: "30d",
        operatorNote: "Automated acid test #451"
      });

      const prepared = result.preparedFollowups[0];
      if (!prepared) {
        return;
      }

      expectPreparedFollowupContract(prepared);

      const confirmed = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken
      });

      expect(confirmed.status).toBe("executed");
      expect(confirmed.preparedActionId).toBe(prepared.preparedActionId);
      expect(confirmed.actionType).toBe(FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE);
      expect(confirmed.result).toHaveProperty("sent", true);
      expect(confirmed.result).toHaveProperty("status", "followup_sent");
    },
    180_000
  );
});

describe("Followups E2E — CLI surface", () => {
  const e2e = setupE2ESuite();
  const profileName = getDefaultProfileName();

  it("followups list returns valid JSON output", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "followups",
      "list",
      "--profile",
      profileName,
      "--since",
      "30d"
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);

    const payload = getLastJsonObject(result.stdout);
    expect(payload).toMatchObject({
      profile_name: profileName,
      since: "30d"
    });
    expect(payload).toHaveProperty("count");
    expect(typeof payload.count).toBe("number");
    expect(Array.isArray(payload.accepted_connections)).toBe(true);
  }, 120_000);

  it("followups prepare returns valid JSON output", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "followups",
      "prepare",
      "--profile",
      profileName,
      "--since",
      "30d"
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);

    const payload = getLastJsonObject(result.stdout);
    expect(payload).toMatchObject({
      profile_name: profileName,
      since: "30d"
    });
    expect(payload).toHaveProperty("accepted_connection_count");
    expect(payload).toHaveProperty("prepared_count");
    expect(typeof payload.accepted_connection_count).toBe("number");
    expect(typeof payload.prepared_count).toBe("number");
    expect(Array.isArray(payload.accepted_connections)).toBe(true);
    expect(Array.isArray(payload.prepared_followups)).toBe(true);
  }, 180_000);

  it("followups list with default since uses 7d", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "followups",
      "list",
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);

    const payload = getLastJsonObject(result.stdout);
    expect(payload.since).toBe("7d");
  }, 120_000);
});

describe("Followups E2E — MCP surface", () => {
  const e2e = setupE2ESuite();
  const profileName = getDefaultProfileName();

  it("prepare_followup_after_accept tool returns valid result", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(
      MCP_TOOL_NAMES.followupsPrepareAfterAccept,
      {
        profileName,
        since: "30d"
      }
    );

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      since: "30d"
    });
    expect(result.payload).toHaveProperty("accepted_connection_count");
    expect(result.payload).toHaveProperty("prepared_count");
    expect(typeof result.payload.accepted_connection_count).toBe("number");
    expect(typeof result.payload.prepared_count).toBe("number");
    expect(Array.isArray(result.payload.accepted_connections)).toBe(true);
    expect(Array.isArray(result.payload.prepared_followups)).toBe(true);
  }, 180_000);

  it("MCP tool uses default 7d when since is not provided", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(
      MCP_TOOL_NAMES.followupsPrepareAfterAccept,
      {
        profileName
      }
    );

    expect(result.isError).toBe(false);
    expect(result.payload.since).toBe("7d");
  }, 180_000);
});

describe("Followups E2E — error handling", () => {
  const e2e = setupE2ESuite();

  it("resolveFollowupSinceWindow rejects invalid since format", () => {
    expect(() => resolveFollowupSinceWindow("invalid")).toThrow(
      LinkedInBuddyError
    );
    expect(() => resolveFollowupSinceWindow("invalid")).toThrow(
      /relative duration/
    );
  });

  it("resolveFollowupSinceWindow rejects future date", () => {
    const futureDate = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    expect(() => resolveFollowupSinceWindow(futureDate)).toThrow(
      LinkedInBuddyError
    );
    expect(() => resolveFollowupSinceWindow(futureDate)).toThrow(
      /future/
    );
  });

  it("resolveFollowupSinceWindow accepts all supported units", () => {
    const now = Date.now();

    const minutes = resolveFollowupSinceWindow("30m", now);
    expect(minutes.since).toBe("30m");
    expect(minutes.sinceMs).toBe(now - 30 * 60 * 1000);

    const hours = resolveFollowupSinceWindow("12h", now);
    expect(hours.since).toBe("12h");
    expect(hours.sinceMs).toBe(now - 12 * 60 * 60 * 1000);

    const days = resolveFollowupSinceWindow("7d", now);
    expect(days.since).toBe("7d");
    expect(days.sinceMs).toBe(now - 7 * 24 * 60 * 60 * 1000);

    const weeks = resolveFollowupSinceWindow("2w", now);
    expect(weeks.since).toBe("2w");
    expect(weeks.sinceMs).toBe(now - 2 * 7 * 24 * 60 * 60 * 1000);
  });

  it("buildDefaultFollowupText uses first name", () => {
    expect(buildDefaultFollowupText("Jane Doe")).toBe(
      "Hi Jane, thanks for accepting my invitation. Great to connect."
    );
  });

  it("buildDefaultFollowupText handles empty name", () => {
    expect(buildDefaultFollowupText("")).toBe(
      "Hi, thanks for accepting my invitation. Great to connect."
    );
  });

  it("CLI followups list with invalid since exits with error", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "followups",
      "list",
      "--since",
      "not-a-duration"
    ]);

    expect(result.exitCode).toBe(1);
    const payload = getLastJsonObject(result.stderr);
    expect(payload).toHaveProperty("code", "ACTION_PRECONDITION_FAILED");
  }, 30_000);
});
