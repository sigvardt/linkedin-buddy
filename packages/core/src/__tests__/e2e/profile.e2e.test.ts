import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Profile E2E", () => {
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

  it("view own profile (me) returns full_name, headline, profile_url", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const profile = await runtime.profile.viewProfile({ target: "me" });

    expect(profile.full_name.length).toBeGreaterThan(0);
    expect(typeof profile.headline).toBe("string");
    expect(profile.profile_url).toContain("linkedin.com/in/");
  });

  it("view target profile (realsimonmiller) returns structured data", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const profile = await runtime.profile.viewProfile({ target: "realsimonmiller" });

    expect(typeof profile.full_name).toBe("string");
    expect(typeof profile.headline).toBe("string");
    expect(profile.profile_url).toContain("linkedin.com/in/");
    expect(Array.isArray(profile.experience)).toBe(true);
    expect(Array.isArray(profile.education)).toBe(true);
  });
});
