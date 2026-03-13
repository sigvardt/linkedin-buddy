import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ACTIVITY_WATCH_KINDS } from "../../activityTypes.js";
import { LinkedInBuddyError } from "../../errors.js";
import {
  callMcpTool,
  getDefaultProfileName,
  getLastJsonObject,
  MCP_TOOL_NAMES,
  runCliCommand
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

async function createWebhookTestServer(): Promise<{
  url: string;
  receivedRequests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;
  close: () => Promise<void>;
}> {
  const receivedRequests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      receivedRequests.push({
        headers: req.headers,
        body
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/hooks`,
    receivedRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

describe.sequential("Activity Watch CRUD E2E - service layer", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("creates a notifications watch and verifies structure", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const watch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });

    try {
      expect(watch).toMatchObject({
        id: expect.stringMatching(/^watch_/),
        profileName,
        kind: "notifications",
        status: "active",
        scheduleKind: "interval"
      });
      expect(typeof watch.pollIntervalMs === "number" || watch.pollIntervalMs === null).toBe(
        true
      );
    } finally {
      runtime.activityWatches.removeWatch(watch.id);
    }
  }, 60_000);

  it("creates all watch kinds and lists them", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const createdIds: string[] = [];

    try {
      for (const kind of ACTIVITY_WATCH_KINDS) {
        const watch = runtime.activityWatches.createWatch({
          kind,
          profileName,
          ...(kind === "profile_watch"
            ? { target: { target: "https://www.linkedin.com/in/realsimonmiller/" } }
            : {})
        });
        createdIds.push(watch.id);
      }

      const listed = runtime.activityWatches.listWatches({ profileName });
      const listedIds = new Set(listed.map((watch) => watch.id));
      expect(createdIds.every((id) => listedIds.has(id))).toBe(true);
      expect(listed.length).toBeGreaterThanOrEqual(createdIds.length);
    } finally {
      for (const id of createdIds) {
        runtime.activityWatches.removeWatch(id);
      }
    }
  }, 60_000);

  it("pauses and resumes a watch", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const watch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });

    try {
      const paused = runtime.activityWatches.pauseWatch(watch.id);
      expect(paused.status).toBe("paused");

      const resumed = runtime.activityWatches.resumeWatch(watch.id);
      expect(resumed.status).toBe("active");
    } finally {
      runtime.activityWatches.removeWatch(watch.id);
    }
  }, 60_000);

  it("removes a watch and verifies deletion", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const watch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });

    expect(runtime.activityWatches.removeWatch(watch.id)).toBe(true);
    const remaining = runtime.activityWatches.listWatches({ profileName });
    expect(remaining.some((entry) => entry.id === watch.id)).toBe(false);
  }, 60_000);

  it("rejects invalid watch kind with LinkedInBuddyError", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const invalidInput = {
      profileName,
      kind: "nonexistent_kind"
    } as unknown as Parameters<typeof runtime.activityWatches.createWatch>[0];

    expect(() => runtime.activityWatches.createWatch(invalidInput)).toThrow(
      LinkedInBuddyError
    );
  }, 60_000);

  it("creates a cron-scheduled watch", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const watch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName,
      cron: "*/10 * * * *"
    });

    try {
      expect(watch).toMatchObject({
        id: expect.stringMatching(/^watch_/),
        profileName,
        kind: "notifications",
        status: "active",
        scheduleKind: "cron",
        cronExpression: "*/10 * * * *"
      });
    } finally {
      runtime.activityWatches.removeWatch(watch.id);
    }
  }, 60_000);
});

describe.sequential("Activity Webhook CRUD E2E - service layer", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("creates a webhook subscription with signing secret", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const watch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });

    const subscription = runtime.activityWatches.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: "http://127.0.0.1:18999/hooks"
    });

    try {
      expect(subscription).toMatchObject({
        id: expect.stringMatching(/^whsub_/),
        watchId: watch.id,
        status: "active",
        deliveryUrl: "http://127.0.0.1:18999/hooks"
      });
      expect(subscription.signingSecret.startsWith("whsec_")).toBe(true);
    } finally {
      runtime.activityWatches.removeWebhookSubscription(subscription.id);
      runtime.activityWatches.removeWatch(watch.id);
    }
  }, 60_000);

  it("lists, pauses, resumes, and removes a subscription", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const watch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });
    const subscription = runtime.activityWatches.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: "http://127.0.0.1:18998/hooks"
    });

    try {
      const listed = runtime.activityWatches.listWebhookSubscriptions({
        profileName,
        watchId: watch.id
      });
      expect(listed.some((entry) => entry.id === subscription.id)).toBe(true);

      const paused = runtime.activityWatches.pauseWebhookSubscription(subscription.id);
      expect(paused.status).toBe("paused");

      const resumed = runtime.activityWatches.resumeWebhookSubscription(subscription.id);
      expect(resumed.status).toBe("active");

      expect(runtime.activityWatches.removeWebhookSubscription(subscription.id)).toBe(true);
      const afterRemove = runtime.activityWatches.listWebhookSubscriptions({
        profileName,
        watchId: watch.id
      });
      expect(afterRemove.some((entry) => entry.id === subscription.id)).toBe(false);
    } finally {
      runtime.activityWatches.removeWatch(watch.id);
    }
  }, 60_000);

  it("rejects webhook for nonexistent watch", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() =>
      runtime.activityWatches.createWebhookSubscription({
        watchId: "watch_nonexistent",
        deliveryUrl: "http://127.0.0.1:18997/hooks"
      })
    ).toThrow(LinkedInBuddyError);
  }, 60_000);
});

describe.sequential("Activity Events & Deliveries E2E - service layer", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("lists events for a profile (initially empty)", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const uniqueWatch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });

    try {
      const events = runtime.activityWatches.listEvents({ watchId: uniqueWatch.id });
      expect(events).toEqual([]);
    } finally {
      runtime.activityWatches.removeWatch(uniqueWatch.id);
    }
  }, 60_000);

  it("lists deliveries for a profile (initially empty)", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const uniqueWatch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });

    try {
      const deliveries = runtime.activityWatches.listDeliveries({
        watchId: uniqueWatch.id
      });
      expect(deliveries).toEqual([]);
    } finally {
      runtime.activityWatches.removeWatch(uniqueWatch.id);
    }
  }, 60_000);
});

describe.sequential("Activity Polling E2E", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("creates a watch, configures webhook, and executes a polling tick", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const watch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });

    const webhookServer = await createWebhookTestServer();
    const subscription = runtime.activityWatches.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: webhookServer.url,
      signingSecret: "whsec_test_e2e_secret"
    });

    try {
      const result = await runtime.activityPoller.runTick({ profileName });

      expect(result).toMatchObject({
        profileName,
        polledWatches: expect.any(Number),
        emittedEvents: expect.any(Number),
        failedWatches: expect.any(Number)
      });

      if (result.emittedEvents > 0) {
        const events = runtime.activityWatches.listEvents({ watchId: watch.id });
        expect(events.length).toBeGreaterThan(0);

        const deliveries = runtime.activityWatches.listDeliveries({ watchId: watch.id });
        expect(deliveries.length).toBeGreaterThan(0);

        await new Promise((resolve) => {
          setTimeout(resolve, 3_000);
        });

        if (webhookServer.receivedRequests.length > 0) {
          const request = webhookServer.receivedRequests[0]!;
          expect(request.headers["x-linkedin-buddy-signature-256"]).toBeDefined();
          expect(request.headers["x-linkedin-buddy-event"]).toBeDefined();
        }
      }
    } finally {
      runtime.activityWatches.removeWebhookSubscription(subscription.id);
      runtime.activityWatches.removeWatch(watch.id);
      await webhookServer.close();
    }
  }, 120_000);
});

describe.sequential("Activity Watch CLI E2E", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("covers full watch lifecycle via CLI", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const add = await runCliCommand([
      "activity",
      "watch",
      "add",
      "--kind",
      "notifications",
      "--profile",
      profileName,
      "--json"
    ]);
    expect(add.error).toBeUndefined();
    expect(add.exitCode).toBe(0);
    const addPayload = getLastJsonObject(add.stdout);
    expect(addPayload).toMatchObject({
      profile_name: profileName,
      watch: {
        kind: "notifications",
        status: "active"
      }
    });

    const watchId = (addPayload.watch as Record<string, unknown>).id as string;

    try {
      const list = await runCliCommand([
        "activity",
        "watch",
        "list",
        "--profile",
        profileName,
        "--json"
      ]);
      expect(list.exitCode).toBe(0);
      expect(getLastJsonObject(list.stdout)).toMatchObject({
        profile_name: profileName,
        count: expect.any(Number)
      });

      const pause = await runCliCommand([
        "activity",
        "watch",
        "pause",
        watchId,
        "--json"
      ]);
      expect(pause.exitCode).toBe(0);
      expect(getLastJsonObject(pause.stdout)).toMatchObject({
        watch: { status: "paused" }
      });

      const resume = await runCliCommand([
        "activity",
        "watch",
        "resume",
        watchId,
        "--json"
      ]);
      expect(resume.exitCode).toBe(0);
      expect(getLastJsonObject(resume.stdout)).toMatchObject({
        watch: { status: "active" }
      });
    } finally {
      const remove = await runCliCommand([
        "activity",
        "watch",
        "remove",
        watchId,
        "--json"
      ]);
      expect(remove.exitCode).toBe(0);
      expect(getLastJsonObject(remove.stdout)).toMatchObject({ removed: true });
    }
  }, 120_000);

  it("CLI rejects invalid watch kind", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "activity",
      "watch",
      "add",
      "--kind",
      "nonexistent_kind",
      "--profile",
      profileName,
      "--json"
    ]);

    expect(result.exitCode).toBe(1);
  }, 60_000);
});

describe.sequential("Activity Webhook CLI E2E", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("covers full webhook lifecycle via CLI", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const watchAdd = await runCliCommand([
      "activity",
      "watch",
      "add",
      "--kind",
      "notifications",
      "--profile",
      profileName,
      "--json"
    ]);
    expect(watchAdd.exitCode).toBe(0);
    const watchPayload = getLastJsonObject(watchAdd.stdout);
    const watchId = (watchPayload.watch as Record<string, unknown>).id as string;

    const add = await runCliCommand([
      "activity",
      "webhook",
      "add",
      "--watch",
      watchId,
      "--url",
      "http://127.0.0.1:18996/hooks",
      "--json"
    ]);
    expect(add.exitCode).toBe(0);
    const addPayload = getLastJsonObject(add.stdout);
    const subscription = addPayload.subscription as Record<string, unknown>;
    const subscriptionId = subscription.id as string;

    try {
      expect(addPayload).toMatchObject({
        subscription: {
          id: expect.stringMatching(/^whsub_/),
          watchId,
          status: "active"
        }
      });
      expect(typeof subscription.signingSecret).toBe("string");

      const list = await runCliCommand([
        "activity",
        "webhook",
        "list",
        "--profile",
        profileName,
        "--watch",
        watchId,
        "--json"
      ]);
      expect(list.exitCode).toBe(0);
      expect(getLastJsonObject(list.stdout)).toMatchObject({
        profile_name: profileName,
        count: expect.any(Number)
      });

      const pause = await runCliCommand([
        "activity",
        "webhook",
        "pause",
        subscriptionId,
        "--json"
      ]);
      expect(pause.exitCode).toBe(0);
      expect(getLastJsonObject(pause.stdout)).toMatchObject({
        subscription: { status: "paused" }
      });

      const resume = await runCliCommand([
        "activity",
        "webhook",
        "resume",
        subscriptionId,
        "--json"
      ]);
      expect(resume.exitCode).toBe(0);
      expect(getLastJsonObject(resume.stdout)).toMatchObject({
        subscription: { status: "active" }
      });
    } finally {
      const removeWebhook = await runCliCommand([
        "activity",
        "webhook",
        "remove",
        subscriptionId,
        "--json"
      ]);
      expect(removeWebhook.exitCode).toBe(0);
      expect(getLastJsonObject(removeWebhook.stdout)).toMatchObject({
        removed: true
      });

      const removeWatch = await runCliCommand([
        "activity",
        "watch",
        "remove",
        watchId,
        "--json"
      ]);
      expect(removeWatch.exitCode).toBe(0);
      expect(getLastJsonObject(removeWatch.stdout)).toMatchObject({ removed: true });
    }
  }, 120_000);
});

describe.sequential("Activity Watch MCP E2E", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("covers full watch lifecycle via MCP tools", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const create = await callMcpTool(MCP_TOOL_NAMES.activityWatchCreate, {
      profileName,
      kind: "notifications"
    });
    expect(create.isError).toBe(false);
    expect(create.payload).toMatchObject({
      profile_name: profileName,
      watch: {
        id: expect.stringMatching(/^watch_/),
        kind: "notifications",
        status: "active"
      }
    });

    const watchId = (create.payload.watch as Record<string, unknown>).id as string;

    try {
      const list = await callMcpTool(MCP_TOOL_NAMES.activityWatchList, {
        profileName
      });
      expect(list.isError).toBe(false);
      expect(list.payload).toMatchObject({
        profile_name: profileName,
        count: expect.any(Number)
      });

      const pause = await callMcpTool(MCP_TOOL_NAMES.activityWatchPause, {
        watchId
      });
      expect(pause.isError).toBe(false);
      expect(pause.payload).toMatchObject({ watch: { status: "paused" } });

      const resume = await callMcpTool(MCP_TOOL_NAMES.activityWatchResume, {
        watchId
      });
      expect(resume.isError).toBe(false);
      expect(resume.payload).toMatchObject({ watch: { status: "active" } });
    } finally {
      const remove = await callMcpTool(MCP_TOOL_NAMES.activityWatchRemove, {
        watchId
      });
      expect(remove.isError).toBe(false);
      expect(remove.payload).toMatchObject({ removed: true });
    }
  }, 120_000);
});

describe.sequential("Activity Webhook MCP E2E", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("covers full webhook lifecycle via MCP tools", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const watchCreate = await callMcpTool(MCP_TOOL_NAMES.activityWatchCreate, {
      profileName,
      kind: "notifications"
    });
    expect(watchCreate.isError).toBe(false);
    const watchId = (watchCreate.payload.watch as Record<string, unknown>).id as string;

    const create = await callMcpTool(MCP_TOOL_NAMES.activityWebhookCreate, {
      watchId,
      deliveryUrl: "http://127.0.0.1:18995/hooks"
    });
    expect(create.isError).toBe(false);
    expect(create.payload).toMatchObject({
      subscription: {
        id: expect.stringMatching(/^whsub_/),
        watchId,
        status: "active"
      }
    });
    const subscriptionId = (create.payload.subscription as Record<string, unknown>)
      .id as string;

    try {
      const list = await callMcpTool(MCP_TOOL_NAMES.activityWebhookList, {
        profileName,
        watchId
      });
      expect(list.isError).toBe(false);
      expect(list.payload).toMatchObject({
        profile_name: profileName,
        count: expect.any(Number)
      });

      const pause = await callMcpTool(MCP_TOOL_NAMES.activityWebhookPause, {
        subscriptionId
      });
      expect(pause.isError).toBe(false);
      expect(pause.payload).toMatchObject({ subscription: { status: "paused" } });

      const resume = await callMcpTool(MCP_TOOL_NAMES.activityWebhookResume, {
        subscriptionId
      });
      expect(resume.isError).toBe(false);
      expect(resume.payload).toMatchObject({ subscription: { status: "active" } });
    } finally {
      const removeWebhook = await callMcpTool(MCP_TOOL_NAMES.activityWebhookRemove, {
        subscriptionId
      });
      expect(removeWebhook.isError).toBe(false);
      expect(removeWebhook.payload).toMatchObject({ removed: true });

      const removeWatch = await callMcpTool(MCP_TOOL_NAMES.activityWatchRemove, {
        watchId
      });
      expect(removeWatch.isError).toBe(false);
      expect(removeWatch.payload).toMatchObject({ removed: true });
    }
  }, 120_000);
});

describe.sequential("Activity Events/Deliveries CLI and MCP E2E", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("lists events and deliveries through CLI and MCP after run-once", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const watch = runtime.activityWatches.createWatch({
      kind: "notifications",
      profileName
    });
    const subscription = runtime.activityWatches.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: "http://127.0.0.1:18994/hooks"
    });

    try {
      const runOnceCli = await runCliCommand([
        "activity",
        "run-once",
        "--profile",
        profileName,
        "--json"
      ]);
      expect(runOnceCli.exitCode).toBe(0);
      expect(getLastJsonObject(runOnceCli.stdout)).toMatchObject({
        profile_name: profileName,
        polledWatches: expect.any(Number),
        emittedEvents: expect.any(Number)
      });

      const eventsCli = await runCliCommand([
        "activity",
        "events",
        "--profile",
        profileName,
        "--watch",
        watch.id,
        "--json"
      ]);
      expect(eventsCli.exitCode).toBe(0);
      expect(getLastJsonObject(eventsCli.stdout)).toMatchObject({
        profile_name: profileName,
        count: expect.any(Number),
        events: expect.any(Array)
      });

      const deliveriesCli = await runCliCommand([
        "activity",
        "deliveries",
        "--profile",
        profileName,
        "--watch",
        watch.id,
        "--subscription",
        subscription.id,
        "--json"
      ]);
      expect(deliveriesCli.exitCode).toBe(0);
      expect(getLastJsonObject(deliveriesCli.stdout)).toMatchObject({
        profile_name: profileName,
        count: expect.any(Number),
        deliveries: expect.any(Array)
      });

      const runOnceMcp = await callMcpTool(MCP_TOOL_NAMES.activityPollerRunOnce, {
        profileName
      });
      expect(runOnceMcp.isError).toBe(false);
      expect(runOnceMcp.payload).toMatchObject({
        profile_name: profileName,
        result: {
          polledWatches: expect.any(Number),
          emittedEvents: expect.any(Number)
        }
      });

      const eventsMcp = await callMcpTool(MCP_TOOL_NAMES.activityEventsList, {
        profileName,
        watchId: watch.id,
        limit: 20
      });
      expect(eventsMcp.isError).toBe(false);
      expect(eventsMcp.payload).toMatchObject({
        profile_name: profileName,
        count: expect.any(Number),
        events: expect.any(Array)
      });

      const deliveriesMcp = await callMcpTool(MCP_TOOL_NAMES.activityDeliveriesList, {
        profileName,
        watchId: watch.id,
        subscriptionId: subscription.id,
        limit: 20
      });
      expect(deliveriesMcp.isError).toBe(false);
      expect(deliveriesMcp.payload).toMatchObject({
        profile_name: profileName,
        count: expect.any(Number),
        deliveries: expect.any(Array)
      });
    } finally {
      runtime.activityWatches.removeWebhookSubscription(subscription.id);
      runtime.activityWatches.removeWatch(watch.id);
    }
  }, 120_000);
});
