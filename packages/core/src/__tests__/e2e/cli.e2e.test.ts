import { describe, expect, it } from "vitest";
import {
  getCliCoverageFixtures,
  getDefaultConnectionTarget,
  getDefaultProfileName,
  getLastJsonObject,
  prepareEchoAction,
  runCliCommand
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe.sequential("CLI E2E", () => {
  const e2e = setupE2ESuite({
    fixtures: getCliCoverageFixtures,
    timeoutMs: 180_000
  });
  const profileName = getDefaultProfileName();

  it("covers session, health, rate-limit, login, and selector audit commands", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const status = await runCliCommand(["status", "--profile", profileName]);
    expect(status.error).toBeUndefined();
    expect(status.exitCode).toBe(0);
    expect(getLastJsonObject(status.stdout)).toMatchObject({
      authenticated: true
    });

    const health = await runCliCommand(["health", "--profile", profileName]);
    expect(health.error).toBeUndefined();
    expect(health.exitCode).toBe(0);
    expect(getLastJsonObject(health.stdout)).toMatchObject({
      browser: {
        healthy: true
      },
      session: {
        authenticated: true
      }
    });

    const rateLimitStatus = await runCliCommand(["rate-limit"]);
    expect(rateLimitStatus.error).toBeUndefined();
    expect(getLastJsonObject(rateLimitStatus.stdout)).toHaveProperty("active");

    const rateLimitClear = await runCliCommand(["rate-limit", "--clear"]);
    expect(rateLimitClear.error).toBeUndefined();
    expect(getLastJsonObject(rateLimitClear.stdout)).toMatchObject({
      cleared: true
    });

    const login = await runCliCommand([
      "login",
      "--profile",
      profileName,
      "--timeout-minutes",
      "1"
    ]);
    expect(login.error).toBeUndefined();
    expect(login.exitCode).toBe(0);
    expect(getLastJsonObject(login.stdout)).toMatchObject({
      authenticated: true,
      timedOut: false
    });

    const audit = await runCliCommand([
      "audit",
      "selectors",
      "--profile",
      profileName,
      "--json",
      "--no-progress"
    ]);
    expect(audit.error).toBeUndefined();
    const auditPayload = getLastJsonObject(audit.stdout);
    expect(typeof auditPayload.total_count).toBe("number");
    expect(typeof auditPayload.fail_count).toBe("number");
    expect(typeof auditPayload.report_path).toBe("string");
    const failCount = auditPayload.fail_count;
    if (typeof failCount === "number" && failCount > 0) {
      expect(audit.exitCode).toBe(1);
    } else {
      expect(audit.exitCode).toBe(0);
    }
  }, 240_000);

  it("covers inbox commands and both confirm entrypoints", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const fixtures = e2e.fixtures();

    const inboxList = await runCliCommand([
      "inbox",
      "list",
      "--profile",
      profileName,
      "--limit",
      "5"
    ]);
    expect(inboxList.error).toBeUndefined();
    expect(getLastJsonObject(inboxList.stdout)).toMatchObject({
      profile_name: profileName,
      count: expect.any(Number)
    });

    const inboxShow = await runCliCommand([
      "inbox",
      "show",
      "--profile",
      profileName,
      "--thread",
      fixtures.threadId,
      "--limit",
      "5"
    ]);
    expect(inboxShow.error).toBeUndefined();
    expect(getLastJsonObject(inboxShow.stdout)).toMatchObject({
      profile_name: profileName,
      thread: {
        thread_id: fixtures.threadId
      }
    });

    const prepareReply = await runCliCommand([
      "inbox",
      "prepare-reply",
      "--profile",
      profileName,
      "--thread",
      fixtures.threadId,
      "--text",
      `CLI preview message [${Date.now()}]`
    ]);
    expect(prepareReply.error).toBeUndefined();
    expect(getLastJsonObject(prepareReply.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const runtime = e2e.runtime();
    const confirmAction = prepareEchoAction(runtime, {
      profileName,
      summary: "CLI actions.confirm echo"
    });
    const actionsConfirm = await runCliCommand([
      "actions",
      "confirm",
      "--profile",
      profileName,
      "--token",
      confirmAction.confirmToken,
      "--yes"
    ]);
    expect(actionsConfirm.error).toBeUndefined();
    expect(actionsConfirm.exitCode).toBe(0);
    expect(getLastJsonObject(actionsConfirm.stdout)).toMatchObject({
      profile_name: profileName,
      actionType: "test.echo",
      result: {
        echo: expect.any(String)
      }
    });

    const confirmPost = prepareEchoAction(runtime, {
      profileName,
      summary: "CLI post.confirm echo"
    });
    const postConfirm = await runCliCommand([
      "post",
      "confirm",
      "--profile",
      profileName,
      "--token",
      confirmPost.confirmToken,
      "--yes"
    ]);
    expect(postConfirm.error).toBeUndefined();
    expect(postConfirm.exitCode).toBe(0);
    expect(getLastJsonObject(postConfirm.stdout)).toMatchObject({
      profile_name: profileName,
      actionType: "test.echo",
      result: {
        echo: expect.any(String)
      }
    });
  }, 180_000);

  it("covers connections, followups, and keepalive commands", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const fixtures = e2e.fixtures();

    const connectionsList = await runCliCommand([
      "connections",
      "list",
      "--profile",
      profileName,
      "--limit",
      "5"
    ]);
    expect(connectionsList.error).toBeUndefined();
    expect(getLastJsonObject(connectionsList.stdout)).toMatchObject({
      profile_name: profileName,
      count: expect.any(Number)
    });

    const pending = await runCliCommand([
      "connections",
      "pending",
      "--profile",
      profileName,
      "--filter",
      "all"
    ]);
    expect(pending.error).toBeUndefined();
    expect(getLastJsonObject(pending.stdout)).toMatchObject({
      profile_name: profileName,
      filter: "all"
    });

    for (const command of ["invite", "accept", "withdraw"] as const) {
      const prepared = await runCliCommand([
        "connections",
        command,
        fixtures.connectionTarget,
        "--profile",
        profileName
      ]);
      expect(prepared.error).toBeUndefined();
      expect(getLastJsonObject(prepared.stdout)).toMatchObject({
        profile_name: profileName,
        preparedActionId: expect.stringMatching(/^pa_/),
        confirmToken: expect.stringMatching(/^ct_/)
      });
    }

    const followupsList = await runCliCommand([
      "followups",
      "list",
      "--profile",
      profileName,
      "--since",
      "30d"
    ]);
    expect(followupsList.error).toBeUndefined();
    expect(getLastJsonObject(followupsList.stdout)).toMatchObject({
      profile_name: profileName,
      accepted_connections: expect.any(Array)
    });

    const followupsPrepare = await runCliCommand([
      "followups",
      "prepare",
      "--profile",
      profileName,
      "--since",
      "30d"
    ]);
    expect(followupsPrepare.error).toBeUndefined();
    expect(getLastJsonObject(followupsPrepare.stdout)).toMatchObject({
      profile_name: profileName,
      accepted_connections: expect.any(Array),
      prepared_followups: expect.any(Array)
    });

    const keepaliveProfile = `e2e-keepalive-${Date.now()}`;
    const keepaliveStart = await runCliCommand([
      "keepalive",
      "start",
      "--profile",
      keepaliveProfile,
      "--interval-seconds",
      "5",
      "--jitter-seconds",
      "0",
      "--max-consecutive-failures",
      "2"
    ]);
    expect(keepaliveStart.error).toBeUndefined();
    expect(getLastJsonObject(keepaliveStart.stdout)).toMatchObject({
      started: true,
      profile_name: keepaliveProfile,
      pid: expect.any(Number)
    });

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const keepaliveStatus = await runCliCommand([
      "keepalive",
      "status",
      "--profile",
      keepaliveProfile
    ]);
    expect(keepaliveStatus.error).toBeUndefined();
    expect(getLastJsonObject(keepaliveStatus.stdout)).toMatchObject({
      profile_name: keepaliveProfile,
      running: expect.any(Boolean)
    });

    const keepaliveStop = await runCliCommand([
      "keepalive",
      "stop",
      "--profile",
      keepaliveProfile
    ]);
    expect(keepaliveStop.error).toBeUndefined();
    expect(getLastJsonObject(keepaliveStop.stdout)).toMatchObject({
      stopped: true,
      profile_name: keepaliveProfile
    });
  }, 180_000);

  it("covers feed, post, profile, search, jobs, and notifications commands", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const fixtures = e2e.fixtures();

    const feedList = await runCliCommand([
      "feed",
      "list",
      "--profile",
      profileName,
      "--limit",
      "5"
    ]);
    expect(feedList.error).toBeUndefined();
    expect(getLastJsonObject(feedList.stdout)).toMatchObject({
      profile_name: profileName,
      posts: expect.any(Array)
    });

    const feedView = await runCliCommand([
      "feed",
      "view",
      fixtures.postUrl,
      "--profile",
      profileName
    ]);
    expect(feedView.error).toBeUndefined();
    expect(getLastJsonObject(feedView.stdout)).toMatchObject({
      profile_name: profileName,
      post: {
        post_url: fixtures.postUrl
      }
    });

    const feedLike = await runCliCommand([
      "feed",
      "like",
      fixtures.postUrl,
      "--profile",
      profileName,
      "--reaction",
      "like"
    ]);
    expect(feedLike.error).toBeUndefined();
    expect(getLastJsonObject(feedLike.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const feedComment = await runCliCommand([
      "feed",
      "comment",
      fixtures.postUrl,
      "--profile",
      profileName,
      "--text",
      `CLI preview comment [${Date.now()}]`
    ]);
    expect(feedComment.error).toBeUndefined();
    expect(getLastJsonObject(feedComment.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const postPrepare = await runCliCommand([
      "post",
      "prepare",
      "--profile",
      profileName,
      "--text",
      `CLI preview post [${Date.now()}]`
    ]);
    expect(postPrepare.error).toBeUndefined();
    expect(getLastJsonObject(postPrepare.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });

    const profileView = await runCliCommand([
      "profile",
      "view",
      getDefaultConnectionTarget(),
      "--profile",
      profileName
    ]);
    expect(profileView.error).toBeUndefined();
    expect(getLastJsonObject(profileView.stdout)).toMatchObject({
      profile_name: profileName,
      profile: {
        profile_url: expect.stringContaining("linkedin.com")
      }
    });

    const search = await runCliCommand([
      "search",
      "Simon Miller",
      "--profile",
      profileName,
      "--category",
      "people",
      "--limit",
      "5"
    ]);
    expect(search.error).toBeUndefined();
    expect(getLastJsonObject(search.stdout)).toMatchObject({
      profile_name: profileName,
      category: "people",
      results: expect.any(Array)
    });

    const jobsSearch = await runCliCommand([
      "jobs",
      "search",
      "software engineer",
      "--profile",
      profileName,
      "--location",
      "Copenhagen",
      "--limit",
      "5"
    ]);
    expect(jobsSearch.error).toBeUndefined();
    expect(getLastJsonObject(jobsSearch.stdout)).toMatchObject({
      profile_name: profileName,
      results: expect.any(Array)
    });

    const jobsView = await runCliCommand([
      "jobs",
      "view",
      fixtures.jobId,
      "--profile",
      profileName
    ]);
    expect(jobsView.error).toBeUndefined();
    expect(getLastJsonObject(jobsView.stdout)).toMatchObject({
      profile_name: profileName,
      job: {
        job_id: fixtures.jobId
      }
    });

    const notifications = await runCliCommand([
      "notifications",
      "list",
      "--profile",
      profileName,
      "--limit",
      "5"
    ]);
    expect(notifications.error).toBeUndefined();
    expect(getLastJsonObject(notifications.stdout)).toMatchObject({
      profile_name: profileName,
      notifications: expect.any(Array)
    });
  }, 240_000);
});
