import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Profile E2E", () => {
  const e2e = setupE2ESuite();

  it("view own profile (me) returns full_name, headline, profile_url", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const profile = await runtime.profile.viewProfile({ target: "me" });

    expect(profile.full_name.length).toBeGreaterThan(0);
    expect(typeof profile.headline).toBe("string");
    expect(profile.profile_url).toContain("linkedin.com/in/");
  });

  it("view target profile (realsimonmiller) returns structured data", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const profile = await runtime.profile.viewProfile({ target: "realsimonmiller" });

    expect(typeof profile.full_name).toBe("string");
    expect(typeof profile.headline).toBe("string");
    expect(profile.profile_url).toContain("linkedin.com/in/");
    expect(Array.isArray(profile.experience)).toBe(true);
    expect(Array.isArray(profile.education)).toBe(true);
  });
});
