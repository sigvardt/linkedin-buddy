import { describe, expect, it } from "vitest";
import {
  callMcpTool,
  getCliCoverageFixtures,
  getDefaultConnectionTarget,
  getDefaultProfileName,
  MCP_TOOL_NAMES,
  prepareEchoAction
} from "./helpers.js";
import { setupE2ESuite } from "./setup.js";

describe.sequential("MCP E2E", () => {
  const e2e = setupE2ESuite({
    fixtures: getCliCoverageFixtures,
    timeoutMs: 180_000
  });
  const profileName = getDefaultProfileName();

  it("covers session tools", async () => {
    if (!e2e.canRun()) {
      return;
    }

    const status = await callMcpTool(MCP_TOOL_NAMES.sessionStatus, {
      profileName
    });
    expect(status.isError).toBe(false);
    expect(status.payload).toMatchObject({
      profile_name: profileName,
      status: {
        authenticated: true
      }
    });

    const openLogin = await callMcpTool(MCP_TOOL_NAMES.sessionOpenLogin, {
      profileName,
      timeoutMs: 5_000
    });
    expect(openLogin.isError).toBe(false);
    expect(openLogin.payload).toMatchObject({
      profile_name: profileName,
      status: {
        authenticated: true,
        timedOut: false
      }
    });

    const health = await callMcpTool(MCP_TOOL_NAMES.sessionHealth, {
      profileName
    });
    expect(health.isError).toBe(false);
    expect(health.payload).toMatchObject({
      profile_name: profileName,
      browser: {
        healthy: true
      },
      session: {
        authenticated: true
      }
    });
  }, 120_000);

  it("covers inbox, connections, and followup tools", async () => {
    if (!e2e.canRun()) {
      return;
    }
    const fixtures = e2e.fixtures();

    const inboxList = await callMcpTool(MCP_TOOL_NAMES.inboxListThreads, {
      profileName,
      limit: 5
    });
    expect(inboxList.isError).toBe(false);
    expect(inboxList.payload).toMatchObject({
      profile_name: profileName,
      threads: expect.any(Array)
    });

    const inboxThread = await callMcpTool(MCP_TOOL_NAMES.inboxGetThread, {
      profileName,
      thread: fixtures.threadId,
      limit: 5
    });
    expect(inboxThread.isError).toBe(false);
    expect(inboxThread.payload).toMatchObject({
      profile_name: profileName,
      thread: {
        thread_id: fixtures.threadId
      }
    });

    const prepareReply = await callMcpTool(MCP_TOOL_NAMES.inboxPrepareReply, {
      profileName,
      thread: fixtures.threadId,
      text: `MCP preview message [${Date.now()}]`
    });
    expect(prepareReply.isError).toBe(false);
    expect(prepareReply.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const connectionsList = await callMcpTool(MCP_TOOL_NAMES.connectionsList, {
      profileName,
      limit: 5
    });
    expect(connectionsList.isError).toBe(false);
    expect(connectionsList.payload).toMatchObject({
      profile_name: profileName,
      connections: expect.any(Array)
    });

    const connectionsPending = await callMcpTool(MCP_TOOL_NAMES.connectionsPending, {
      profileName,
      filter: "all"
    });
    expect(connectionsPending.isError).toBe(false);
    expect(connectionsPending.payload).toMatchObject({
      profile_name: profileName,
      invitations: expect.any(Array)
    });

    for (const toolName of [
      MCP_TOOL_NAMES.connectionsInvite,
      MCP_TOOL_NAMES.connectionsAccept,
      MCP_TOOL_NAMES.connectionsWithdraw
    ] as const) {
      const targetProfile = getDefaultConnectionTarget();
      const prepared = await callMcpTool(toolName, {
        profileName,
        targetProfile
      });
      expect(prepared.isError).toBe(false);
      expect(prepared.payload).toMatchObject({
        profile_name: profileName,
        preparedActionId: expect.stringMatching(/^pa_/),
        confirmToken: expect.stringMatching(/^ct_/)
      });
    }

    const followups = await callMcpTool(MCP_TOOL_NAMES.followupsPrepareAfterAccept, {
      profileName,
      since: "30d"
    });
    expect(followups.isError).toBe(false);
    expect(followups.payload).toMatchObject({
      profile_name: profileName,
      accepted_connections: expect.any(Array),
      prepared_followups: expect.any(Array)
    });
  }, 180_000);

  it("covers feed, post, actions confirm, and notifications tools", async () => {
    if (!e2e.canRun()) {
      return;
    }
    const fixtures = e2e.fixtures();

    const feedList = await callMcpTool(MCP_TOOL_NAMES.feedList, {
      profileName,
      limit: 5
    });
    expect(feedList.isError).toBe(false);
    expect(feedList.payload).toMatchObject({
      profile_name: profileName,
      posts: expect.any(Array)
    });

    const feedView = await callMcpTool(MCP_TOOL_NAMES.feedViewPost, {
      profileName,
      postUrl: fixtures.postUrl
    });
    expect(feedView.isError).toBe(false);
    expect(feedView.payload).toMatchObject({
      profile_name: profileName,
      post: {
        post_url: fixtures.postUrl
      }
    });

    const feedLike = await callMcpTool(MCP_TOOL_NAMES.feedLike, {
      profileName,
      postUrl: fixtures.postUrl,
      reaction: "like"
    });
    expect(feedLike.isError).toBe(false);
    expect(feedLike.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const feedComment = await callMcpTool(MCP_TOOL_NAMES.feedComment, {
      profileName,
      postUrl: fixtures.postUrl,
      text: `MCP preview comment [${Date.now()}]`
    });
    expect(feedComment.isError).toBe(false);
    expect(feedComment.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const postPrepare = await callMcpTool(MCP_TOOL_NAMES.postPrepareCreate, {
      profileName,
      text: `MCP preview post [${Date.now()}]`,
      visibility: "public"
    });
    expect(postPrepare.isError).toBe(false);
    expect(postPrepare.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const runtime = e2e.runtime();
    const preparedConfirm = prepareEchoAction(runtime, {
      profileName,
      summary: "MCP actions.confirm echo"
    });
    const confirm = await callMcpTool(MCP_TOOL_NAMES.actionsConfirm, {
      profileName,
      token: preparedConfirm.confirmToken
    });
    expect(confirm.isError).toBe(false);
    expect(confirm.payload).toMatchObject({
      profile_name: profileName,
      result: {
        actionType: "test.echo",
        result: {
          echo: expect.any(String)
        }
      }
    });

    const notifications = await callMcpTool(MCP_TOOL_NAMES.notificationsList, {
      profileName,
      limit: 5
    });
    expect(notifications.isError).toBe(false);
    expect(notifications.payload).toMatchObject({
      profile_name: profileName,
      notifications: expect.any(Array)
    });
  }, 180_000);

  it("covers profile, search, and jobs tools", async () => {
    if (!e2e.canRun()) {
      return;
    }
    const fixtures = e2e.fixtures();

    const profile = await callMcpTool(MCP_TOOL_NAMES.profileView, {
      profileName,
      target: getDefaultConnectionTarget()
    });
    expect(profile.isError).toBe(false);
    expect(profile.payload).toMatchObject({
      profile_name: profileName,
      profile: {
        profile_url: expect.stringContaining("linkedin.com")
      }
    });

    const search = await callMcpTool(MCP_TOOL_NAMES.search, {
      profileName,
      query: "Simon Miller",
      category: "people",
      limit: 5
    });
    expect(search.isError).toBe(false);
    expect(search.payload).toMatchObject({
      profile_name: profileName,
      category: "people",
      results: expect.any(Array)
    });

    const jobsSearch = await callMcpTool(MCP_TOOL_NAMES.jobsSearch, {
      profileName,
      query: "software engineer",
      location: "Copenhagen",
      limit: 5
    });
    expect(jobsSearch.isError).toBe(false);
    expect(jobsSearch.payload).toMatchObject({
      profile_name: profileName,
      results: expect.any(Array)
    });

    const jobView = await callMcpTool(MCP_TOOL_NAMES.jobsView, {
      profileName,
      jobId: fixtures.jobId
    });
    expect(jobView.isError).toBe(false);
    expect(jobView.payload).toMatchObject({
      profile_name: profileName,
      job: {
        job_id: fixtures.jobId
      }
    });
  }, 180_000);
});
