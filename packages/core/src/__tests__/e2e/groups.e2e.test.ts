import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";
import {
  callMcpTool,
  MCP_TOOL_NAMES,
  runCliCommand,
  getLastJsonObject,
  expectPreparedAction,
  expectRateLimitPreview,
  type PreparedActionResult,
} from "./helpers.js";

describe("Groups E2E", () => {
  const e2e = setupE2ESuite();

  it("searchGroups returns results with populated fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.groups.searchGroups({
      query: "software engineering",
      limit: 5,
    });

    expect(result.count).toBeGreaterThan(0);
    expect(result.results.length).toBeGreaterThan(0);
    const first = result.results[0]!;
    expect(first.name.length).toBeGreaterThan(0);
    expect(first.group_url).toContain("/groups/");
    expect(first.group_id.length).toBeGreaterThan(0);
    expect(typeof first.member_count).toBe("string");
    expect(typeof first.visibility).toBe("string");
    expect(typeof first.description).toBe("string");
    expect(["member", "joinable", "pending", "unknown"]).toContain(
      first.membership_state,
    );
  });

  it("viewGroup returns complete details", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const search = await runtime.groups.searchGroups({
      query: "software engineering",
      limit: 1,
    });
    expect(search.results.length).toBeGreaterThan(0);
    const groupId = search.results[0]!.group_id;

    const detail = await runtime.groups.viewGroup({ group: groupId });

    expect(detail.group_id).toBe(groupId);
    expect(detail.name.length).toBeGreaterThan(0);
    expect(detail.group_url).toContain("/groups/");
    expect(typeof detail.visibility).toBe("string");
    expect(typeof detail.member_count).toBe("string");
    expect(typeof detail.description).toBe("string");
    expect(typeof detail.about).toBe("string");
    expect(["member", "joinable", "pending", "unknown"]).toContain(
      detail.membership_state,
    );
  });

  it("prepareJoinGroup returns valid two-phase token", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.groups.prepareJoinGroup({
      group: "9806731",
    });

    expectPreparedAction(prepared as PreparedActionResult);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.groups.join",
    );
    expect(prepared.preview).toHaveProperty("summary");
    expect(String(prepared.preview.summary)).toContain("9806731");
  });

  it("prepareLeaveGroup returns valid two-phase token", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.groups.prepareLeaveGroup({
      group: "https://www.linkedin.com/groups/9806731/",
    });

    expectPreparedAction(prepared as PreparedActionResult);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.groups.leave",
    );
  });

  it("preparePostToGroup returns valid two-phase token with payload", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.groups.preparePostToGroup({
      group: "9806731",
      text: "Test post content",
    });

    expectPreparedAction(prepared as PreparedActionResult);
    expectRateLimitPreview(
      prepared.preview,
      "linkedin.groups.post",
    );
    const preview = prepared.preview as Record<string, unknown>;
    const payload = preview.payload as Record<string, unknown>;
    expect(payload.text).toBe("Test post content");
  });

  it("prepareJoinGroup rejects invalid group reference", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => runtime.groups.prepareJoinGroup({ group: "not-a-group" }))
      .toThrow(/group must be a LinkedIn group URL or numeric ID/i);
  });

  it("preparePostToGroup rejects empty text", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => runtime.groups.preparePostToGroup({ group: "9806731", text: "" }))
      .toThrow(/text is required/i);
  });

  it("MCP groups.search returns results", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.groupsSearch, {
      query: "software engineering",
      limit: 5,
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toHaveProperty("count");
    expect(Number(result.payload.count)).toBeGreaterThan(0);
    const results = result.payload.results;
    expect(Array.isArray(results)).toBe(true);
    const firstResult = (results as Record<string, unknown>[])[0]!;
    expect(typeof firstResult.name).toBe("string");
    expect(typeof firstResult.group_url).toBe("string");
  });

  it("MCP groups.view returns group details", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.groupsView, {
      group: "9806731",
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toHaveProperty("group");
    const group = result.payload.group as Record<string, unknown>;
    expect(typeof group.group_id).toBe("string");
    expect(typeof group.name).toBe("string");
    expect(typeof group.group_url).toBe("string");
  });

  it("MCP groups.prepare_join returns two-phase token", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.groupsPrepareJoin, {
      group: "9806731",
    });

    expect(result.isError).toBe(false);
    expect(typeof result.payload.preparedActionId).toBe("string");
    expect(typeof result.payload.confirmToken).toBe("string");
    expect(String(result.payload.preparedActionId)).toMatch(/^pa_/);
    expect(String(result.payload.confirmToken)).toMatch(/^ct_/);
  });

  it("MCP groups.prepare_leave returns two-phase token", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.groupsPrepareLeave, {
      group: "9806731",
    });

    expect(result.isError).toBe(false);
    expect(typeof result.payload.preparedActionId).toBe("string");
    expect(typeof result.payload.confirmToken).toBe("string");
  });

  it("MCP groups.prepare_post returns two-phase token with payload", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.groupsPreparePost, {
      group: "9806731",
      text: "Acid test post",
    });

    expect(result.isError).toBe(false);
    expect(typeof result.payload.preparedActionId).toBe("string");
    expect(typeof result.payload.confirmToken).toBe("string");
  });

  it("CLI groups search returns results", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand(
      ["groups", "search", "--query", "software engineering", "--limit", "5"],
      { timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    const output = getLastJsonObject(result.stdout);
    expect(Number(output.count)).toBeGreaterThan(0);
    expect(Array.isArray(output.results)).toBe(true);
  });

  it("CLI groups view returns group details", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand(
      ["groups", "view", "9806731"],
      { timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    const output = getLastJsonObject(result.stdout);
    expect(output.group).toBeDefined();
    const group = output.group as Record<string, unknown>;
    expect(typeof group.name).toBe("string");
    expect(typeof group.group_id).toBe("string");
  });

  it("CLI groups join returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand(
      ["groups", "join", "9806731"],
      { timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    const output = getLastJsonObject(result.stdout);
    expect(typeof output.preparedActionId).toBe("string");
    expect(typeof output.confirmToken).toBe("string");
  });

  it("CLI groups leave returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand(
      ["groups", "leave", "9806731"],
      { timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    const output = getLastJsonObject(result.stdout);
    expect(typeof output.preparedActionId).toBe("string");
    expect(typeof output.confirmToken).toBe("string");
  });

  it("CLI groups post returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand(
      ["groups", "post", "9806731", "--text", "Test group post"],
      { timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    const output = getLastJsonObject(result.stdout);
    expect(typeof output.preparedActionId).toBe("string");
    expect(typeof output.confirmToken).toBe("string");
  });
});
