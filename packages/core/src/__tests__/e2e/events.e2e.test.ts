import { describe, expect, it } from "vitest";
import { LinkedInBuddyError } from "../../errors.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";
import {
  callMcpTool,
  expectPreparedAction,
  expectRateLimitPreview,
  getLastJsonObject,
  MCP_TOOL_NAMES,
  runCliCommand,
  type PreparedActionResult,
} from "./helpers.js";

describe("Events E2E", () => {
  const e2e = setupE2ESuite();

  // ── Runtime API ────────────────────────────────────────────────────────

  it("searchEvents returns results with populated fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.events.searchEvents({
      query: "tech",
      limit: 5,
    });

    expect(result.count).toBeGreaterThan(0);
    expect(result.results.length).toBeGreaterThan(0);
    const first = result.results[0]!;
    expect(first.event_id.length).toBeGreaterThan(0);
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.title.length).toBeLessThan(200);
    expect(typeof first.date_time).toBe("string");
    expect(first.date_time.length).toBeLessThan(100);
    expect(typeof first.location).toBe("string");
    expect(typeof first.organizer).toBe("string");
    expect(typeof first.attendee_count).toBe("string");
    expect(first.event_url).toContain("linkedin.com");
    expect(typeof first.is_online).toBe("boolean");
  });

  it("viewEvent returns complete details", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const search = await runtime.events.searchEvents({
      query: "tech",
      limit: 1,
    });
    expect(search.results.length).toBeGreaterThan(0);
    const eventUrl = search.results[0]!.event_url;

    const detail = await runtime.events.viewEvent({ event: eventUrl });

    expect(detail.event_id.length).toBeGreaterThan(0);
    expect(detail.title.length).toBeGreaterThan(0);
    expect(detail.event_url).toContain("linkedin.com");
    expect(typeof detail.organizer).toBe("string");
    expect(typeof detail.date_time).toBe("string");
    expect(typeof detail.location).toBe("string");
    expect(typeof detail.attendee_count).toBe("string");
    expect(typeof detail.description).toBe("string");
    expect(typeof detail.is_online).toBe("boolean");
    expect(["not_responded", "attending", "unknown"]).toContain(
      detail.rsvp_state,
    );
  });

  it("prepareRsvp returns valid two-phase token", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const search = await runtime.events.searchEvents({
      query: "tech",
      limit: 1,
    });
    expect(search.results.length).toBeGreaterThan(0);
    const eventId = search.results[0]!.event_id;

    const prepared = runtime.events.prepareRsvp({
      event: eventId,
    });

    expectPreparedAction(prepared as PreparedActionResult);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.events.rsvp",
    );
    expect(prepared.preview).toHaveProperty("summary");
    expect(String(prepared.preview.summary)).toContain(eventId);
  });

  it("prepareRsvp rejects invalid event reference", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => runtime.events.prepareRsvp({ event: "not-an-event" }))
      .toThrow(/event must be a LinkedIn event URL or numeric ID/i);
  });

  it("searchEvents rejects empty query", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    await expect(runtime.events.searchEvents({ query: "" }))
      .rejects.toThrow(LinkedInBuddyError);

    try {
      await runtime.events.searchEvents({ query: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe(
        "ACTION_PRECONDITION_FAILED",
      );
    }
  });

  // ── MCP tools ──────────────────────────────────────────────────────────

  it("MCP events.search returns results", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.eventsSearch, {
      query: "tech",
      limit: 5,
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toHaveProperty("count");
    expect(Number(result.payload.count)).toBeGreaterThan(0);
    const results = result.payload.results;
    expect(Array.isArray(results)).toBe(true);
    const firstResult = (results as Record<string, unknown>[])[0]!;
    expect(typeof firstResult.event_id).toBe("string");
    expect(typeof firstResult.title).toBe("string");
    expect(typeof firstResult.event_url).toBe("string");
  });

  it("MCP events.view returns event details", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const searchResult = await callMcpTool(MCP_TOOL_NAMES.eventsSearch, {
      query: "tech",
      limit: 1,
    });
    expect(searchResult.isError).toBe(false);
    const searchResults = searchResult.payload.results as Record<string, unknown>[];
    expect(searchResults.length).toBeGreaterThan(0);
    const eventUrl = String(searchResults[0]!.event_url);

    const result = await callMcpTool(MCP_TOOL_NAMES.eventsView, {
      event: eventUrl,
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toHaveProperty("event");
    const event = result.payload.event as Record<string, unknown>;
    expect(typeof event.event_id).toBe("string");
    expect(typeof event.title).toBe("string");
    expect(String(event.event_url)).toContain("linkedin.com");
  });

  it("MCP events.prepare_rsvp returns two-phase token", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const searchResult = await callMcpTool(MCP_TOOL_NAMES.eventsSearch, {
      query: "tech",
      limit: 1,
    });
    expect(searchResult.isError).toBe(false);
    const searchResults = searchResult.payload.results as Record<string, unknown>[];
    expect(searchResults.length).toBeGreaterThan(0);
    const eventId = String(searchResults[0]!.event_id);

    const result = await callMcpTool(MCP_TOOL_NAMES.eventsPrepareRsvp, {
      event: eventId,
    });

    expect(result.isError).toBe(false);
    expect(typeof result.payload.preparedActionId).toBe("string");
    expect(typeof result.payload.confirmToken).toBe("string");
    expect(String(result.payload.preparedActionId)).toMatch(/^pa_/);
    expect(String(result.payload.confirmToken)).toMatch(/^ct_/);
  });

  // ── CLI commands ───────────────────────────────────────────────────────

  it("CLI events search returns results", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand(
      ["events", "search", "--query", "tech", "--limit", "5"],
      { timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    const output = getLastJsonObject(result.stdout);
    expect(Number(output.count)).toBeGreaterThan(0);
    expect(Array.isArray(output.results)).toBe(true);
  });

  it("CLI events view returns event details", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const searchResult = await runCliCommand(
      ["events", "search", "--query", "tech", "--limit", "1"],
      { timeoutMs: 30_000 },
    );
    expect(searchResult.exitCode).toBe(0);
    const searchOutput = getLastJsonObject(searchResult.stdout);
    const results = searchOutput.results as Record<string, unknown>[];
    expect(results.length).toBeGreaterThan(0);
    const eventUrl = String(results[0]!.event_url);

    const result = await runCliCommand(
      ["events", "view", eventUrl],
      { timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    const output = getLastJsonObject(result.stdout);
    expect(output.event).toBeDefined();
    const event = output.event as Record<string, unknown>;
    expect(typeof event.event_id).toBe("string");
    expect(typeof event.title).toBe("string");
  });

  it("CLI events rsvp returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const searchResult = await runCliCommand(
      ["events", "search", "--query", "tech", "--limit", "1"],
      { timeoutMs: 30_000 },
    );
    expect(searchResult.exitCode).toBe(0);
    const searchOutput = getLastJsonObject(searchResult.stdout);
    const results = searchOutput.results as Record<string, unknown>[];
    expect(results.length).toBeGreaterThan(0);
    const eventId = String(results[0]!.event_id);

    const result = await runCliCommand(
      ["events", "rsvp", eventId],
      { timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    const output = getLastJsonObject(result.stdout);
    expect(typeof output.preparedActionId).toBe("string");
    expect(typeof output.confirmToken).toBe("string");
  });
});
