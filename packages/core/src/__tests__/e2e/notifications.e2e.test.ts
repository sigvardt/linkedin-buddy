import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Notifications E2E", () => {
  let cdpOk = false;
  let authOk = false;

  beforeAll(async () => {
    cdpOk = await checkCdpAvailable();
    if (cdpOk) {
      authOk = await checkAuthenticated();
    }
  });

  afterAll(() => {
    cleanupRuntime();
  });

  it("list notifications does not error, returns array", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const notifications = await runtime.notifications.listNotifications({ limit: 5 });

    expect(Array.isArray(notifications)).toBe(true);
  });
});
